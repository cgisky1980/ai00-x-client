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
        Ok(captured)
    }
}

fn resample_to_16k(samples: &[f32], source_rate: u32) -> Vec<f32> {
    if source_rate == 16000 || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = 16000.0 / source_rate as f64;
    let output_len = (samples.len() as f64 * ratio) as usize;
    let mut output = Vec::with_capacity(output_len);
    for i in 0..output_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f64;
        if idx + 1 < samples.len() {
            output
                .push((samples[idx] as f64 * (1.0 - frac) + samples[idx + 1] as f64 * frac) as f32);
        } else {
            output.push(samples[samples.len() - 1]);
        }
    }
    output
}
