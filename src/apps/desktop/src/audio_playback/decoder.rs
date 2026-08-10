use std::path::Path;

use anyhow::{anyhow, Result};
use rubato::{Async, FixedAsync, PolynomialDegree, Resampler};

/// Decode an audio file to interleaved f32 PCM samples.
/// Returns (samples, sample_rate, channels)
pub fn decode_audio_file(path: &Path) -> Result<(Vec<f32>, u32, u16)> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "wav" {
        decode_wav(path)
    } else {
        decode_symphonia(path)
    }
}

fn decode_wav(path: &Path) -> Result<(Vec<f32>, u32, u16)> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| anyhow!("Failed to open WAV file '{}': {}", path.display(), e))?;

    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels;

    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.unwrap_or(0.0).clamp(-1.0, 1.0))
            .collect(),
        hound::SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            let max_val = if bits > 0 {
                (1i64 << (bits - 1)) as f32
            } else {
                32768.0
            };
            reader
                .samples::<i32>()
                .map(|s| {
                    let v = s.unwrap_or(0);
                    (v as f32 / max_val).clamp(-1.0, 1.0)
                })
                .collect()
        }
    };

    Ok((samples, sample_rate, channels))
}

fn decode_symphonia(path: &Path) -> Result<(Vec<f32>, u32, u16)> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::errors::Error;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let src = std::fs::File::open(path)
        .map_err(|e| anyhow!("Failed to open file '{}': {}", path.display(), e))?;

    let mss = MediaSourceStream::new(Box::new(src), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension() {
        if let Some(ext_str) = ext.to_str() {
            hint.with_extension(ext_str);
        }
    }

    let meta_opts: MetadataOptions = Default::default();
    let fmt_opts: FormatOptions = Default::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .map_err(|e| anyhow!("Unsupported format: {}", e))?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("No supported audio tracks"))?;

    let dec_opts: DecoderOptions = Default::default();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &dec_opts)
        .map_err(|e| anyhow!("Unsupported codec: {}", e))?;

    let track_id = track.id;

    let mut samples: Vec<f32> = Vec::new();
    let mut sample_rate: u32 = 0;
    let mut channels: u16 = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(anyhow!("Failed to read packet: {}", e)),
        };

        while !format.metadata().is_latest() {
            format.metadata().pop();
        }

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                if sample_rate == 0 {
                    sample_rate = decoded.spec().rate;
                    channels = decoded.spec().channels.count() as u16;
                }

                let spec = *decoded.spec();
                let duration = decoded.capacity() as u64;

                let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);
                sample_buf.copy_interleaved_ref(decoded);

                let buf_samples = sample_buf.samples();
                // Keep multi-channel interleaved format (do NOT mix to mono)
                samples.extend_from_slice(buf_samples);
            }
            Err(Error::IoError(_)) => continue,
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow!("Failed to decode packet: {}", e)),
        }
    }

    if sample_rate == 0 {
        return Err(anyhow!("No audio data decoded"));
    }

    Ok((samples, sample_rate, channels))
}

