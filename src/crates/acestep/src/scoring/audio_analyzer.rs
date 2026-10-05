//! Pure-Rust audio signal analysis for quality scoring.
//!
//! Reads a WAV file via `hound`, downmixes to mono, and computes 5
//! objective quality metrics without any external Python dependency:
//!
//! 1. **Loudness** — RMS-based LUFS estimate, scored against -23..-14 LUFS.
//! 2. **Dynamic range** — Peak-to-RMS ratio in dB; penalises over-compression.
//! 3. **Clipping** — Fraction of samples at or above 0.99 amplitude.
//! 4. **Tempo stability** — Autocorrelation-based BPM confidence.
//! 5. **Spectral balance** — Low/mid/high band energy distribution via FFT.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use hound::WavReader;
use rustfft::{num_complex::Complex, FftPlanner};

use super::AudioScore;

/// Clipping threshold (linear amplitude). Samples at or above this are
/// considered clipped.
const CLIP_THRESHOLD: f32 = 0.99;

/// Target LUFS range — scores 100 when within this band.
const LUFS_MIN: f32 = -23.0;
const LUFS_MAX: f32 = -14.0;

/// Healthy dynamic range in dB. Below 6 dB suggests over-compression;
/// above 18 dB is excessively dynamic for generated music.
const DR_MIN_DB: f32 = 6.0;
const DR_MAX_DB: f32 = 18.0;

/// Frequency band boundaries (Hz).
const LOW_BAND: f32 = 250.0;
const MID_BAND: f32 = 4000.0;
const HIGH_BAND: f32 = 20000.0;

/// FFT window size (samples). 4096 gives ~10 Hz resolution at 44.1 kHz.
const FFT_SIZE: usize = 4096;

/// Analyze a WAV file and return per-dimension scores (each 0-100).
pub fn analyze(path: &Path) -> Result<AudioScore> {
    let (samples, sample_rate) = read_wav_mono(path)?;
    if samples.is_empty() {
        return Err(anyhow!(
            "Audio file contains no samples: {}",
            path.display()
        ));
    }

    log::debug!(
        "[scoring] analyzing {} samples at {} Hz",
        samples.len(),
        sample_rate
    );

    let loudness = score_loudness(&samples);
    let dynamic_range = score_dynamic_range(&samples);
    let clipping = score_clipping(&samples);
    let tempo_stability = score_tempo_stability(&samples, sample_rate);
    let spectral_balance = score_spectral_balance(&samples, sample_rate);

    log::debug!(
        "[scoring] loudness={:.1} dynamic_range={:.1} clipping={:.1} tempo={:.1} spectral={:.1}",
        loudness,
        dynamic_range,
        clipping,
        tempo_stability,
        spectral_balance
    );

    Ok(AudioScore {
        loudness,
        dynamic_range,
        clipping,
        tempo_stability,
        spectral_balance,
    })
}

/// Read a WAV file and downmix to mono float samples in [-1, 1].
fn read_wav_mono(path: &Path) -> Result<(Vec<f32>, u32)> {
    let reader = WavReader::open(path).context("Failed to open WAV file")?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let sample_rate = spec.sample_rate;

    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let scale = match spec.bits_per_sample {
                8 => 128.0,
                16 => 32768.0,
                24 => 8388608.0,
                32 => 2147483648.0,
                bits => return Err(anyhow!("Unsupported integer bit depth: {} bits", bits)),
            };
            reader
                .into_samples::<i32>()
                .filter_map(|s| s.ok())
                .map(|s| s as f32 / scale)
                .collect()
        }
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .filter_map(|s| s.ok())
            .collect(),
    };

    // Downmix to mono by averaging channels.
    let mono = if channels > 1 {
        downmix(&samples, channels)
    } else {
        samples
    };

    Ok((mono, sample_rate))
}

/// Average N interleaved channels into a single mono channel.
fn downmix(samples: &[f32], channels: usize) -> Vec<f32> {
    let n_frames = samples.len() / channels;
    let mut mono = Vec::with_capacity(n_frames);
    for frame in samples.chunks_exact(channels) {
        let avg = frame.iter().sum::<f32>() / channels as f32;
        mono.push(avg);
    }
    mono
}

