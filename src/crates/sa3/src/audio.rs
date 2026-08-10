use anyhow::Result;
use hound::{SampleFormat, WavSpec};
use ndarray::Array3;

use crate::config::{AUDIO_CHANNELS, SAMPLE_RATE};

pub fn load_audio(path: &str, target_duration: f32) -> Result<Array3<f32>> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| anyhow::anyhow!("Failed to open audio file '{}': {e}", path))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let file_sample_rate = spec.sample_rate;

    let samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            reader
                .samples::<i32>()
                .map(|s| {
                    let v = s.unwrap_or(0) as f32;
                    let max_val = 2i32.pow(bits as u32 - 1) as f32;
                    v / max_val
                })
                .collect()
        }
        SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
    };

    let n_frames = samples.len() / channels;
    let target_n_frames = (target_duration * SAMPLE_RATE as f32) as usize;

    let mut mono_samples = if channels == 1 {
        samples
    } else {
        let mut mono = Vec::with_capacity(n_frames);
        for i in 0..n_frames {
            let mut sum = 0.0f32;
            for c in 0..channels {
                sum += samples[i * channels + c];
            }
            mono.push(sum / channels as f32);
        }
        mono
    };

    if file_sample_rate != SAMPLE_RATE {
        let ratio = SAMPLE_RATE as f64 / file_sample_rate as f64;
        let new_len = (mono_samples.len() as f64 * ratio) as usize;
        let mut resampled = Vec::with_capacity(new_len);
        for i in 0..new_len {
            let src_idx = i as f64 / ratio;
            let idx0 = src_idx.floor() as usize;
            let frac = src_idx - idx0 as f64;
            let s0 = mono_samples.get(idx0).copied().unwrap_or(0.0);
            let s1 = mono_samples.get(idx0 + 1).copied().unwrap_or(0.0);
            resampled.push(s0 * (1.0 - frac as f32) + s1 * frac as f32);
        }
        mono_samples = resampled;
    }

    let n_frames_resampled = mono_samples.len();
    let final_len = n_frames_resampled.min(target_n_frames);
    let mut audio = Array3::zeros((1, AUDIO_CHANNELS, final_len));
    for i in 0..final_len {
        let v = mono_samples[i];
        audio[[0, 0, i]] = v;
        audio[[0, 1, i]] = v;
    }

    Ok(audio)
}

pub fn write_wav(path: &str, audio: &[f32], channels: u16, sample_rate: u32) -> Result<()> {
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut writer = hound::WavWriter::create(path, spec)?;
    for &sample in audio {
        let s = sample.clamp(-1.0, 1.0);
        let pcm = (s * 32767.0) as i16;
        writer.write_sample(pcm)?;
    }
    writer.finalize()?;

    Ok(())
}

pub fn audio_array_to_interleaved(audio: &ndarray::Array3<f32>, max_samples: usize) -> Vec<f32> {
    let channels = audio.shape()[1];
    let n_samples = audio.shape()[2].min(max_samples);
    let mut out = Vec::with_capacity(channels * n_samples);
    for s in 0..n_samples {
        for c in 0..channels {
            out.push(audio[[0, c, s]].clamp(-1.0, 1.0));
        }
    }
    out
}

pub fn save_audio(path: &str, audio: &ndarray::Array3<f32>, duration_secs: f32) -> Result<()> {
    let max_samples = (duration_secs * SAMPLE_RATE as f32) as usize;
    let channels = audio.shape()[1] as u16;
    let interleaved = audio_array_to_interleaved(audio, max_samples);
    write_wav(path, &interleaved, channels, SAMPLE_RATE)?;
    Ok(())
}
