//! Background polling collector with a minimal state machine.
//!
//! State machine: `Idle <-> Active { is_afk }`. The collector polls the
//! platform detector every `POLL_INTERVAL_SECS`. A segment is flushed and a
//! new one started whenever the foreground app changes OR the AFK status
//! flips (user went idle / resumed). The in-flight segment is sealed and the
//! session ended on shutdown.
//!
//! AFK detection: when `idle_secs >= AFK_THRESHOLD_SECS` (Windows via
//! `GetLastInputInfo`), the current segment is marked `is_afk = true`.
//! Platforms without idle detection (macOS/Linux Phase 2) never produce AFK
//! segments.
//!
//! Design follows Patina's tracking engine pattern but adapted to Tokio +
//! `spawn_blocking` (the Windows detector uses blocking Win32 calls and the
//! macOS detector shells out to `osascript`).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use tokio::sync::{broadcast, Mutex};
use tokio::time::interval;

use crate::usage_stats::platform::{default_detector, ForegroundApp, ForegroundDetector};
use crate::usage_stats::storage::{ActivitySegment, UsageStatsStore};

// Icon extraction is currently Windows-only. macOS/Linux Phase 2.
#[cfg(target_os = "windows")]
use crate::usage_stats::platform::windows::icon::get_icon_base64;

/// Polling interval (seconds). Patina default is 5s.
const POLL_INTERVAL_SECS: u64 = 5;

/// User is considered AFK after this many seconds of no input.
/// Patina default is 5 minutes (300s).
const AFK_THRESHOLD_SECS: u64 = 300;

/// Collector state. `Active` carries the current segment's AFK flag so that
/// AFK<->active transitions flush and start a new segment.
#[derive(Debug)]
enum CollectorState {
    /// No foreground app currently tracked.
    Idle,
    /// Tracking a foreground app since `segment_start`. `is_afk` reflects
    /// whether the user was AFK when this segment started.
    Active {
        app: ForegroundApp,
        segment_start: DateTime<Utc>,
        is_afk: bool,
    },
    /// Shutting down — no more polling.
    Stopped,
}

/// Background usage-stats collector.
///
/// Construct with [`UsageStatsCollector::new`], then call
/// `tokio::spawn(collector.clone().run())` to start the polling loop. Send
/// a `()` on the shutdown channel (see [`UsageStatsCollector::shutdown_handle`])
/// to gracefully stop and seal the in-flight segment.
pub struct UsageStatsCollector {
    detector: Arc<dyn ForegroundDetector>,
    store: UsageStatsStore,
    session_id: String,
    state: Mutex<CollectorState>,
    shutdown_tx: broadcast::Sender<()>,
}

impl UsageStatsCollector {
    /// Create a new collector. Opens (or reuses) a usage session row and
    /// returns a collector ready to be `run()`.
    pub fn new(store: UsageStatsStore) -> Result<Self> {
        let detector = default_detector();
        let session_id = store.start_session().context("start_session")?;
        let (shutdown_tx, _) = broadcast::channel::<()>(1);
        log::info!("usage_stats: collector created (session_id={})", session_id);
        Ok(Self {
            detector,
            store,
            session_id,
            state: Mutex::new(CollectorState::Idle),
            shutdown_tx,
        })
    }

    /// Return a clone of the shutdown sender. Dropping or sending `()` on
    /// this channel stops the collector's `run` loop.
    pub fn shutdown_handle(&self) -> broadcast::Sender<()> {
        self.shutdown_tx.clone()
    }

