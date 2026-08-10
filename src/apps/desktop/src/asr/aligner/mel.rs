//! Log-mel spectrogram extraction — ported from
//! `参考/qwen3-asr.cpp/src/mel_spectrogram.cpp`.
//!
//! Constants match the Qwen3-ASR / Whisper frontend:
//! - sample rate: 16 kHz
//! - N_FFT: 400 (25 ms window)
//! - hop: 160 (10 ms frame step)
//! - n_mels: 128
//!
//! Pipeline: Hann window (periodic) → reflect padding (center=True) →
//! power FFT → mel filterbank (HTK mel scale, Slaney normalization) →
//! log10 → clamp/normalize (max-8 floor, then `(x+4)/4`).

use rustfft::{num_complex::Complex, FftPlanner};

use super::model::HParams;

/// Mel filterbank: `[n_mel, n_fft_bins]` row-major (n_fft_bins = 1 + N_FFT/2 = 201).
pub struct MelFilters {
    pub n_mel: usize,
    pub n_fft: usize, // = n_fft_bins (201), NOT N_FFT (400)
    pub data: Vec<f32>,
}

/// Mel spectrogram output: `[n_mel, n_len]` mel-major (`data[m*n_len + t]`).
pub struct MelSpectrogram {
    pub n_mel: usize,
    pub n_len: usize,
    pub data: Vec<f32>,
}

const SAMPLE_RATE: i32 = 16_000;
const N_FFT: usize = 400;
const HOP_LENGTH: usize = 160;
const N_MELS: usize = 128;

#[inline]
fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

#[inline]
fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10.0_f32.powf(mel / 2595.0) - 1.0)
}

/// Generate mel filterbank programmatically (HTK mel scale + Slaney norm).
/// Matches `generate_mel_filters` in mel_spectrogram.cpp.
pub fn generate_mel_filters() -> MelFilters {
    let n_fft_bins = 1 + N_FFT / 2; // 201
    let fmax = SAMPLE_RATE as f32 / 2.0; // Nyquist
    let fmin = 0.0_f32;

    let mel_min = hz_to_mel(fmin);
    let mel_max = hz_to_mel(fmax);

    // n_mels + 2 equally-spaced points in mel scale.
    let mut mel_points = vec![0.0_f32; N_MELS + 2];
    for (i, item) in mel_points.iter_mut().enumerate().take(N_MELS + 2) {
        *item = mel_min + (mel_max - mel_min) * i as f32 / (N_MELS + 1) as f32;
    }
    let hz_points: Vec<f32> = mel_points.iter().map(|&m| mel_to_hz(m)).collect();
    let bin_points: Vec<f32> = hz_points
        .iter()
        .map(|&h| (N_FFT as f32 + 1.0) * h / SAMPLE_RATE as f32)
        .collect();

    let mut data = vec![0.0_f32; N_MELS * n_fft_bins];
    for m in 0..N_MELS {
        let left = bin_points[m];
        let center = bin_points[m + 1];
        let right = bin_points[m + 2];
        for k in 0..n_fft_bins {
            let weight = if (k as f32) >= left && (k as f32) <= center && center > left {
                ((k as f32) - left) / (center - left)
            } else if (k as f32) >= center && (k as f32) <= right && right > center {
                (right - (k as f32)) / (right - center)
            } else {
                0.0
            };
            data[m * n_fft_bins + k] = weight;
        }
    }

    // Slaney normalization: 2 / (hz[m+2] - hz[m]).
    for m in 0..N_MELS {
        let enorm = 2.0 / (hz_points[m + 2] - hz_points[m]);
        for k in 0..n_fft_bins {
            data[m * n_fft_bins + k] *= enorm;
        }
    }

    MelFilters {
        n_mel: N_MELS,
        n_fft: n_fft_bins,
        data,
    }
}

/// Periodic Hann window of length `n` (matches `fill_hann_window(n, true, …)`).
fn hann_window_periodic(n: usize) -> Vec<f32> {
    let mut w = vec![0.0_f32; n];
    // periodic: offset=0 → 0.5 * (1 - cos(2*pi*i / n))
    for (i, item) in w.iter_mut().enumerate().take(n) {
        *item = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos());
    }
    w
}