// ---------------------------------------------------------------------------
// Scoring functions
// ---------------------------------------------------------------------------

/// Estimate LUFS (simplified: RMS dBFS - 0.691 offset) and score against
/// the -23..-14 target band. Full ITU-R BS.1770 K-weighting is omitted
/// for simplicity; the offset gives a reasonable approximation for
/// solo-generated music.
fn score_loudness(samples: &[f32]) -> f32 {
    let mean_square = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    if mean_square <= 0.0 {
        return 0.0;
    }
    let rms_dbfs = 10.0 * mean_square.log10();
    let lufs = rms_dbfs - 0.691;

    if (LUFS_MIN..=LUFS_MAX).contains(&lufs) {
        100.0
    } else {
        // Linear falloff: 10 points per dB outside the range.
        let distance = if lufs < LUFS_MIN {
            LUFS_MIN - lufs
        } else {
            lufs - LUFS_MAX
        };
        (100.0 - distance * 10.0).max(0.0)
    }
}

/// Score dynamic range based on peak-to-RMS ratio in dB.
/// Healthy range is 6-18 dB; over-compression (< 6 dB) is penalised.
fn score_dynamic_range(samples: &[f32]) -> f32 {
    let peak = samples.iter().fold(0.0f32, |a, &s| a.max(s.abs()));
    if peak <= 0.0 {
        return 0.0;
    }
    let mean_square = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    if mean_square <= 0.0 {
        return 0.0;
    }
    let rms = mean_square.sqrt();
    let dr_db = 20.0 * (peak / rms).log10();

    if (DR_MIN_DB..=DR_MAX_DB).contains(&dr_db) {
        100.0
    } else if dr_db < DR_MIN_DB {
        // Over-compressed: penalise heavily.
        (100.0 - (DR_MIN_DB - dr_db) * 8.0).max(0.0)
    } else {
        // Excessively dynamic: mild penalty.
        (100.0 - (dr_db - DR_MAX_DB) * 3.0).max(0.0)
    }
}

/// Detect clipping: fraction of samples at or above the threshold.
/// Returns 100 when no clipping, decreasing as clipping increases.
fn score_clipping(samples: &[f32]) -> f32 {
    let clipped = samples
        .iter()
        .filter(|&&s| s.abs() >= CLIP_THRESHOLD)
        .count();
    let fraction = clipped as f32 / samples.len() as f32;
    // Even 0.1% clipping is significant; 1% is severe.
    (100.0 - fraction * 10000.0).max(0.0)
}

/// Estimate tempo stability via autocorrelation on the RMS energy envelope.
///
/// 原实现直接对原始波形做自相关并按 `corr/energy` 归一——多谐波音乐波形
/// 的归一化峰值只有 0.02-0.05，映射后恒为个位数（bug）。正确做法：
/// 先取 RMS 包络（~23ms/帧，分离出节拍尺度的能量起伏），去均值后做
/// 包络自相关，再按 lag=0 能量归一；周期性节拍在 60-180 BPM 的 lag 上
/// 会给出 0.3-0.7 的峰值 → 60-100 分。计算量也从 O(samples×lags)
/// 降为 O(envelope×lags)（约低 3 个数量级）。
fn score_tempo_stability(samples: &[f32], sample_rate: u32) -> f32 {
    const BPM_MIN: f32 = 60.0;
    const BPM_MAX: f32 = 180.0;

    // 1. RMS energy envelope (~23ms per frame).
    let frame_len = ((sample_rate as f32) * 0.023).max(1.0) as usize;
    let envelope: Vec<f32> = samples
        .chunks(frame_len)
        .map(|c| (c.iter().map(|x| x * x).sum::<f32>() / c.len().max(1) as f32).sqrt())
        .collect();
    if envelope.len() < 8 {
        return 50.0; // Not enough data for reliable tempo estimation.
    }

    // 2. Zero-mean (DC removal) so the autocorrelation measures periodicity.
    let mean = envelope.iter().sum::<f32>() / envelope.len() as f32;
    let env: Vec<f32> = envelope.iter().map(|x| x - mean).collect();

    // 3. Lag range in envelope frames for 60-180 BPM.
    let env_rate = (sample_rate as f32) / frame_len as f32;
    let min_lag = ((1.0 / BPM_MAX) * env_rate).floor().max(1.0) as usize;
    let max_lag = ((1.0 / BPM_MIN) * env_rate).ceil() as usize;
    if env.len() < max_lag + 1 {
        return 50.0;
    }

    // 4. Autocorrelation normalized by the lag-0 energy.
    let energy0: f32 = env.iter().map(|x| x * x).sum();
    if energy0 <= f32::EPSILON {
        return 50.0; // Flat envelope (silence/drone) — no tempo to speak of.
    }
    let mut best_corr: f32 = 0.0;
    for lag in min_lag..=max_lag {
        let corr: f32 = env[lag..]
            .iter()
            .zip(env.iter())
            .map(|(a, b)| a * b)
            .sum::<f32>()
            / (env.len() - lag) as f32;
        let normalized = corr / (energy0 / env.len() as f32);
        if normalized > best_corr {
            best_corr = normalized;
        }
    }

    // Peak normalized autocorrelation of a steady beat lands in ~0.3-0.8;
    // map so 0.5 → 100, consistent with the original design intent.
    (best_corr * 200.0).clamp(0.0, 100.0)
}