/// Resample audio to target sample rate using rubato.
/// Input and output are interleaved f32 PCM.
pub fn resample_audio(samples: &[f32], from_sr: u32, to_sr: u32, channels: u16) -> Vec<f32> {
    if from_sr == to_sr || samples.is_empty() {
        return samples.to_vec();
    }

    let ch_count = channels as usize;
    if ch_count == 0 {
        return Vec::new();
    }

    let num_frames = samples.len() / ch_count;
    let f_ratio = to_sr as f64 / from_sr as f64;

    // Create resampler using polynomial interpolation (fast, no fft_resampler feature needed)
    let mut resampler = match Async::<f64>::new_poly(
        f_ratio,
        1.1,
        PolynomialDegree::Septic,
        1024,
        ch_count,
        FixedAsync::Input,
    ) {
        Ok(r) => r,
        Err(e) => {
            log::error!(
                "Failed to create resampler: {}, falling back to linear interpolation",
                e
            );
            return linear_resample_interleaved(samples, from_sr, to_sr, channels);
        }
    };

    // Deinterleave into per-channel vectors
    let mut channel_data: Vec<Vec<f64>> = vec![Vec::with_capacity(num_frames); ch_count];
    for frame in samples.chunks(ch_count) {
        for (ch, sample) in channel_data.iter_mut().zip(frame.iter()) {
            ch.push(*sample as f64);
        }
    }

    let mut resampled_channels: Vec<Vec<f32>> = vec![Vec::new(); ch_count];
    let mut input_offset = 0;
    let mut input_frames_next = resampler.input_frames_next();

    while input_offset < num_frames {
        let frames_available = num_frames - input_offset;
        let frames_to_process = frames_available.min(input_frames_next);

        // Build interleaved input buffer for rubato
        let mut interleaved_in = vec![0.0f64; frames_to_process * ch_count];
        for (frame_idx, out_frame) in interleaved_in.chunks_mut(ch_count).enumerate() {
            for (ch_idx, out_sample) in out_frame.iter_mut().enumerate() {
                if input_offset + frame_idx < channel_data[ch_idx].len() {
                    *out_sample = channel_data[ch_idx][input_offset + frame_idx];
                }
            }
        }

        let input_adapter = rubato::audioadapter_buffers::direct::InterleavedSlice::new(
            &interleaved_in,
            ch_count,
            frames_to_process,
        )
        .unwrap();

        // Allocate output buffer
        let max_out_frames = resampler.output_frames_next();
        let mut interleaved_out = vec![0.0f64; max_out_frames * ch_count];
        let mut output_adapter = rubato::audioadapter_buffers::direct::InterleavedSlice::new_mut(
            &mut interleaved_out,
            ch_count,
            max_out_frames,
        )
        .unwrap();

        let indexing = rubato::Indexing {
            input_offset: 0,
            output_offset: 0,
            active_channels_mask: None,
            partial_len: None,
        };

        match resampler.process_into_buffer(&input_adapter, &mut output_adapter, Some(&indexing)) {
            Ok((nbr_in, nbr_out)) => {
                // Deinterleave output
                for frame_idx in 0..nbr_out {
                    for (ch_idx, out_ch) in resampled_channels.iter_mut().enumerate() {
                        let val = interleaved_out[frame_idx * ch_count + ch_idx];
                        out_ch.push(val as f32);
                    }
                }
                input_offset += nbr_in;
                input_frames_next = resampler.input_frames_next();
            }
            Err(e) => {
                log::error!("Resampler process error: {}, falling back to linear", e);
                return linear_resample_interleaved(samples, from_sr, to_sr, channels);
            }
        }
    }

    // Process any remaining partial chunk
    if input_offset < num_frames {
        let remaining = num_frames - input_offset;
        let mut interleaved_in = vec![0.0f64; remaining * ch_count];
        for (frame_idx, out_frame) in interleaved_in.chunks_mut(ch_count).enumerate() {
            for (ch_idx, out_sample) in out_frame.iter_mut().enumerate() {
                if input_offset + frame_idx < channel_data[ch_idx].len() {
                    *out_sample = channel_data[ch_idx][input_offset + frame_idx];
                }
            }
        }

        let input_adapter = rubato::audioadapter_buffers::direct::InterleavedSlice::new(
            &interleaved_in,
            ch_count,
            remaining,
        )
        .unwrap();

        let max_out_frames = resampler.output_frames_next();
        let mut interleaved_out = vec![0.0f64; max_out_frames * ch_count];
        let mut output_adapter = rubato::audioadapter_buffers::direct::InterleavedSlice::new_mut(
            &mut interleaved_out,
            ch_count,
            max_out_frames,
        )
        .unwrap();

        let indexing = rubato::Indexing {
            input_offset: 0,
            output_offset: 0,
            active_channels_mask: None,
            partial_len: Some(remaining),
        };

        if let Ok((_nbr_in, nbr_out)) =
            resampler.process_into_buffer(&input_adapter, &mut output_adapter, Some(&indexing))
        {
            for frame_idx in 0..nbr_out {
                for (ch_idx, out_ch) in resampled_channels.iter_mut().enumerate() {
                    let val = interleaved_out[frame_idx * ch_count + ch_idx];
                    out_ch.push(val as f32);
                }
            }
        }
    }

    // Reinterleave
    let out_frames = resampled_channels[0].len();
    let mut result = Vec::with_capacity(out_frames * ch_count);
    for frame_idx in 0..out_frames {
        for ch in &resampled_channels {
            result.push(ch[frame_idx]);
        }
    }

    result
}

/// Fallback linear resampler for interleaved audio
fn linear_resample_interleaved(
    samples: &[f32],
    from_sr: u32,
    to_sr: u32,
    channels: u16,
) -> Vec<f32> {
    let ch_count = channels as usize;
    let num_frames = samples.len() / ch_count;
    let ratio = to_sr as f64 / from_sr as f64;
    let out_frames = (num_frames as f64 * ratio) as usize;
    let mut result = Vec::with_capacity(out_frames * ch_count);

    for out_frame_idx in 0..out_frames {
        let src_pos = out_frame_idx as f64 / ratio;
        let src_idx = src_pos as usize;
        let frac = (src_pos - src_idx as f64) as f32;

        for ch in 0..ch_count {
            let s0 = if src_idx < num_frames {
                samples[src_idx * ch_count + ch]
            } else {
                0.0
            };
            let s1 = if src_idx + 1 < num_frames {
                samples[(src_idx + 1) * ch_count + ch]
            } else {
                0.0
            };
            result.push(s0 * (1.0 - frac) + s1 * frac);
        }
    }

    result
}