    /// Main polling loop. Returns when the shutdown signal is received or
    /// the runtime is shutting down. Always seals the in-flight segment
    /// and ends the session before returning.
    pub async fn run(self: Arc<Self>) {
        let mut tick = interval(Duration::from_secs(POLL_INTERVAL_SECS));
        let mut shutdown_rx = self.shutdown_tx.subscribe();

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    log::debug!("usage_stats: shutdown signal received");
                    break;
                }
                _ = tick.tick() => {
                    if let Err(e) = self.poll_once().await {
                        log::warn!("usage_stats: poll error: {}", e);
                    }
                }
            }
        }

        // Seal the in-flight segment (if any) and end the session.
        self.flush_current().await;
        if let Err(e) = self.store.end_session(&self.session_id, "app_exit") {
            log::warn!("usage_stats: end_session error: {}", e);
        } else {
            log::info!("usage_stats: session {} ended", self.session_id);
        }
    }

    /// One polling tick: detect foreground, transition state, flush on change.
    async fn poll_once(&self) -> Result<()> {
        // Platform detector may block (Win32 calls, osascript) — run on a
        // blocking thread to avoid stalling the Tokio runtime.
        let detector = self.detector.clone();
        let app = tokio::task::spawn_blocking(move || detector.detect_foreground())
            .await
            .context("spawn_blocking join")?;

        // Best-effort app_rule upsert so user can rename/categorize later.
        // Also triggers one-shot icon extraction (Windows only) when the rule
        // has no icon yet — subsequent polls see `icon = Some(...)` and skip.
        if let Some(a) = &app {
            let exe_path = a.exe_path.as_deref().unwrap_or("");
            match self.store.ensure_app_rule(exe_path, &a.process_name) {
                Ok(rule) => {
                    if rule.icon.is_none() && !exe_path.is_empty() {
                        self.maybe_extract_icon(exe_path);
                    }
                }
                Err(e) => {
                    log::debug!("usage_stats: ensure_app_rule error (non-fatal): {}", e);
                }
            }
        }

        // Determine AFK status for this poll. `None` idle_secs (macOS/Linux)
        // means AFK detection unavailable — treat as not-AFK.
        let now_afk = app
            .as_ref()
            .and_then(|a| a.idle_secs)
            .is_some_and(|s| s >= AFK_THRESHOLD_SECS);

        let mut state = self.state.lock().await;
        match (&*state, app) {
            (CollectorState::Stopped, _) => Ok(()),

            // Idle -> Idle (still no foreground): nothing to do.
            (CollectorState::Idle, None) => Ok(()),

            // Idle -> Active: start new segment (with current AFK status).
            (CollectorState::Idle, Some(new_app)) => {
                log::debug!(
                    "usage_stats: foreground start -> {} (afk={})",
                    new_app.process_name,
                    now_afk
                );
                *state = CollectorState::Active {
                    app: new_app,
                    segment_start: Utc::now(),
                    is_afk: now_afk,
                };
                Ok(())
            }

            // Active -> Active (same app, same AFK status): no-op.
            (
                CollectorState::Active {
                    app: cur,
                    is_afk: cur_afk,
                    segment_start: _,
                },
                Some(new_app),
            ) if same_app(cur, &new_app) && *cur_afk == now_afk => Ok(()),

            // Active -> (Active with different app or different AFK status, or Idle):
            // flush old segment, start new one (or go Idle).
            (
                CollectorState::Active {
                    app: cur,
                    segment_start,
                    is_afk: cur_afk,
                },
                new_app_opt,
            ) => {
                let started = *segment_start;
                let ended = Utc::now();
                self.insert_segment(cur, started, ended, *cur_afk).await;

                *state = match new_app_opt {
                    Some(new_app) => {
                        log::debug!(
                            "usage_stats: segment transition -> {} (afk {}->{})",
                            new_app.process_name,
                            cur_afk,
                            now_afk
                        );
                        CollectorState::Active {
                            app: new_app,
                            segment_start: ended,
                            is_afk: now_afk,
                        }
                    }
                    None => CollectorState::Idle,
                };
                Ok(())
            }
        }
    }

    /// Flush the in-flight segment (if any) and mark state as Stopped.
    /// Called once on shutdown.
    async fn flush_current(&self) {
        let mut state = self.state.lock().await;
        if let CollectorState::Active {
            app,
            segment_start,
            is_afk,
        } = &*state
        {
            let started = *segment_start;
            let ended = Utc::now();
            self.insert_segment(app, started, ended, *is_afk).await;
        }
        *state = CollectorState::Stopped;
    }

    /// Insert a finalized segment row. Logs warnings on failure but never
    /// propagates errors (segment loss is non-fatal — the next session
    /// continues independently).
    async fn insert_segment(
        &self,
        app: &ForegroundApp,
        started: DateTime<Utc>,
        ended: DateTime<Utc>,
        is_afk: bool,
    ) {
        let seg = ActivitySegment {
            id: None,
            started_at: started,
            ended_at: ended,
            exe_path: app.exe_path.clone().unwrap_or_default(),
            process_name: app.process_name.clone(),
            window_title: app.window_title.clone(),
            process_id: app.process_id,
            bundle_id: app.bundle_id.clone(),
            duration_secs: (ended - started).num_seconds().max(0),
            is_afk,
            session_id: self.session_id.clone(),
        };
        if let Err(e) = self.store.insert_segment(&seg) {
            log::warn!("usage_stats: insert_segment error: {}", e);
        }
    }

    /// Best-effort icon extraction (Windows only). Reads the exe's icon
    /// resource, encodes it as base64 PNG, and persists it to `app_rules`.
    /// Subsequent polls skip this when the rule already has an icon. The
    /// icon module's in-memory cache also deduplicates within a session.
    #[cfg(target_os = "windows")]
    fn maybe_extract_icon(&self, exe_path: &str) {
        if let Some(icon) = get_icon_base64(exe_path) {
            if let Err(e) = self.store.update_app_icon(exe_path, &icon) {
                log::debug!("usage_stats: update_app_icon error (non-fatal): {}", e);
            }
        }
    }

    /// No-op icon extraction on non-Windows platforms (macOS/Linux Phase 2).
    #[cfg(not(target_os = "windows"))]
    fn maybe_extract_icon(&self, _exe_path: &str) {}
}

/// Compare two foreground apps for "same segment" purposes.
///
/// Uses `exe_path` as the canonical identity when both are present; falls back
/// to `process_name + bundle_id + pid` to handle cases where `exe_path`
/// couldn't be resolved (e.g. elevated process on Windows).
fn same_app(a: &ForegroundApp, b: &ForegroundApp) -> bool {
    match (a.exe_path.as_ref(), b.exe_path.as_ref()) {
        (Some(pa), Some(pb)) => pa == pb,
        _ => {
            a.process_name == b.process_name
                && a.bundle_id == b.bundle_id
                && a.process_id == b.process_id
        }
    }
}
