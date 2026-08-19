//! Installer-resource P2P (BitTorrent) hybrid download + seeding.
//!
//! The music-sharing P2pDownloader (share/p2p.rs) is bound to the songs
//! cache and hard-codes .a00m/.flac — resources live next to the exe and
//! are .zip, so this is a second, independent fx-torrent session
//! (fx-torrent has no global state; each session binds its own temp
//! ports — see reference notes).
//!
//! Strategy (install_resource in resource_manager.rs):
//! - manifest entry has a magnet → P2P download races against the HTTP
//!   multi-source download; whoever finishes first wins.
//! - HTTP wins → after install, the zip is copied into `.p2p-resources/`
//!   and re-added in SeedMode so this client seeds it.
//! - P2P wins → the torrent stays in Seeding (fx-torrent does that
//!   automatically on completion) and the file is installed from the
//!   seeding directory.
//!
//! Gated by GlobalConfig acestep.p2p.enabled + seed_resources (both
//! default true). Tracker discovery comes from the magnet `tr=` param
//! (the user's self-hosted ai00-salvo tracker).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use fx_callback::Callback;
use fx_torrent::{
    FxTorrentSession, Session, SessionConfig, TorrentEvent, TorrentFlags, TorrentMetadata,
    TorrentState,
};
use tokio::sync::Mutex;

pub struct ResourceP2p {
    session: Arc<FxTorrentSession>,
    /// exe_dir/.p2p-resources — both download target and seed source.
    dir: PathBuf,
    /// file_name → (downloaded, total) for overall progress aggregation.
    progress: Arc<Mutex<HashMap<String, (u64, u64)>>>,
}

static INSTANCE: OnceLock<ResourceP2p> = OnceLock::new();

/// Initialize the resource P2P session (called from app_state). Failure is
/// non-fatal — resource downloads silently fall back to HTTP-only.
pub async fn init(dir: PathBuf, upload_slots: usize) -> Result<(), String> {
    // DHT bootstrap as tracker-independent peer discovery fallback.
    let dht = fx_torrent::dht::DhtTracker::builder()
        .default_routing_nodes()
        .build()
        .await
        .map_err(|e| format!("resource p2p dht init failed: {e:?}"))?;

    let session = FxTorrentSession::builder()
        .config(
            SessionConfig::builder()
                .path(&dir)
                .client_name("Ai00-X-Resources")
                .peers_upload_slots(upload_slots.max(1))
                .build(),
        )
        .dht(dht)
        .default_extensions()
        .build()
        .map_err(|e| format!("resource p2p session init failed: {e:?}"))?;

    let _ = INSTANCE.set(ResourceP2p {
        session: Arc::new(session),
        dir: dir.clone(),
        progress: Arc::new(Mutex::new(HashMap::new())),
    });
    log::info!("[resource_p2p] session ready at {}", dir.display());
    Ok(())
}

pub fn get() -> Option<&'static ResourceP2p> {
    INSTANCE.get()
}

impl ResourceP2p {
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Live (downloaded, total) snapshot for overall progress merging.
    pub async fn progress_snapshot(&self) -> HashMap<String, (u64, u64)> {
        self.progress.lock().await.clone()
    }

    /// Download one resource via its magnet, updating the shared progress
    /// map. Returns the completed file path inside the seeding dir.
    /// On timeout/error/cancel the torrent is removed and Err is returned
    /// (the caller then relies on the HTTP lane).
    ///
    /// `stop`: when it flips to true (the HTTP lane won the race) the
    /// torrent is cleaned up and Err("cancelled") is returned.
    pub async fn download(
        &self,
        magnet: &str,
        file_name: &str,
        timeout: Duration,
        mut stop: tokio::sync::watch::Receiver<bool>,
    ) -> Result<PathBuf> {
        let _ = tokio::fs::create_dir_all(&self.dir).await;

        let torrent = self
            .session
            .add_torrent_from_uri(magnet, TorrentFlags::default())
            .await
            .map_err(|e| anyhow::anyhow!("add_torrent_from_uri: {e:?}"))?;

        // Fast path: the file may already be fully present (previous run /
        // seed-from-http copy) — fx-torrent hash-checks and jumps to Seeding.
        let mut rx = torrent.subscribe();
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.tick().await; // consume immediate first tick

        let result = tokio::time::timeout(timeout, async {
            loop {
                if *stop.borrow() {
                    anyhow::bail!("cancelled");
                }
                // publish progress into the shared map
                let (done, total) = {
                    let m = torrent.metrics();
                    (m.wanted_completed_size.get(), m.wanted_size.get())
                };
                self.progress
                    .lock()
                    .await
                    .insert(file_name.to_string(), (done, total));

                match torrent.state().await {
                    TorrentState::Finished | TorrentState::Seeding => return Ok(()),
                    TorrentState::Error => anyhow::bail!("torrent error state"),
                    _ => {}
                }
                tokio::select! {
                    biased;
                    _ = stop.changed() => {
                        if *stop.borrow() {
                            anyhow::bail!("cancelled");
                        }
                    }
                    ev = rx.recv() => {
                        match ev {
                            Ok(ev) => {
                                if let TorrentEvent::StateChanged(TorrentState::Error) = &*ev {
                                    anyhow::bail!("torrent error state");
                                }
                            }
                            Err(e) => anyhow::bail!("event channel closed: {e}"),
                        }
                    }
                    _ = ticker.tick() => {}
                }
            }
        })
        .await;

        match result {
            Ok(Ok(())) => {
                self.progress.lock().await.remove(file_name);
                let path = self.dir.join(file_name);
                log::info!("[resource_p2p] completed: {}", path.display());
                Ok(path)
            }
            outcome => {
                self.progress.lock().await.remove(file_name);
                // best-effort cleanup so a retry can start fresh
                self.session.remove_torrent(&torrent.handle()).await;
                Err(anyhow::anyhow!("resource p2p download failed: {outcome:?}"))
            }
        }
    }

    /// Seed an already-downloaded zip (HTTP lane won): copy it into the
    /// seeding dir and add the torrent in SeedMode. The torrent metadata is
    /// rebuilt from the magnet's info-hash requires metadata we don't have,
    /// so callers pass the raw .torrent bytes when available; when only the
    /// magnet is known we skip seeding (fx-torrent needs full metadata to
    /// seed — magnets alone cannot bootstrap a seed).
    pub async fn seed_from_torrent_bytes(
        &self,
        torrent_bytes: &[u8],
        file_name: &str,
        zip_path: &Path,
    ) -> Result<()> {
        // Place the data file where the session expects it (torrent name).
        let target = self.dir.join(file_name);
        if !target.exists() {
            tokio::fs::copy(zip_path, &target)
                .await
                .with_context(|| format!("copy {} -> {}", zip_path.display(), target.display()))?;
        }
        let meta = TorrentMetadata::try_from(torrent_bytes)
            .with_context(|| format!("parse torrent metadata for {file_name}"))?;
        self.session
            .add_torrent_from_info(meta, TorrentFlags::SeedMode)
            .await
            .with_context(|| format!("add SeedMode torrent {file_name}"))?;
        log::info!("[resource_p2p] seeding {}", file_name);
        Ok(())
    }

    /// Whether a seeding file exists locally (skip re-download on reinstall).
    pub fn seeded_file(&self, file_name: &str) -> Option<PathBuf> {
        let p = self.dir.join(file_name);
        p.is_file().then_some(p)
    }
}
