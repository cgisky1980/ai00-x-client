use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Device, SampleFormat, Stream, StreamConfig};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::audio_playback::channel::{ChannelKind, MixerChannel};
use crate::audio_playback::decoder::{decode_audio_file, resample_audio};
use anyhow::{anyhow, Result};

/// Number of spectrum bands exposed to the frontend.
pub const SPECTRUM_BANDS: usize = 24;

/// Shared spectrum data: 24 band levels as f32 [0.0..1.0].
/// Updated by the feeder thread, read by the Tauri command.
pub struct SpectrumData {
    bands: [AtomicU32; SPECTRUM_BANDS],
}

impl Default for SpectrumData {
    fn default() -> Self {
        Self::new()
    }
}

impl SpectrumData {
    pub fn new() -> Self {
        Self {
            bands: std::array::from_fn(|_| AtomicU32::new(0)),
        }
    }

    /// Set a band value. Stored as u32 = f32 * 1_000_000 for lock-free access.
    pub fn set_band(&self, idx: usize, value: f32) {
        let v = (value.clamp(0.0, 1.0) * 1_000_000.0) as u32;
        self.bands[idx].store(v, Ordering::Relaxed);
    }

    /// Read all band values as f32.
    pub fn read_bands(&self) -> Vec<f32> {
        self.bands
            .iter()
            .map(|a| a.load(Ordering::Relaxed) as f32 / 1_000_000.0)
            .collect()
    }
}

// cpal buffer size - larger buffer = more resilience against DPC latency spikes
// 48000 frames = 1000ms at 48kHz. GPU driver DPC bursts can block 300-500ms,
// so 1 second gives enough headroom to avoid device buffer underruns.
const CPAL_BUFFER_FRAMES: u32 = 48000;

// Ring buffer size in seconds - large enough to survive DPC spikes
const RING_BUFFER_SECS: f32 = 2.0;

// ─── Lock-free SPSC Ring Buffer ───────────────────────────────────────────
// Stores interleaved f32 samples. Power-of-2 size for fast modulo via masking.

struct AudioRingBuffer {
    data: std::cell::UnsafeCell<Box<[f32]>>,
    mask: usize,
    write_pos: AtomicUsize,
    read_pos: AtomicUsize,
}

// SAFETY: AudioRingBuffer is SPSC — only one thread writes (feeder) and one reads (callback).
unsafe impl Send for AudioRingBuffer {}
unsafe impl Sync for AudioRingBuffer {}

impl AudioRingBuffer {
    fn new(duration_secs: f32, sample_rate: u32, channels: u16) -> Self {
        let total_samples = (duration_secs * sample_rate as f32 * channels as f32) as usize;
        let size = total_samples.next_power_of_two();
        log::info!(
            "AudioRingBuffer: size={} samples ({}s @ {}Hz {}ch, {:.1}MB)",
            size,
            duration_secs,
            sample_rate,
            channels,
            size as f64 * 4.0 / 1024.0 / 1024.0
        );
        Self {
            data: std::cell::UnsafeCell::new(vec![0.0f32; size].into_boxed_slice()),
            mask: size - 1,
            write_pos: AtomicUsize::new(0),
            read_pos: AtomicUsize::new(0),
        }
    }

    #[inline]
    fn available_read(&self) -> usize {
        let write = self.write_pos.load(Ordering::Acquire);
        let read = self.read_pos.load(Ordering::Acquire);
        write.saturating_sub(read)
    }

    #[allow(dead_code)]
    #[inline]
    fn available_write(&self) -> usize {
        let capacity = self.mask + 1;
        let write = self.write_pos.load(Ordering::Relaxed);
        let read = self.read_pos.load(Ordering::Acquire);
        capacity.saturating_sub(write - read)
    }

    /// Read samples from ring buffer into output. Returns number of samples read.
    fn read(&self, output: &mut [f32]) -> usize {
        let read = self.read_pos.load(Ordering::Relaxed);
        let write = self.write_pos.load(Ordering::Acquire);
        let available = write.saturating_sub(read);
        let to_read = output.len().min(available);
        if to_read == 0 {
            return 0;
        }

        let data = unsafe { &*self.data.get() };
        let start = read & self.mask;
        let first = to_read.min(self.mask + 1 - start);
        output[..first].copy_from_slice(&data[start..start + first]);
        if to_read > first {
            output[first..to_read].copy_from_slice(&data[..to_read - first]);
        }

        self.read_pos.store(read + to_read, Ordering::Release);
        to_read
    }