/// Compute log-mel spectrogram.
///
/// Returns a [`MelSpectrogram`] with `n_mel=128` mels and `n_len` frames.
pub fn log_mel_spectrogram(samples: &[f32], _hp: &HParams) -> Result<MelSpectrogram, String> {
    let filters = generate_mel_filters();
    let n_fft_bins = filters.n_fft; // 201

    // ---- Reflect-padding (center=True): N_FFT/2 on each side ----
    let pad = N_FFT / 2;
    let mut padded = vec![0.0_f32; samples.len() + 2 * pad];
    padded[pad..pad + samples.len()].copy_from_slice(samples);
    // Left reflect: src_idx = pad - i for i in 0..pad, clamped to 0 if out of range.
    for (i, item) in padded.iter_mut().enumerate().take(pad) {
        let src = pad as isize - i as isize;
        *item = if src >= 0 && (src as usize) < samples.len() {
            samples[src as usize]
        } else {
            0.0
        };
    }
    // Right reflect: src_idx = n_samples - 2 - i for i in 0..pad.
    for i in 0..pad {
        let src = samples.len() as isize - 2 - i as isize;
        padded[pad + samples.len() + i] = if src >= 0 && (src as usize) < samples.len() {
            samples[src as usize]
        } else {
            0.0
        };
    }

    let total_frames = (padded.len().saturating_sub(N_FFT)) / HOP_LENGTH + 1;
    // C++ uses n_len = total_frames - 1 (drops the last partial frame).
    let n_len = total_frames.saturating_sub(1);

    let hann = hann_window_periodic(N_FFT);

    // ---- FFT setup ----
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let mut buf = vec![Complex { re: 0.0, im: 0.0 }; N_FFT];

    // temp_data[mel * compute_frames + frame] (double precision, like C++).
    let compute_frames = total_frames;
    let mut temp = vec![0.0_f64; N_MELS * compute_frames];

    for i in 0..compute_frames {
        let offset = i * HOP_LENGTH;
        // Apply Hann window (zero-pad if frame overruns the padded signal).
        for j in 0..N_FFT {
            let s = if offset + j < padded.len() {
                padded[offset + j]
            } else {
                0.0
            };
            buf[j] = Complex {
                re: hann[j] * s,
                im: 0.0,
            };
        }
        fft.process(&mut buf);

        // Power spectrum (first n_fft_bins=201 bins).
        let mut power = vec![0.0_f64; n_fft_bins];
        for j in 0..n_fft_bins {
            power[j] = buf[j].re as f64 * buf[j].re as f64 + buf[j].im as f64 * buf[j].im as f64;
        }

        // Mel filterbank: dot product + log10.
        for m in 0..N_MELS {
            let mut sum = 0.0_f64;
            let frow = &filters.data[m * n_fft_bins..(m + 1) * n_fft_bins];
            for k in 0..n_fft_bins {
                sum += power[k] * frow[k] as f64;
            }
            temp[m * compute_frames + i] = sum.max(1e-10).log10();
        }
    }

    // ---- Clamp + normalize (double precision) ----
    let mut mmax = -1e20_f64;
    for m in 0..N_MELS {
        for i in 0..n_len {
            let v = temp[m * compute_frames + i];
            if v > mmax {
                mmax = v;
            }
        }
    }
    mmax -= 8.0;

    let mut data = vec![0.0_f32; N_MELS * n_len];
    for m in 0..N_MELS {
        for i in 0..n_len {
            let mut v = temp[m * compute_frames + i];
            if v < mmax {
                v = mmax;
            }
            v = (v + 4.0) / 4.0;
            data[m * n_len + i] = v as f32;
        }
    }

    Ok(MelSpectrogram {
        n_mel: N_MELS,
        n_len,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mel_filters_shape() {
        let f = generate_mel_filters();
        assert_eq!(f.n_mel, 128);
        assert_eq!(f.n_fft, 201);
        assert_eq!(f.data.len(), 128 * 201);
    }

    #[test]
    fn test_hann_window() {
        let w = hann_window_periodic(4);
        // w[0] = 0, w[1] = 0.5*(1-cos(pi/2)) = 0.5, w[2] = 0.5*(1-cos(pi)) = 1, w[3] = 0.5*(1-cos(3pi/2)) = 0.5
        assert!(w[0].abs() < 1e-6);
        assert!((w[1] - 0.5).abs() < 1e-6);
        assert!((w[2] - 1.0).abs() < 1e-6);
        assert!((w[3] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn test_log_mel_basic() {
        // 1 second of silence at 16 kHz.
        let samples = vec![0.0_f32; 16_000];
        let hp = HParams::default();
        let mel = log_mel_spectrogram(&samples, &hp).unwrap();
        assert_eq!(mel.n_mel, 128);
        // n_len = ((16000 + 400 - 160) / 160 + 1) - 1 = 100 + 1 - 1 = 100
        // Actually: padded = 16000 + 400 = 16400; total_frames = (16400-400)/160+1 = 100+1 = 101; n_len = 100.
        assert_eq!(mel.n_len, 100);
    }
}
