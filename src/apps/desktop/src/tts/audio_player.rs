const DEBUG_LOG_TTS_AUDIO: bool = false;
macro_rules! debug_print {
    ($($arg:tt)*) => {
        if DEBUG_LOG_TTS_AUDIO {
            eprintln!($($arg)*);
        }
    };
}

use super::audio_buffer::AudioBuffer;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const PREBUFFER_FRAMES: usize = 2400;

pub struct AudioPlayer {
    buffer: Arc<AudioBuffer>,
    stream: Option<Stream>,
    playing: AtomicBool,
    source_sample_rate: u32,
    target_sample_rate: u32,
    prebuffer_ready: bool,
    frames_played: usize,
}

impl AudioPlayer {
    pub fn new(buffer: Arc<AudioBuffer>) -> Self {
        Self {
            buffer,
            stream: None,
            playing: AtomicBool::new(false),
            source_sample_rate: 24000,
            target_sample_rate: 48000,
            prebuffer_ready: false,
            frames_played: 0,
        }
    }

    pub fn set_sample_rates(&mut self, source: u32, target: u32) -> Result<(), String> {
        self.source_sample_rate = source;
        self.target_sample_rate = target;
        Ok(())
    }

    fn linear_resample(input: &[f32], output_len: usize) -> Vec<f32> {
        if input.is_empty() || output_len == 0 {
            return vec![0.0; output_len];
        }

        let mut output = Vec::with_capacity(output_len);
        let ratio = input.len() as f64 / output_len as f64;

        for i in 0..output_len {
            let src_pos = i as f64 * ratio;
            let src_idx = src_pos as usize;
            let frac = src_pos - src_idx as f64;

            let s0 = input.get(src_idx.saturating_sub(1)).copied().unwrap_or(0.0);
            let s1 = input.get(src_idx).copied().unwrap_or(0.0);
            let s2 = input.get(src_idx + 1).copied().unwrap_or(0.0);
            let s3 = input.get(src_idx + 2).copied().unwrap_or(0.0);

            let t = frac as f32;
            let t2 = t * t;
            let t3 = t2 * t;

            let sample = 0.5
                * ((2.0 * s1)
                    + (-s0 + s2) * t
                    + (2.0 * s0 - 5.0 * s1 + 4.0 * s2 - s3) * t2
                    + (-s0 + 3.0 * s1 - 3.0 * s2 + s3) * t3);
            output.push(sample);
        }

        output
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.playing.load(Ordering::Relaxed) {
            return Ok(());
        }

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or("No default output device found")?;

        let supported_config = device
            .default_output_config()
            .map_err(|e| format!("Failed to get default output config: {}", e))?;

        let sample_format = supported_config.sample_format();
        let config: StreamConfig = supported_config.into();

        let buffer = self.buffer.clone();
        let playing = Arc::new(AtomicBool::new(true));
        let playing_clone = playing.clone();

        let stream = match sample_format {
            SampleFormat::F32 => self.build_stream::<f32>(&device, &config, buffer, playing_clone),
            SampleFormat::I16 => self.build_stream::<i16>(&device, &config, buffer, playing_clone),
            SampleFormat::U16 => self.build_stream::<u16>(&device, &config, buffer, playing_clone),
            _ => return Err("Unsupported sample format".to_string()),
        }?;

        stream
            .play()
            .map_err(|e| format!("Failed to play stream: {}", e))?;
        self.stream = Some(stream);
        self.playing.store(true, Ordering::Relaxed);
        self.prebuffer_ready = false;
        self.frames_played = 0;

        debug_print!("[AudioPlayer] Started, waiting for prebuffer...");

        Ok(())
    }

    fn build_stream<T>(
        &self,
        device: &Device,
        config: &StreamConfig,
        buffer: Arc<AudioBuffer>,
        playing: Arc<AtomicBool>,
    ) -> Result<Stream, String>
    where
        T: cpal::Sample + cpal::SizedSample + cpal::FromSample<f32>,
    {
        let channels = config.channels as usize;
        let target_sr = self.target_sample_rate;
        let prebuffer_ready = Arc::new(AtomicBool::new(false));
        let _prebuffer_ready_clone = prebuffer_ready.clone();
        let _frames_until_ready = PREBUFFER_FRAMES;

        device
            .build_output_stream(
                config,
                move |output: &mut [T], _: &cpal::OutputCallbackInfo| {
                    if !playing.load(Ordering::Relaxed) {
                        for sample in output.iter_mut() {
                            *sample = T::from_sample(0.0);
                        }
                        return;
                    }

                    let frames_needed = output.len() / channels;
                    let source_sr = 24000u32;
                    let frames_to_read = frames_needed * source_sr as usize / target_sr as usize;
                    let mut source_frames = vec![0.0f32; frames_to_read];

                    let read_count = buffer.read(&mut source_frames);
                    if read_count == 0 {
                        for sample in output.iter_mut() {
                            *sample = T::from_sample(0.0);
                        }
                        return;
                    }

                    let source_frames = &source_frames[..read_count];

                    let final_frames = if target_sr != 24000 {
                        Self::linear_resample(source_frames, frames_needed)
                    } else {
                        source_frames.to_vec()
                    };

                    for (i, sample) in output.iter_mut().enumerate() {
                        let frame_idx = i / channels;
                        let value = if frame_idx < final_frames.len() {
                            final_frames[frame_idx]
                        } else {
                            0.0
                        };
                        *sample = T::from_sample(value);
                    }
                },
                |err| debug_print!("Audio stream error: {}", err),
                None,
            )
            .map_err(|e| format!("Failed to build output stream: {}", e))
    }

    pub fn stop(&mut self) {
        self.playing.store(false, Ordering::Relaxed);
        if let Some(stream) = self.stream.take() {
            drop(stream);
        }
        self.buffer.clear();
        self.prebuffer_ready = false;
        self.frames_played = 0;
    }

    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }
}
