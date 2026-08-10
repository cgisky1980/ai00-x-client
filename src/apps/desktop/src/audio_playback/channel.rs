use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChannelKind {
    Bgm,
    Sfx,
    Preview,
}

// Atomic state values for lock-free access in audio callback
const STATE_PLAYING: u8 = 0;
const STATE_PAUSED: u8 = 1;
const STATE_STOPPED: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChannelState {
    Playing,
    Paused,
    Stopped,
}

impl ChannelState {
    #[allow(dead_code)]
    fn to_u8(self) -> u8 {
        match self {
            ChannelState::Playing => STATE_PLAYING,
            ChannelState::Paused => STATE_PAUSED,
            ChannelState::Stopped => STATE_STOPPED,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            STATE_PLAYING => ChannelState::Playing,
            STATE_PAUSED => ChannelState::Paused,
            _ => ChannelState::Stopped,
        }
    }
}

// Atomic fade state for lock-free access in audio callback
const FADE_NONE: u8 = 0;
const FADE_IN: u8 = 1;
const FADE_OUT: u8 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub id: u64,
    pub name: String,
    pub kind: ChannelKind,
    pub state: ChannelState,
    pub volume: f32,
    pub loop_enabled: bool,
    pub source_path: Option<String>,
    /// Decoder position in seconds (how far cpal has read from the decoded
    /// samples). The actual audible position lags behind this value by the
    /// total output buffer latency (ring buffer + cpal buffer).
    ///
    /// Compensation for lyric sync is intentionally NOT applied here — it is
    /// handled on the frontend (`LyricsOverlay`) where users can fine-tune
    /// the offset via +/- buttons. See `LyricsOverlay.tsx` `lyricsOffset`.
    pub position_secs: f32,
    pub duration_secs: f32,
}

/// Convert interleaved samples from source channel count to destination channel count.
/// This is done once at channel creation time, NOT in the audio callback.
fn convert_channels(samples: &[f32], src_ch: usize, dst_ch: usize) -> Vec<f32> {
    if src_ch == dst_ch || samples.is_empty() {
        return samples.to_vec();
    }

    let num_frames = samples.len() / src_ch;
    let mut output = Vec::with_capacity(num_frames * dst_ch);

    for frame in 0..num_frames {
        let frame_start = frame * src_ch;

        if src_ch == 1 && dst_ch > 1 {
            // Mono to multi-channel: duplicate to all channels
            let sample = samples[frame_start];
            for _ in 0..dst_ch {
                output.push(sample);
            }
        } else if src_ch > 1 && dst_ch == 1 {
            // Multi-channel to mono: average all channels
            let sum: f32 = (0..src_ch).map(|ch| samples[frame_start + ch]).sum();
            output.push(sum / src_ch as f32);
        } else {
            // General case: map channels, pad with last source channel
            for ch in 0..dst_ch {
                if ch < src_ch {
                    output.push(samples[frame_start + ch]);
                } else {
                    output.push(samples[frame_start + src_ch - 1]);
                }
            }
        }
    }

    output
}

pub struct MixerChannel {
    pub id: u64,
    pub name: String,
    /// Pre-converted interleaved f32 samples in the OUTPUT format.
    /// Channel count matches the audio device output (e.g. stereo).
    /// This allows the audio callback to do a simple sequential copy
    /// without per-sample branching for mono/stereo conversion.
    samples: Vec<f32>,
    pub sample_rate: u32,
    /// Number of channels in `samples` (always matches output device channels).
    channels: u16,
    pub play_pos: AtomicUsize,
    pub volume: AtomicU32,
    // Lock-free state using atomic
    state: AtomicU8,
    // Lock-free fade using atomics
    fade_kind: AtomicU8,
    fade_start_secs: AtomicU32, // start time as milliseconds since creation
    fade_duration_secs: AtomicU32, // duration in milliseconds
    pub loop_enabled: AtomicBool,
    pub kind: ChannelKind,
    pub source_path: Option<String>,
    // Approximate creation instant for fade calculations
    created_at: Instant,
}