    /// Write samples into ring buffer. Returns number of samples written.
    fn write(&self, input: &[f32]) -> usize {
        let read = self.read_pos.load(Ordering::Acquire);
        let write = self.write_pos.load(Ordering::Relaxed);
        let capacity = self.mask + 1;
        let available = capacity.saturating_sub(write - read);
        let to_write = input.len().min(available);
        if to_write == 0 {
            return 0;
        }

        let data = unsafe { &mut *self.data.get() };
        let start = write & self.mask;
        let first = to_write.min(self.mask + 1 - start);
        data[start..start + first].copy_from_slice(&input[..first]);
        if to_write > first {
            data[..to_write - first].copy_from_slice(&input[first..to_write]);
        }

        self.write_pos.store(write + to_write, Ordering::Release);
        to_write
    }

    fn capacity(&self) -> usize {
        self.mask + 1
    }

    /// Clear all data from the ring buffer by advancing read position to write position.
    /// Called when volume/pause state changes so the feeder thread refills with fresh data.
    fn clear(&self) {
        let write = self.write_pos.load(Ordering::Acquire);
        self.read_pos.store(write, Ordering::Release);
    }
}

// ─── Feeder Thread ─────────────────────────────────────────────────────────
// Reads from channels, mixes, and writes to the ring buffer.
// The audio callback only reads from the ring buffer.

fn feeder_thread(
    channels: Arc<ArcSwap<Vec<Arc<MixerChannel>>>>,
    ring_buffer: Arc<AudioRingBuffer>,
    master_volume: Arc<AtomicU32>,
    needs_flush: Arc<AtomicBool>,
    output_sample_rate: u32,
    output_channels: u16,
    shutdown: Arc<AtomicBool>,
) {
    log::info!("[AudioFeeder] Starting feeder thread");

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
        };
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
    }

    let frame_size = output_channels as usize;
    // Target: keep 1.5 seconds ahead in the ring buffer
    let target_ahead_samples = (output_sample_rate as f32 * 1.5 * frame_size as f32) as usize;
    // Mix in chunks of 100ms
    let chunk_samples = (output_sample_rate as usize / 10) * frame_size;

    let mut mix_buf = vec![0.0f32; chunk_samples];
    let mut temp_buf = vec![0.0f32; chunk_samples];
    let mut log_counter: u32 = 0;

    while !shutdown.load(Ordering::Relaxed) {
        // Flush ring buffer when volume/pause state changes
        if needs_flush.load(Ordering::Relaxed) {
            ring_buffer.clear();
            needs_flush.store(false, Ordering::Relaxed);
        }

        let current_level = ring_buffer.available_read();
        let needed = target_ahead_samples.saturating_sub(current_level);

        if needed > 0 {
            let to_mix = needed.min(chunk_samples);
            let mix_slice = &mut mix_buf[..to_mix];
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

                // Log volume info every 100 iterations (~5 seconds)
                log_counter += 1;
                if log_counter.is_multiple_of(100) {
                    log::info!(
                        "[AudioFeeder] Channel {}: base_vol={:.3}, master_vol={:.3}, eff_vol={:.3}, fade={}",
                        channel.id,
                        channel.get_volume(),
                        master_vol,
                        vol,
                        channel.fade_kind()
                    );
                }

                let temp_slice = &mut temp_buf[..to_mix];
                channel.read_samples(temp_slice);

                for i in 0..to_mix {
                    mix_slice[i] += temp_slice[i] * vol;
                }
            }

            // Soft clip
            for s in mix_slice.iter_mut() {
                *s = s.tanh();
            }

            let written = ring_buffer.write(mix_slice);
            if written < to_mix {
                log::warn!(
                    "[AudioFeeder] Ring buffer full: wrote {}/{} samples",
                    written,
                    to_mix
                );
            }
        }

        // Adaptive sleep
        let fill_ratio = current_level as f32 / target_ahead_samples as f32;
        let sleep_ms = if fill_ratio > 0.9 {
            50
        } else if fill_ratio > 0.5 {
            20
        } else {
            5
        };
        std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
    }

    log::info!("[AudioFeeder] Feeder thread exiting");
}

// ─── AudioMixer ────────────────────────────────────────────────────────────

pub struct AudioMixer {
    channels: Arc<ArcSwap<Vec<Arc<MixerChannel>>>>,
    bgm_channel_id: Mutex<Option<u64>>,
    preview_channel_id: Mutex<Option<u64>>,
    #[allow(dead_code)]
    stream: Option<Stream>,
    next_id: AtomicU64,
    master_volume: Arc<AtomicU32>,
    output_sample_rate: u32,
    output_channels: u16,
    #[allow(dead_code)]
    initialized: AtomicBool,
    shutdown: Arc<AtomicBool>,
    #[allow(dead_code)]
    ring_buffer: Arc<AudioRingBuffer>,
    needs_flush: Arc<AtomicBool>,
    spectrum_data: Arc<SpectrumData>,
}

