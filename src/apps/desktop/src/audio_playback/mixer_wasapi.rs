//! WASAPI push-mode audio backend for Windows.
//!
//! Uses WASAPI shared mode with a large buffer (2 seconds) in push mode.
//! The audio engine reads from our buffer at its own pace, so even if our
//! feeder thread is blocked by GPU driver DPC latency for hundreds of
//! milliseconds, the engine continues playing from the pre-filled buffer.
//!
//! Architecture:
//! - Single feeder thread: mixes channels → writes directly to WASAPI
//! - No render thread, no ring buffer, no event-driven callbacks
//! - 2-second WASAPI buffer provides massive safety margin against DPC

use arc_swap::ArcSwap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use wasapi::*;

use crate::audio_playback::channel::{ChannelKind, MixerChannel};
use crate::audio_playback::decoder::{decode_audio_file, resample_audio};
use anyhow::{anyhow, Result};

// WASAPI buffer duration: 2 seconds = 20,000,000 hundred-nanosecond units
const WASAPI_BUFFER_DURATION_HNS: i64 = 20_000_000;

// Feeder thread: target fill level (how far ahead to keep the buffer filled)
const FEEDER_TARGET_SECS: f32 = 1.5;

// ─── AudioMixer ────────────────────────────────────────────────────────────

pub struct AudioMixer {
    channels: Arc<ArcSwap<Vec<Arc<MixerChannel>>>>,
    bgm_channel_id: Mutex<Option<u64>>,
    preview_channel_id: Mutex<Option<u64>>,
    next_id: AtomicUsize,
    master_volume: Arc<AtomicU32>,
    output_sample_rate: u32,
    output_channels: u16,
    shutdown: Arc<AtomicBool>,
    _feeder_thread: Option<std::thread::JoinHandle<()>>,
}

impl AudioMixer {
    pub fn new() -> Result<Self> {
        initialize_mta()
            .ok()
            .map_err(|e| anyhow!("Failed to initialize COM MTA: {:?}", e))?;

        // Probe device to get sample rate and channels
        let (output_sample_rate, output_channels) = {
            let enumerator = DeviceEnumerator::new()
                .map_err(|e| anyhow!("Failed to create device enumerator: {:?}", e))?;
            let device = enumerator
                .get_default_device(&Direction::Render)
                .map_err(|e| anyhow!("Failed to get default audio device: {:?}", e))?;
            let audio_client = device
                .get_iaudioclient()
                .map_err(|e| anyhow!("Failed to get IAudioClient: {:?}", e))?;

            let mix_format = audio_client
                .get_mixformat()
                .map_err(|e| anyhow!("get_mixformat failed: {:?}", e))?;

            (mix_format.get_samplespersec(), mix_format.get_nchannels())
        };

        log::info!(
            "Audio device: sample_rate={}, channels={}",
            output_sample_rate,
            output_channels
        );

        let channels_arc = Arc::new(ArcSwap::from_pointee(Vec::<Arc<MixerChannel>>::new()));
        let master_volume = Arc::new(AtomicU32::new(1000));
        let shutdown = Arc::new(AtomicBool::new(false));

        // Spawn feeder thread — creates WASAPI objects and runs the audio loop
        let shutdown_clone = shutdown.clone();
        let channels_clone = channels_arc.clone();
        let master_volume_clone = master_volume.clone();
        let feeder_thread = std::thread::Builder::new()
            .name("wasapi-feeder".to_string())
            .spawn(move || {
                if let Err(e) = wasapi_feeder_loop(
                    channels_clone,
                    master_volume_clone,
                    output_sample_rate,
                    output_channels,
                    shutdown_clone,
                ) {
                    log::error!("[WASAPI Feeder] Thread failed: {}", e);
                }
            })
            .map_err(|e| anyhow!("Failed to spawn feeder thread: {}", e))?;

        // Give the feeder thread a moment to initialize WASAPI
        std::thread::sleep(std::time::Duration::from_millis(200));

        Ok(Self {
            channels: channels_arc,
            bgm_channel_id: Mutex::new(None),
            preview_channel_id: Mutex::new(None),
            next_id: AtomicUsize::new(1),
            output_sample_rate,
            output_channels,
            master_volume,
            shutdown,
            _feeder_thread: Some(feeder_thread),
        })
    }

    pub fn output_sample_rate(&self) -> u32 {
        self.output_sample_rate
    }

    pub fn output_channels(&self) -> u16 {
        self.output_channels
    }

    fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) as u64
    }

    fn add_channel(&self, channel: Arc<MixerChannel>) {
        self.channels.rcu(|old| {
            let mut new_vec = (**old).clone();
            new_vec.push(channel.clone());
            new_vec
        });
    }

    fn remove_channel_by_id(&self, id: u64) {
        self.channels.rcu(|old| {
            let new_vec: Vec<Arc<MixerChannel>> =
                (**old).iter().filter(|ch| ch.id != id).cloned().collect();
            new_vec
        });
    }

    fn find_channel(&self, id: u64) -> Option<Arc<MixerChannel>> {
        let snapshot = self.channels.load();
        snapshot.iter().find(|ch| ch.id == id).cloned()
    }

    pub fn load_and_resample(path: &str, output_sample_rate: u32) -> Result<(Vec<f32>, u16)> {
        let file_path = std::path::Path::new(path);
        let (samples, sr, ch) = decode_audio_file(file_path)?;

        let resampled = if sr != output_sample_rate {
            resample_audio(&samples, sr, output_sample_rate, ch)
        } else {
            samples
        };

        log::info!(
            "Audio decoded: path={}, frames={}, sr={}, ch={}, output_sr={}",
            path,
            resampled.len() / ch as usize,
            sr,
            ch,
            output_sample_rate
        );

        Ok((resampled, ch))
    }

    pub fn play_bgm(
        &self,
        path: &str,
        volume: f32,
        fade_in_secs: f32,
        loop_enabled: bool,
    ) -> Result<u64> {
        let (samples, ch) = Self::load_and_resample(path, self.output_sample_rate)?;
        self.play_bgm_with_samples(path, volume, fade_in_secs, loop_enabled, samples, ch)
    }

    pub fn play_bgm_with_samples(
        &self,
        path: &str,
        volume: f32,
        fade_in_secs: f32,
        loop_enabled: bool,
        samples: Vec<f32>,
        source_channels: u16,
    ) -> Result<u64> {
        if let Ok(guard) = self.bgm_channel_id.lock() {
            if let Some(old_id) = *guard {
                drop(guard);
                self.stop_channel(old_id, 1.0);
            }
        }

        let id = self.alloc_id();
        let channel = Arc::new(MixerChannel::new(
            id,
            format!("bgm-{}", id),
            samples,
            self.output_sample_rate,
            source_channels,
            self.output_channels,
            ChannelKind::Bgm,
            Some(path.to_string()),
        ));

        channel.set_volume(volume);
        channel.loop_enabled.store(loop_enabled, Ordering::Relaxed);

        if fade_in_secs > 0.0 {
            channel.start_fade_in(std::time::Duration::from_secs_f32(fade_in_secs));
        }

        self.add_channel(channel);

        if let Ok(mut guard) = self.bgm_channel_id.lock() {
            *guard = Some(id);
        }

        log::info!("BGM started: id={}, path={}", id, path);
        Ok(id)
    }

    pub fn play_sfx(&self, path: &str, volume: f32) -> Result<u64> {
        let (samples, ch) = Self::load_and_resample(path, self.output_sample_rate)?;
        self.play_sfx_with_samples(path, volume, samples, ch)
    }

    pub fn play_sfx_with_samples(
        &self,
        path: &str,
        volume: f32,
        samples: Vec<f32>,
        source_channels: u16,
    ) -> Result<u64> {
        let id = self.alloc_id();
        let channel = Arc::new(MixerChannel::new(
            id,
            format!("sfx-{}", id),
            samples,
            self.output_sample_rate,
            source_channels,
            self.output_channels,
            ChannelKind::Sfx,
            Some(path.to_string()),
        ));

        channel.set_volume(volume);
        channel.loop_enabled.store(true, Ordering::Relaxed);

        self.add_channel(channel);

        log::info!("SFX started: id={}, path={}", id, path);
        Ok(id)
    }

    pub fn play_preview(&self, path: &str, volume: f32) -> Result<u64> {
        self.stop_preview();
        let (samples, ch) = Self::load_and_resample(path, self.output_sample_rate)?;
        self.play_preview_with_samples(path, volume, samples, ch)
    }

    pub fn play_preview_with_samples(
        &self,
        path: &str,
        volume: f32,
        samples: Vec<f32>,
        source_channels: u16,
    ) -> Result<u64> {
        let id = self.alloc_id();
        let channel = Arc::new(MixerChannel::new(
            id,
            format!("preview-{}", id),
            samples,
            self.output_sample_rate,
            source_channels,
            self.output_channels,
            ChannelKind::Preview,
            Some(path.to_string()),
        ));

        channel.set_volume(volume);
        channel.loop_enabled.store(false, Ordering::Relaxed);

        self.add_channel(channel);

        if let Ok(mut guard) = self.preview_channel_id.lock() {
            *guard = Some(id);
        }

        log::info!("Preview started: id={}, path={}", id, path);
        Ok(id)
    }

    pub fn stop_channel(&self, id: u64, fade_out_secs: f32) {
        let channel = self.find_channel(id);
        if let Some(channel) = channel {
            if fade_out_secs > 0.0 {
                channel.start_fade_out(std::time::Duration::from_secs_f32(fade_out_secs));
            } else {
                channel.stop();
                self.remove_channel_by_id(id);
            }
        }
    }

    pub fn stop_all_sfx(&self) {
        let snapshot = self.channels.load();
        let sfx_ids: Vec<u64> = snapshot
            .iter()
            .filter(|ch| ch.kind == ChannelKind::Sfx)
            .map(|ch| ch.id)
            .collect();

        for id in sfx_ids {
            self.stop_channel(id, 0.0);
        }
    }

    pub fn stop_preview(&self) {
        if let Ok(guard) = self.preview_channel_id.lock() {
            if let Some(id) = *guard {
                drop(guard);
                self.stop_channel(id, 0.0);
            }
        }
    }

    pub fn set_channel_volume(&self, id: u64, volume: f32) -> Result<()> {
        let channel = self
            .find_channel(id)
            .ok_or_else(|| anyhow!("Channel {} not found", id))?;
        channel.set_volume(volume);
        Ok(())
    }

    pub fn set_master_volume(&self, volume: f32) {
        let clamped = volume.clamp(0.0, 1.0);
        self.master_volume
            .store((clamped * 1000.0) as u32, Ordering::Relaxed);
    }

    pub fn get_master_volume(&self) -> f32 {
        self.master_volume.load(Ordering::Relaxed) as f32 / 1000.0
    }

    pub fn pause_channel(&self, id: u64) -> Result<()> {
        let channel = self
            .find_channel(id)
            .ok_or_else(|| anyhow!("Channel {} not found", id))?;
        channel.pause();
        Ok(())
    }

    pub fn resume_channel(&self, id: u64) -> Result<()> {
        let channel = self
            .find_channel(id)
            .ok_or_else(|| anyhow!("Channel {} not found", id))?;
        channel.play();
        Ok(())
    }

    pub fn list_channels(&self) -> Vec<crate::audio_playback::channel::ChannelInfo> {
        let snapshot = self.channels.load();
        snapshot.iter().map(|ch| ch.get_info()).collect()
    }

    pub fn is_any_playing(&self) -> bool {
        let snapshot = self.channels.load();
        snapshot.iter().any(|ch| ch.is_playing())
    }

    pub fn cleanup_stopped(&self) {
        self.channels.rcu(|old| {
            let new_vec: Vec<Arc<MixerChannel>> = (**old)
                .iter()
                .filter(|ch| ch.is_active())
                .cloned()
                .collect();
            new_vec
        });
    }
}