/// Score spectral balance using FFT-based frequency band analysis.
/// Computes low/mid/high band energy and rewards balanced distribution.
fn score_spectral_balance(samples: &[f32], sample_rate: u32) -> f32 {
    if samples.len() < FFT_SIZE {
        return 50.0; // Not enough data for spectral analysis.
    }

    let mut fft_planner = FftPlanner::<f32>::new();
    let fft = fft_planner.plan_fft_forward(FFT_SIZE);

    // Analyse up to 10 windows spread across the audio, then average.
    const NUM_WINDOWS: usize = 10;
    let hop = if samples.len() > FFT_SIZE {
        (samples.len() - FFT_SIZE) / NUM_WINDOWS
    } else {
        0
    };

    let mut low_energy: f32 = 0.0;
    let mut mid_energy: f32 = 0.0;
    let mut high_energy: f32 = 0.0;
    let mut windows_analysed: usize = 0;

    for w in 0..=NUM_WINDOWS {
        let start = w * hop;
        if start + FFT_SIZE > samples.len() {
            break;
        }

        let mut buffer: Vec<Complex<f32>> = samples[start..start + FFT_SIZE]
            .iter()
            .enumerate()
            .map(|(i, &s)| {
                // Hann window to reduce spectral leakage.
                let window =
                    0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos());
                Complex::new(s * window, 0.0)
            })
            .collect();

        fft.process(&mut buffer);

        // Compute band energies from the first half of the spectrum.
        let nyquist = sample_rate as f32 / 2.0;
        let bin_hz = nyquist / (FFT_SIZE / 2) as f32;
        let low_bin = (LOW_BAND / bin_hz) as usize;
        let mid_bin = (MID_BAND / bin_hz) as usize;
        let high_bin = (HIGH_BAND / bin_hz).min(FFT_SIZE as f32 / 2.0) as usize;

        for (i, c) in buffer.iter().take(high_bin + 1).enumerate() {
            let mag = c.norm() * c.norm(); // power
            if i <= low_bin {
                low_energy += mag;
            } else if i <= mid_bin {
                mid_energy += mag;
            } else {
                high_energy += mag;
            }
        }
        windows_analysed += 1;
    }

    if windows_analysed == 0 {
        return 50.0;
    }

    // Average over windows.
    let n = windows_analysed as f32;
    low_energy /= n;
    mid_energy /= n;
    high_energy /= n;

    let total = low_energy + mid_energy + high_energy;
    if total <= 0.0 {
        return 0.0;
    }

    // Ideal distribution: low ~30%, mid ~50%, high ~20%.
    // Score based on how close the actual distribution is to the ideal.
    let low_frac = low_energy / total;
    let mid_frac = mid_energy / total;
    let high_frac = high_energy / total;

    let low_dev = (low_frac - 0.30).abs();
    let mid_dev = (mid_frac - 0.50).abs();
    let high_dev = (high_frac - 0.20).abs();

    let total_dev = low_dev + mid_dev + high_dev;
    // total_dev ranges [0, 2]; map to [0, 100].
    ((1.0 - total_dev / 2.0) * 100.0).clamp(0.0, 100.0)
}