impl MixerChannel {
    /// Create a new MixerChannel.
    /// `output_channels` is the number of channels of the audio output device.
    /// Samples are pre-converted to the output format at creation time,
    /// so the audio callback can do a simple sequential copy.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: u64,
        name: String,
        samples: Vec<f32>,
        sample_rate: u32,
        source_channels: u16,
        output_channels: u16,
        kind: ChannelKind,
        source_path: Option<String>,
    ) -> Self {
        // Pre-convert samples to output channel format at creation time.
        // This eliminates per-sample branching in the audio callback.
        let converted =
            convert_channels(&samples, source_channels as usize, output_channels as usize);

        Self {
            id,
            name,
            samples: converted,
            sample_rate,
            channels: output_channels,
            play_pos: AtomicUsize::new(0),
            volume: AtomicU32::new(1000),
            state: AtomicU8::new(STATE_PLAYING),
            fade_kind: AtomicU8::new(FADE_NONE),
            fade_start_secs: AtomicU32::new(0),
            fade_duration_secs: AtomicU32::new(0),
            loop_enabled: AtomicBool::new(kind == ChannelKind::Bgm),
            kind,
            source_path,
            created_at: Instant::now(),
        }
    }

    /// Read interleaved samples into output buffer.
    /// Since samples are pre-converted to the output format at creation time,
    /// this is a simple sequential copy - no per-sample branching needed.
    /// The CPU can auto-vectorize this and the hardware prefetcher works perfectly.
    pub fn read_samples(&self, output: &mut [f32]) {
        let total_samples = self.samples.len();
        if total_samples == 0 {
            for sample in output.iter_mut() {
                *sample = 0.0;
            }
            return;
        }

        let mut pos = self.play_pos.load(Ordering::Acquire);
        let looping = self.loop_enabled.load(Ordering::Relaxed);
        let out_len = output.len();

        // Fast path: sequential copy with at most one loop point
        let mut written = 0;
        while written < out_len {
            let remaining_in_source = total_samples - pos;
            let remaining_in_output = out_len - written;
            let chunk = remaining_in_source.min(remaining_in_output);

            // Sequential memcpy-like copy - auto-vectorizable
            output[written..written + chunk].copy_from_slice(&self.samples[pos..pos + chunk]);
            written += chunk;
            pos += chunk;

            if pos >= total_samples {
                if looping {
                    pos = 0;
                } else {
                    // Fill remaining with silence
                    output[written..out_len].fill(0.0);
                    self.state.store(STATE_STOPPED, Ordering::Relaxed);
                    break;
                }
            }
        }

        self.play_pos.store(pos, Ordering::Release);
    }

    /// Compute effective volume considering fade state - fully lock-free.
    pub fn effective_volume(&self) -> f32 {
        let base_vol = self.get_volume();

        let fade = self.fade_kind.load(Ordering::Relaxed);
        match fade {
            FADE_NONE => base_vol,
            FADE_IN => {
                let start_ms = self.fade_start_secs.load(Ordering::Relaxed) as u64;
                let dur_ms = self.fade_duration_secs.load(Ordering::Relaxed) as u64;
                if dur_ms == 0 {
                    self.fade_kind.store(FADE_NONE, Ordering::Relaxed);
                    return base_vol;
                }
                let elapsed_ms = self.created_at.elapsed().as_millis() as u64;
                if elapsed_ms >= start_ms + dur_ms {
                    self.fade_kind.store(FADE_NONE, Ordering::Relaxed);
                    base_vol
                } else {
                    let fade_elapsed = elapsed_ms.saturating_sub(start_ms);
                    let t = fade_elapsed as f32 / dur_ms as f32;
                    base_vol * t
                }
            }
            FADE_OUT => {
                let start_ms = self.fade_start_secs.load(Ordering::Relaxed) as u64;
                let dur_ms = self.fade_duration_secs.load(Ordering::Relaxed) as u64;
                if dur_ms == 0 {
                    self.state.store(STATE_STOPPED, Ordering::Relaxed);
                    self.fade_kind.store(FADE_NONE, Ordering::Relaxed);
                    return 0.0;
                }
                let elapsed_ms = self.created_at.elapsed().as_millis() as u64;
                if elapsed_ms >= start_ms + dur_ms {
                    self.state.store(STATE_STOPPED, Ordering::Relaxed);
                    self.fade_kind.store(FADE_NONE, Ordering::Relaxed);
                    0.0
                } else {
                    let fade_elapsed = elapsed_ms.saturating_sub(start_ms);
                    let t = fade_elapsed as f32 / dur_ms as f32;
                    base_vol * (1.0 - t)
                }
            }
            _ => base_vol,
        }
    }

    /// Check if channel is playing - lock-free.
    pub fn is_playing(&self) -> bool {
        self.state.load(Ordering::Relaxed) == STATE_PLAYING
    }

    pub fn play(&self) {
        let prev = self.state.swap(STATE_PLAYING, Ordering::Relaxed);
        // If the channel had finished (STATE_STOPPED), reset position to
        // the beginning so playback restarts instead of immediately
        // hitting the end again.
        if prev == STATE_STOPPED {
            self.play_pos.store(0, Ordering::Relaxed);
        }
    }

    pub fn pause(&self) {
        let current = self.state.load(Ordering::Relaxed);
        if current == STATE_PLAYING {
            self.state.store(STATE_PAUSED, Ordering::Relaxed);
        }
    }

    pub fn stop(&self) {
        self.state.store(STATE_STOPPED, Ordering::Relaxed);
        self.play_pos.store(0, Ordering::Relaxed);
        self.fade_kind.store(FADE_NONE, Ordering::Relaxed);
    }

    pub fn set_volume(&self, vol: f32) {
        let clamped = vol.clamp(0.0, 1.0);
        self.volume
            .store((clamped * 1000.0) as u32, Ordering::Relaxed);
    }

    pub fn get_volume(&self) -> f32 {
        self.volume.load(Ordering::Relaxed) as f32 / 1000.0
    }

    pub fn start_fade_in(&self, duration: Duration) {
        let start_ms = self.created_at.elapsed().as_millis() as u32;
        self.fade_start_secs.store(start_ms, Ordering::Relaxed);
        self.fade_duration_secs
            .store(duration.as_millis() as u32, Ordering::Relaxed);
        self.fade_kind.store(FADE_IN, Ordering::Relaxed);
    }

    pub fn start_fade_out(&self, duration: Duration) {
        let start_ms = self.created_at.elapsed().as_millis() as u32;
        self.fade_start_secs.store(start_ms, Ordering::Relaxed);
        self.fade_duration_secs
            .store(duration.as_millis() as u32, Ordering::Relaxed);
        self.fade_kind.store(FADE_OUT, Ordering::Relaxed);
    }

    pub fn is_active(&self) -> bool {
        let s = self.state.load(Ordering::Relaxed);
        s == STATE_PLAYING || s == STATE_PAUSED
    }

    /// Get current playback position in seconds.
    pub fn position_secs(&self) -> f32 {
        let pos = self.play_pos.load(Ordering::Relaxed);
        pos as f32 / self.sample_rate as f32 / self.channels as f32
    }

    /// Seek to a position in seconds.
    pub fn seek_secs(&self, position_secs: f32) {
        let sample_pos = (position_secs * self.sample_rate as f32 * self.channels as f32) as usize;
        let total = self.samples.len();
        let clamped = sample_pos.min(total);
        self.play_pos.store(clamped, Ordering::Relaxed);
    }

    /// Get total duration in seconds.
    pub fn duration_secs(&self) -> f32 {
        let total_frames = self.samples.len() / self.channels as usize;
        total_frames as f32 / self.sample_rate as f32
    }

    /// Get the number of channels (always matches output device).
    pub fn channels(&self) -> u16 {
        self.channels
    }

    /// Get the current fade kind (0=none, 1=in, 2=out).
    pub fn fade_kind(&self) -> u8 {
        self.fade_kind.load(Ordering::Relaxed)
    }

    /// Get the fade duration in milliseconds.
    pub fn fade_duration_ms(&self) -> u32 {
        self.fade_duration_secs.load(Ordering::Relaxed)
    }

    /// Clear the fade (set to none).
    pub fn clear_fade(&self) {
        self.fade_kind.store(0, Ordering::Relaxed);
    }

    pub fn get_info(&self) -> ChannelInfo {
        ChannelInfo {
            id: self.id,
            name: self.name.clone(),
            kind: self.kind,
            state: ChannelState::from_u8(self.state.load(Ordering::Relaxed)),
            volume: self.get_volume(),
            loop_enabled: self.loop_enabled.load(Ordering::Relaxed),
            source_path: self.source_path.clone(),
            position_secs: self.position_secs(),
            duration_secs: self.duration_secs(),
        }
    }
}