impl Drop for AudioMixer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
    }
}

// ─── WASAPI Feeder Loop ────────────────────────────────────────────────────
// All WASAPI COM objects are created and used within this single thread.
// Uses PushShared mode with a 2-second buffer — the audio engine reads from
// our buffer at its own pace, so even if this thread is blocked by GPU DPC
// for hundreds of milliseconds, the engine continues playing.

fn wasapi_feeder_loop(
    channels: Arc<ArcSwap<Vec<Arc<MixerChannel>>>>,
    master_volume: Arc<AtomicU32>,
    output_sample_rate: u32,
    output_channels: u16,
    shutdown: Arc<AtomicBool>,
) -> Result<()> {
    // Set BELOW_NORMAL priority for the feeder thread
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
        };
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }

    log::info!("[WASAPI Feeder] Thread started");

    // Initialize COM for this thread
    initialize_mta()
        .ok()
        .map_err(|e| anyhow!("Failed to initialize COM MTA: {:?}", e))?;

    let enumerator = DeviceEnumerator::new()
        .map_err(|e| anyhow!("Failed to create device enumerator: {:?}", e))?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| anyhow!("Failed to get default audio device: {:?}", e))?;

    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| anyhow!("Failed to get IAudioClient: {:?}", e))?;

    // Use the device's mix format (shared mode)
    let mix_format = audio_client
        .get_mixformat()
        .map_err(|e| anyhow!("get_mixformat failed: {:?}", e))?;

    let is_float = mix_format.get_bitspersample() == 32;
    let block_align = mix_format.get_blockalign() as usize;

    log::info!(
        "[WASAPI Feeder] Device format: {}Hz {}ch {}bit {}",
        mix_format.get_samplespersec(),
        mix_format.get_nchannels(),
        mix_format.get_bitspersample(),
        if is_float { "float" } else { "int" }
    );

    // Initialize with PollingShared mode and large buffer
    // Polling mode = push mode: we write data at our own pace, the audio engine
    // reads from the buffer at its own pace. With a 2-second buffer, even if our
    // thread is blocked by GPU DPC for hundreds of ms, the engine keeps playing.
    let mode = StreamMode::PollingShared {
        autoconvert: true,
        buffer_duration_hns: WASAPI_BUFFER_DURATION_HNS,
    };

    audio_client
        .initialize_client(&mix_format, &Direction::Render, &mode)
        .map_err(|e| anyhow!("WASAPI PushShared init failed: {:?}", e))?;

    let render_client = audio_client
        .get_audiorenderclient()
        .map_err(|e| anyhow!("Failed to get render client: {:?}", e))?;

    audio_client
        .start_stream()
        .map_err(|e| anyhow!("Failed to start stream: {:?}", e))?;

    log::info!(
        "[WASAPI Feeder] PushShared mode started with {}s buffer",
        WASAPI_BUFFER_DURATION_HNS as f64 / 10_000_000.0
    );

    let frame_size = output_channels as usize;
    let target_ahead_frames = (FEEDER_TARGET_SECS * output_sample_rate as f32) as usize;
    let chunk_frames = output_sample_rate as usize / 20; // 50ms chunks

    let mut mix_buf = vec![0.0f32; chunk_frames * frame_size];
    let mut temp_buf = vec![0.0f32; chunk_frames * frame_size];

    // Pre-fill the buffer on startup
    let buffer_frames =
        (WASAPI_BUFFER_DURATION_HNS as u64 * output_sample_rate as u64 / 10_000_000) as usize;
    log::info!(
        "[WASAPI Feeder] Pre-filling buffer with {} frames ({:.1}s)...",
        buffer_frames,
        buffer_frames as f32 / output_sample_rate as f32
    );

    // Write silence to pre-fill the entire buffer
    let silence_bytes = vec![0u8; buffer_frames * block_align];
    if let Err(e) = render_client.write_to_device(buffer_frames, &silence_bytes, None) {
        log::warn!("[WASAPI Feeder] Pre-fill write failed: {:?}", e);
    }

    // Main feeder loop
    while !shutdown.load(Ordering::Relaxed) {
        // Get available space in the WASAPI buffer
        let available_frames = match audio_client.get_available_space_in_frames() {
            Ok(f) => f as usize,
            Err(e) => {
                log::error!("[WASAPI Feeder] get_available_space failed: {:?}", e);
                break;
            }
        };

        // Calculate how far ahead we are (buffer_frames - available_frames = currently playing position)
        let buffered_frames = buffer_frames.saturating_sub(available_frames);

        // Only write if we need to maintain our target fill level
        if buffered_frames >= target_ahead_frames {
            // Buffer is sufficiently full, sleep briefly
            std::thread::sleep(std::time::Duration::from_millis(10));
            continue;
        }

        let frames_to_write = available_frames.min(chunk_frames);
        if frames_to_write == 0 {
            std::thread::sleep(std::time::Duration::from_millis(5));
            continue;
        }

        let samples_to_write = frames_to_write * frame_size;

        // Mix all channels
        let mix_slice = &mut mix_buf[..samples_to_write];
        mix_slice.fill(0.0f32);

        let snapshot = channels.load();
        let master_vol = master_volume.load(Ordering::Relaxed) as f32 / 1000.0;

        for channel in snapshot.iter() {
            if !channel.is_playing() {
                continue;
            }
            let vol = channel.effective_volume() * master_vol;
            if vol < 0.001 {
                continue;
            }

            let temp_slice = &mut temp_buf[..samples_to_write];
            channel.read_samples(temp_slice);

            for i in 0..samples_to_write {
                mix_slice[i] += temp_slice[i] * vol;
            }
        }

        // Soft clip
        for s in mix_slice.iter_mut() {
            *s = s.tanh();
        }

        // Convert to bytes and write to WASAPI
        let byte_data = if is_float {
            mix_slice
                .iter()
                .flat_map(|s| s.to_le_bytes())
                .collect::<Vec<u8>>()
        } else {
            // 16-bit int
            mix_slice
                .iter()
                .flat_map(|s| {
                    let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                    v.to_le_bytes()
                })
                .collect::<Vec<u8>>()
        };

        if let Err(e) = render_client.write_to_device(frames_to_write, &byte_data, None) {
            log::error!("[WASAPI Feeder] write_to_device failed: {:?}", e);
            break;
        }

        // Adaptive sleep: sleep more when buffer is full, less when it's draining
        let fill_ratio = buffered_frames as f32 / target_ahead_frames as f32;
        let sleep_ms = if fill_ratio > 0.8 {
            50
        } else if fill_ratio > 0.5 {
            20
        } else {
            5
        };
        std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
    }

    let _ = audio_client.stop_stream();
    log::info!("[WASAPI Feeder] Thread exiting");
    Ok(())
}