impl AudioMixer {
    pub fn new() -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| anyhow!("No default output device found"))?;

        let supported_config = device
            .default_output_config()
            .map_err(|e| anyhow!("Failed to get default output config: {}", e))?;

        let sample_format = supported_config.sample_format();
        let output_sample_rate = supported_config.sample_rate();
        let output_channels = supported_config.channels();
        let mut config: StreamConfig = supported_config.into();
        config.buffer_size = BufferSize::Fixed(CPAL_BUFFER_FRAMES);

        let channels = Arc::new(ArcSwap::from_pointee(Vec::<Arc<MixerChannel>>::new()));
        let master_volume = Arc::new(AtomicU32::new(1000));
        let ring_buffer = Arc::new(AudioRingBuffer::new(
            RING_BUFFER_SECS,
            output_sample_rate,
            output_channels,
        ));
        let shutdown = Arc::new(AtomicBool::new(false));
        let needs_flush = Arc::new(AtomicBool::new(false));
        let spectrum_data = Arc::new(SpectrumData::new());

        let stream = match sample_format {
            SampleFormat::F32 => Self::build_stream::<f32>(
                &device,
                &config,
                ring_buffer.clone(),
                spectrum_data.clone(),
                output_channels,
            ),
            SampleFormat::I16 => Self::build_stream::<i16>(
                &device,
                &config,
                ring_buffer.clone(),
                spectrum_data.clone(),
                output_channels,
            ),
            SampleFormat::U16 => Self::build_stream::<u16>(
                &device,
                &config,
                ring_buffer.clone(),
                spectrum_data.clone(),
                output_channels,
            ),
            _ => return Err(anyhow!("Unsupported sample format: {:?}", sample_format)),
        }?;

        stream
            .play()
            .map_err(|e| anyhow!("Failed to play stream: {}", e))?;

        // Spawn feeder thread
        std::thread::Builder::new()
            .name("audio-feeder".to_string())
            .spawn({
                let channels = channels.clone();
                let ring_buffer = ring_buffer.clone();
                let master_volume = master_volume.clone();
                let shutdown = shutdown.clone();
                let needs_flush = needs_flush.clone();
                move || {
                    feeder_thread(
                        channels,
                        ring_buffer,
                        master_volume,
                        needs_flush,
                        output_sample_rate,
                        output_channels,
                        shutdown,
                    )
                }
            })
            .map_err(|e| anyhow!("Failed to spawn audio feeder thread: {}", e))?;

        log::info!(
            "AudioMixer initialized: sample_rate={}, channels={}, format={:?}, cpal_buffer={}frames, ring_buffer={:.1}MB",
            output_sample_rate,
            output_channels,
            sample_format,
            CPAL_BUFFER_FRAMES,
            ring_buffer.capacity() as f64 * 4.0 / 1024.0 / 1024.0
        );

        Ok(Self {
            channels,
            bgm_channel_id: Mutex::new(None),
            preview_channel_id: Mutex::new(None),
            stream: Some(stream),
            next_id: AtomicU64::new(1),
            output_sample_rate,
            output_channels,
            master_volume,
            initialized: AtomicBool::new(true),
            shutdown,
            ring_buffer,
            needs_flush,
            spectrum_data,
        })
    }

    /// Read current spectrum band levels [0.0..1.0] x 12.
    pub fn get_spectrum(&self) -> Vec<f32> {
        self.spectrum_data.read_bands()
    }

    fn build_stream<T>(
        device: &Device,
        config: &StreamConfig,
        ring_buffer: Arc<AudioRingBuffer>,
        spectrum_data: Arc<SpectrumData>,
        output_channels: u16,
    ) -> Result<Stream>
    where
        T: cpal::Sample + cpal::SizedSample + cpal::FromSample<f32>,
        f32: cpal::FromSample<T>,
    {
        device
            .build_output_stream(
                config,
                move |output: &mut [T], _: &cpal::OutputCallbackInfo| {
                    // Set audio callback thread to TIME_CRITICAL priority on Windows.
                    #[cfg(target_os = "windows")]
                    {
                        static PRIORITY_SET: AtomicBool = AtomicBool::new(false);
                        if PRIORITY_SET
                            .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
                            .is_ok()
                        {
                            unsafe {
                                use windows::Win32::System::Threading::{
                                    GetCurrentThread, SetThreadPriority,
                                    THREAD_PRIORITY_TIME_CRITICAL,
                                };
                                let _ = SetThreadPriority(
                                    GetCurrentThread(),
                                    THREAD_PRIORITY_TIME_CRITICAL,
                                );
                            }
                        }
                    }

                    // Measure callback interval to detect DPC blocking
                    static LAST_CALLBACK_TIME: std::sync::Mutex<Option<Instant>> =
                        std::sync::Mutex::new(None);
                    let now = Instant::now();
                    if let Ok(mut last) = LAST_CALLBACK_TIME.lock() {
                        if let Some(prev) = *last {
                            let elapsed_ms = now.duration_since(prev).as_millis();
                            // Normal interval is ~300ms (CPAL_BUFFER_FRAMES at 48kHz)
                            // If > 500ms, DPC is blocking the callback
                            if elapsed_ms > 500 {
                                log::warn!(
                                    "[AudioCallback] DPC BLOCK: {elapsed_ms}ms since last callback (normal=~300ms)"
                                );
                            }
                        }
                        *last = Some(now);
                    }

                    // Read from ring buffer — this is the ONLY thing the callback does.
                    let buf_len = output.len();
                    let mut read_buf = [0.0f32; 48000];
                    let to_read = buf_len.min(read_buf.len());
                    let read = ring_buffer.read(&mut read_buf[..to_read]);

                    // Detect underrun: callback got less data than needed
                    if read < to_read {
                        static UNDERRUN_COUNT: AtomicUsize = AtomicUsize::new(0);
                        let count = UNDERRUN_COUNT.fetch_add(1, Ordering::Relaxed);
                        if count < 20 || count.is_multiple_of(100) {
                            log::warn!(
                                "[AudioCallback] UNDERRUN #{count}: needed {to_read} samples, got {read} — this causes crackling"
                            );
                        }
                    }

                    // Compute spectrum from the audio that is about to play.
                    // Doing this in the audio callback ensures the visual is
                    // perfectly synchronized with what the user hears.
                    {
                        let frame_sz = output_channels as usize;
                        let total_frames = read / frame_sz;
                        let frames_per_band = total_frames / SPECTRUM_BANDS;
                        if frames_per_band > 0 {
                            for band in 0..SPECTRUM_BANDS {
                                let start_frame = band * frames_per_band;
                                let end_frame = if band == SPECTRUM_BANDS - 1 {
                                    total_frames
                                } else {
                                    (band + 1) * frames_per_band
                                };
                                let mut sum = 0.0f32;
                                let mut count = 0usize;
                                for frame in start_frame..end_frame {
                                    let base = frame * frame_sz;
                                    for ch in 0..frame_sz {
                                        if base + ch < read {
                                            let s = read_buf[base + ch];
                                            sum += s * s;
                                            count += 1;
                                        }
                                    }
                                }
                                let rms = if count > 0 {
                                    (sum / count as f32).sqrt()
                                } else {
                                    0.0
                                };
                                let level = (rms / 0.5).min(1.0);
                                spectrum_data.set_band(band, level);
                            }
                        }
                    }

                    for (i, sample) in output.iter_mut().enumerate() {
                        let v = if i < read { read_buf[i] } else { 0.0 };
                        *sample = T::from_sample(v);
                    }
                },
                |err| {
                    log::error!("Audio mixer stream error: {}", err);
                },
                None,
            )
            .map_err(|e| anyhow!("Failed to build output stream: {}", e))
    }

    pub fn output_sample_rate(&self) -> u32 {
        self.output_sample_rate
    }

    pub fn output_channels(&self) -> u16 {
        self.output_channels
    }

    fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
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
            // Only fade-out Playing channels; Paused/Stopped channels are not
            // processed by the feeder thread so their fade-out would never complete,
            // leaving zombie channels in the list.
            if fade_out_secs > 0.0 && channel.is_playing() {
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
        self.needs_flush.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn set_master_volume(&self, volume: f32) {
        let clamped = volume.clamp(0.0, 1.0);
        self.master_volume
            .store((clamped * 1000.0) as u32, Ordering::Relaxed);
        self.needs_flush.store(true, Ordering::Relaxed);
    }

    pub fn get_master_volume(&self) -> f32 {
        self.master_volume.load(Ordering::Relaxed) as f32 / 1000.0
    }

    pub fn pause_channel(&self, id: u64) -> Result<()> {
        let channel = self
            .find_channel(id)
            .ok_or_else(|| anyhow!("Channel {} not found", id))?;
        channel.pause();
        self.needs_flush.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn resume_channel(&self, id: u64) -> Result<()> {
        let channel = self
            .find_channel(id)
            .ok_or_else(|| anyhow!("Channel {} not found", id))?;
        channel.play();
        self.needs_flush.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Seek a channel to a specific position in seconds.
    pub fn seek_channel(&self, id: u64, position_secs: f32) -> Result<()> {
        let channel = self
            .find_channel(id)
            .ok_or_else(|| anyhow!("Channel {} not found", id))?;
        channel.seek_secs(position_secs);
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
