use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};

fn append_interleaved(samples: &Arc<Mutex<Vec<f32>>>, data: &[f32], channels: usize) {
    if channels == 0 {
        return;
    }
    if let Ok(mut guard) = samples.lock() {
        if channels == 1 {
            guard.extend_from_slice(data);
            return;
        }
        for frame in data.chunks(channels) {
            let sum: f32 = frame.iter().copied().sum();
            guard.push(sum / channels as f32);
        }
    }
}

pub struct AudioCaptureSession {
    sample_rate: u32,
    samples: Arc<Mutex<Vec<f32>>>,
    stream: Option<cpal::Stream>,
}

impl AudioCaptureSession {
    pub fn start_default_input() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No default input device found".to_string())?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get default input config: {}", e))?;
        let sample_rate = config.sample_rate();
        let channels = config.channels() as usize;
        let stream_config: cpal::StreamConfig = config.clone().into();
        let samples = Arc::new(Mutex::new(Vec::new()));
        let samples_for_stream = Arc::clone(&samples);
        let err_fn = |err| {
            log::error!("[AudioCapture] stream error: {}", err);
        };

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _| append_interleaved(&samples_for_stream, data, channels),
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build f32 input stream: {}", e))?,
            cpal::SampleFormat::I16 => {
                let samples_for_stream = Arc::clone(&samples);
                device
                    .build_input_stream(
                        &stream_config,
                        move |data: &[i16], _| {
                            let converted: Vec<f32> =
                                data.iter().map(|v| *v as f32 / i16::MAX as f32).collect();
                            append_interleaved(&samples_for_stream, &converted, channels);
                        },
                        err_fn,
                        None,
                    )
                    .map_err(|e| format!("Failed to build i16 input stream: {}", e))?
            }
            cpal::SampleFormat::U16 => {
                let samples_for_stream = Arc::clone(&samples);
                device
                    .build_input_stream(
                        &stream_config,
                        move |data: &[u16], _| {
                            let converted: Vec<f32> = data
                                .iter()
                                .map(|v| (*v as f32 / u16::MAX as f32) * 2.0 - 1.0)
                                .collect();
                            append_interleaved(&samples_for_stream, &converted, channels);
                        },
                        err_fn,
                        None,
                    )
                    .map_err(|e| format!("Failed to build u16 input stream: {}", e))?
            }
            _ => return Err("Unsupported input sample format".to_string()),
        };

        stream
            .play()
            .map_err(|e| format!("Failed to start input stream: {}", e))?;

        Ok(Self {
            sample_rate,
            samples,
            stream: Some(stream),
        })
    }

    pub fn stop_and_take_samples(&mut self) -> Result<Vec<f32>, String> {
        let _ = self.stream.take();
        let mut guard = self
            .samples
            .lock()
            .map_err(|_| "Failed to lock captured samples".to_string())?;
        let mut captured = std::mem::take(&mut *guard);
        if captured.is_empty() {
            return Ok(captured);
        }
        for sample in &mut captured {
            *sample = sample.clamp(-1.0, 1.0);
        }
        if self.sample_rate != 16000 {
            captured = resample_to_16k(&captured, self.sample_rate);
        }
        // 采集诊断日志：RMS/峰值用于判断静音、削波、电平异常（ASR 排障）
        let n = captured.len();
        let sum_sq: f64 = captured.iter().map(|s| (*s as f64) * (*s as f64)).sum();
        let rms = (sum_sq / n.max(1) as f64).sqrt();
        let peak = captured.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        log::info!(
            "[AudioCapture] captured: samples={} (~{}ms @16k), rms={:.4}, peak={:.4}",
            n,
            n * 1000 / 16000,
            rms,
            peak
        );
        Ok(captured)
    }
}

/// 降采样到 16kHz，带抗混叠处理：
/// 1. 先做简单 FIR 低通（截止 ~7.2kHz，过渡带覆盖到 8kHz Nyquist），
///    阻止 >8kHz 能量混叠进语音频带（纯线性插值降采样会破坏 mel 特征，
///    曾导致 ASR 幻觉循环输出）
/// 2. 再线性插值到目标速率
fn resample_to_16k(samples: &[f32], source_rate: u32) -> Vec<f32> {
    if source_rate == 16000 || samples.is_empty() {
        return samples.to_vec();
    }

    // 低通滤波（仅当源采样率 > 16k 时有意义）
    let filtered: Vec<f32> = if source_rate > 16000 {
        // 31 抽头汉明窗 sinc 低通；cutoff 为相对源 Nyquist 的归一化频率
        // （如 48k → 0.15 ≈ 7.2kHz 截止），压制 >8kHz 混叠
        let cutoff = 0.45 * 16000.0 / source_rate as f64;
        let taps = design_lowpass(cutoff, 31);
        fir_filter(samples, &taps)
    } else {
        samples.to_vec()
    };

    let ratio = 16000.0 / source_rate as f64;
    let output_len = (filtered.len() as f64 * ratio) as usize;
    let mut output = Vec::with_capacity(output_len);
    for i in 0..output_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f64;
        if idx + 1 < filtered.len() {
            output.push(
                (filtered[idx] as f64 * (1.0 - frac) + filtered[idx + 1] as f64 * frac) as f32,
            );
        } else {
            output.push(filtered[filtered.len() - 1]);
        }
    }
    output
}

/// 设计归一化截止频率（0..0.5，相对源采样率）的汉明窗 sinc 低通 FIR。
fn design_lowpass(cutoff: f64, taps: usize) -> Vec<f64> {
    let m = taps as i64 - 1;
    let center = m as f64 / 2.0;
    let mut h = Vec::with_capacity(taps);
    let mut sum = 0.0;
    for n in 0..taps {
        let t = n as f64 - center;
        let sinc = if t.abs() < 1e-12 {
            2.0 * cutoff
        } else {
            (2.0 * cutoff * std::f64::consts::PI * t).sin() / (std::f64::consts::PI * t)
        };
        let window = 0.54 - 0.46 * (2.0 * std::f64::consts::PI * n as f64 / m as f64).cos();
        let v = sinc * window;
        sum += v;
        h.push(v);
    }
    // 归一化直流增益为 1
    for v in &mut h {
        *v /= sum;
    }
    h
}

fn fir_filter(samples: &[f32], taps: &[f64]) -> Vec<f32> {
    if samples.is_empty() || taps.is_empty() {
        return samples.to_vec();
    }
    let n_taps = taps.len();
    let mut out = vec![0.0f32; samples.len()];
    for (i, out_i) in out.iter_mut().enumerate() {
        let mut acc = 0.0f64;
        let start = i as i64 - (n_taps as i64 - 1) / 2;
        for (k, tap) in taps.iter().enumerate() {
            let idx = start + k as i64;
            if idx >= 0 && (idx as usize) < samples.len() {
                acc += samples[idx as usize] as f64 * tap;
            }
        }
        *out_i = acc as f32;
    }
    out
}
