use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub fn load_audio<P: AsRef<Path>>(path: P) -> Result<(Vec<f32>, i32), String> {
    let path = path.as_ref();
    let src = std::fs::File::open(path).map_err(|e| format!("failed to open file: {}", e))?;

    // Create the media source stream.
    let mss = MediaSourceStream::new(Box::new(src), Default::default());

    // Create a probe hint using the file's extension. [Optional]
    let mut hint = Hint::new();
    if let Some(ext) = path.extension() {
        if let Some(ext_str) = ext.to_str() {
            hint.with_extension(ext_str);
        }
    }

    // Use the default options for metadata and format readers.
    let meta_opts: MetadataOptions = Default::default();
    let fmt_opts: FormatOptions = Default::default();

    // Probe the media source.
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .map_err(|e| format!("unsupported format: {}", e))?;

    // Get the instantiated format reader.
    let mut format = probed.format;

    // Find the first audio track with a known codec.
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or("no supported audio tracks")?;

    // Use the default options for the decoder.
    let dec_opts: DecoderOptions = Default::default();

    // Create a decoder for the track.
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &dec_opts)
        .map_err(|e| format!("unsupported codec: {}", e))?;

    let track_id = track.id;

    let mut samples: Vec<f32> = Vec::new();
    let mut sample_rate = 0;

    // The decode loop.
    loop {
        // Get the next packet from the media format.
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(e) => return Err(format!("failed to read packet: {}", e)),
        };

        // Consume any new metadata that has been read since the last packet.
        while !format.metadata().is_latest() {
            format.metadata().pop();
        }

        // If the packet does not belong to the selected track, skip it.
        if packet.track_id() != track_id {
            continue;
        }

        // Decode the packet into audio samples.
        match decoder.decode(&packet) {
            Ok(decoded) => {
                if sample_rate == 0 {
                    sample_rate = decoded.spec().rate;
                }

                // Get the audio buffer specification.
                let spec = *decoded.spec();
                let duration = decoded.capacity() as u64;

                // Create a sample buffer for the decoded audio.
                let mut sample_buf = SampleBuffer::<f32>::new(duration, spec);

                // Copy the decoded audio samples into the sample buffer.
                sample_buf.copy_interleaved_ref(decoded);

                // Extend the samples vector.
                // Note: SampleBuffer stores interleaved samples.
                // We need to mix down to mono if multiple channels.
                let buf_samples = sample_buf.samples();

                if spec.channels.count() > 1 {
                    let channels = spec.channels.count();
                    for chunk in buf_samples.chunks(channels) {
                        let sum: f32 = chunk.iter().sum();
                        samples.push(sum / channels as f32);
                    }
                } else {
                    samples.extend_from_slice(buf_samples);
                }
            }
            Err(Error::IoError(_)) => {
                // The packet failed to decode due to an IO error, skip the packet.
                continue;
            }
            Err(Error::DecodeError(_)) => {
                // The packet failed to decode due to invalid data, skip the packet.
                continue;
            }
            Err(e) => {
                return Err(format!("failed to decode packet: {}", e));
            }
        }
    }

    if sample_rate == 0 {
        return Err("no audio data decoded".to_string());
    }

    Ok((samples, sample_rate as i32))
}

pub fn resample(audio: &[f32], orig_rate: i32, target_rate: i32) -> Vec<f32> {
    if orig_rate == target_rate {
        return audio.to_vec();
    }

    let ratio = target_rate as f64 / orig_rate as f64;
    let new_len = (audio.len() as f64 * ratio) as usize;
    let mut resampled = Vec::with_capacity(new_len);

    for i in 0..new_len {
        let src_idx = i as f64 / ratio;
        let src_idx_floor = src_idx.floor() as usize;

        if src_idx_floor + 1 < audio.len() {
            let frac = (src_idx - src_idx_floor as f64) as f32;
            let sample = audio[src_idx_floor] * (1.0 - frac) + audio[src_idx_floor + 1] * frac;
            resampled.push(sample);
        } else if src_idx_floor < audio.len() {
            resampled.push(audio[src_idx_floor]);
        }
    }

    resampled
}
