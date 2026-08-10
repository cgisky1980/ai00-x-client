use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use std::error::Error;
use std::path::Path;

pub struct AudioEncoder {
    session_frontend: Session,
    session_backend: Session,
    active_dml: bool,
    h_target_len: usize,
    n_embd: usize,
    n_embd_out: usize,
}

impl AudioEncoder {
    pub fn load(
        frontend_path: &Path,
        backend_path: &Path,
        use_gpu: bool,
    ) -> Result<Self, Box<dyn Error>> {
        // println!("[ASR Encoder] Loading frontend: {:?}", frontend_path);

        // fp16模型强制使用CPU，因为DirectML可能不支持fp16
        let use_cpu_only = true;

        let (session_frontend, active_dml_fe) =
            Self::create_session(frontend_path, use_gpu && !use_cpu_only)?;
        let (session_backend, active_dml_be) =
            Self::create_session(backend_path, use_gpu && !use_cpu_only)?;

        let n_embd = 896;
        let n_embd_out = 1024;
        let active_dml = active_dml_fe && active_dml_be;
        let h_target_len = 40 * 13;

        // println!(
        //     "[ASR Encoder] Loaded. n_embd: {}, n_embd_out: {}, dml: {}",
        //     n_embd, n_embd_out, active_dml
        // );

        Ok(Self {
            session_frontend,
            session_backend,
            active_dml,
            h_target_len,
            n_embd,
            n_embd_out,
        })
    }

    fn create_session(model_path: &Path, use_gpu: bool) -> Result<(Session, bool), Box<dyn Error>> {
        // println!("[ASR Encoder] Creating session for: {:?}", model_path);

        // println!("[ASR Encoder] Calling Session::builder()...");
        let mut builder = Session::builder()?;

        // println!("[ASR Encoder] Setting optimization level...");
        builder = builder.with_optimization_level(GraphOptimizationLevel::Level1)?;

        #[cfg(windows)]
        if use_gpu {
            // println!("[ASR Encoder] Building DirectML Execution Provider...");
            let dml = ort::execution_providers::DirectMLExecutionProvider::default().build();
            // println!("[ASR Encoder] Setting DirectML Execution Provider...");

            // 尝试使用 DirectML，如果失败则回退到 CPU
            match builder.with_execution_providers([dml]) {
                Ok(builder_dml) => {
                    match builder_dml.commit_from_file(model_path) {
                        Ok(session) => {
                            // println!("[ASR Encoder] Session created with DirectML");
                            return Ok((session, true));
                        }
                        Err(_e) => {
                            // println!(
                            //     "[ASR Encoder] DirectML commit failed: {:?}, falling back to CPU",
                            //     e
                            // );
                            // 重新创建一个 builder，因为之前的可能已经被消耗或污染
                            builder = Session::builder()?
                                .with_optimization_level(GraphOptimizationLevel::Level1)?;
                        }
                    }
                }
                Err(_e) => {
                    // println!(
                    //     "[ASR Encoder] DirectML setup failed: {:?}, falling back to CPU",
                    //     e
                    // );
                    // 重新创建一个 builder
                    builder = Session::builder()?
                        .with_optimization_level(GraphOptimizationLevel::Level1)?;
                }
            }
        }

        // println!("[ASR Encoder] Building CPU Execution Provider...");
        let cpu = ort::execution_providers::CPUExecutionProvider::default().build();

        // println!("[ASR Encoder] Setting CPU Execution Provider...");
        builder = builder.with_execution_providers([cpu])?;

        // println!("[ASR Encoder] Loading model...");
        let session = builder.commit_from_file(model_path)?;
        // println!("[ASR Encoder] Session created with CPU");
        Ok((session, false))
    }

    pub fn encode(&mut self, audio: &[f32]) -> Result<Vec<f32>, Box<dyn Error>> {
        let mel = self.compute_mel(audio)?;
        let hidden_states = self.run_frontend(&mel)?;
        let embeddings = self.run_backend(&hidden_states)?;
        Ok(embeddings)
    }

    fn compute_mel(&self, audio: &[f32]) -> Result<Vec<f32>, Box<dyn Error>> {
        use rustfft::{num_complex::Complex, FftPlanner};

        const SAMPLE_RATE: f32 = 16000.0;
        const N_FFT: usize = 400;
        const HOP_LENGTH: usize = 160;
        const N_MELS: usize = 128;
        const FMAX: f32 = 8000.0;

        fn hz_to_mel(freq: f32) -> f32 {
            let f_min = 0.0f32;
            let f_sp = 200.0 / 3.0;
            let min_log_hz = 1000.0f32;
            let min_log_mel = (min_log_hz - f_min) / f_sp;
            let logstep = 6.4f32.ln() / 27.0;

            if freq >= min_log_hz {
                min_log_mel + ((freq / min_log_hz).ln() / logstep)
            } else {
                (freq - f_min) / f_sp
            }
        }

        fn mel_to_hz(mel: f32) -> f32 {
            let f_min = 0.0f32;
            let f_sp = 200.0 / 3.0;
            let min_log_hz = 1000.0f32;
            let min_log_mel = (min_log_hz - f_min) / f_sp;
            let logstep = 6.4f32.ln() / 27.0;

            if mel >= min_log_mel {
                min_log_hz * (logstep * (mel - min_log_mel)).exp()
            } else {
                f_min + f_sp * mel
            }
        }

        let n_fft_bins = N_FFT / 2 + 1;
        let mel_min = hz_to_mel(0.0);
        let mel_max = hz_to_mel(FMAX);

        let mut mel_edges = Vec::with_capacity(N_MELS + 2);
        for i in 0..=N_MELS + 1 {
            let mel = mel_min + (mel_max - mel_min) * (i as f32) / ((N_MELS + 1) as f32);
            mel_edges.push(mel_to_hz(mel));
        }

        let fft_freqs: Vec<f32> = (0..n_fft_bins)
            .map(|i| (i as f32) * SAMPLE_RATE / (N_FFT as f32))
            .collect();

        let mut mel_filterbank = vec![0.0f32; N_MELS * n_fft_bins];
        for m in 0..N_MELS {
            let f_left = mel_edges[m];
            let f_center = mel_edges[m + 1];
            let f_right = mel_edges[m + 2];
            let norm = 2.0 / (f_right - f_left);

            for (k, &freq) in fft_freqs.iter().enumerate() {
                let weight = if freq >= f_left && freq <= f_center {
                    (freq - f_left) / (f_center - f_left)
                } else if freq > f_center && freq <= f_right {
                    (f_right - freq) / (f_right - f_center)
                } else {
                    0.0
                };
                mel_filterbank[m * n_fft_bins + k] = weight * norm;
            }
        }

        let padding = N_FFT / 2;
        let mut padded: Vec<f32> = Vec::with_capacity(padding + audio.len() + padding);
        for i in (1..=padding).rev() {
            padded.push(if i < audio.len() { audio[i] } else { 0.0 });
        }
        padded.extend_from_slice(audio);
        for i in 1..=padding {
            let idx = audio.len().saturating_sub(1 + i);
            padded.push(if idx < audio.len() { audio[idx] } else { 0.0 });
        }

        let hann_window: Vec<f32> = (0..N_FFT)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / N_FFT as f32).cos()))
            .collect();

        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(N_FFT);

        let n_frames = (padded.len().saturating_sub(N_FFT)) / HOP_LENGTH + 1;
        let mut all_mels = vec![0.0f32; N_MELS * n_frames];

        for frame_idx in 0..n_frames {
            let start = frame_idx * HOP_LENGTH;
            if start + N_FFT > padded.len() {
                break;
            }

            let mut fft_buffer: Vec<Complex<f32>> = (0..N_FFT)
                .map(|i| Complex::new(padded[start + i] * hann_window[i], 0.0))
                .collect();

            fft.process(&mut fft_buffer);

            let magnitudes: Vec<f32> = fft_buffer[..n_fft_bins]
                .iter()
                .map(|c| c.norm_sqr() + 1e-10)
                .collect();

            for m in 0..N_MELS {
                let mut mel_val = 0.0f32;
                for k in 0..n_fft_bins {
                    mel_val += mel_filterbank[m * n_fft_bins + k] * magnitudes[k];
                }
                all_mels[m * n_frames + frame_idx] = mel_val.log10().max(-8.0);
            }
        }

        let max_val = all_mels.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        for val in &mut all_mels {
            *val = ((*val).max(max_val - 8.0) + 4.0) / 4.0;
        }

        let n_frames_out = audio.len() / HOP_LENGTH;
        let mut mel_out = vec![0.0f32; N_MELS * n_frames_out];
        for m in 0..N_MELS {
            for f in 0..n_frames_out {
                mel_out[m * n_frames_out + f] = all_mels[m * n_frames + f];
            }
        }

        Ok(mel_out)
    }

    fn run_frontend(&mut self, mel: &[f32]) -> Result<Vec<f32>, Box<dyn Error>> {
        let t = mel.len() / 128;
        let pad_len = (100 - (t % 100)) % 100;
        let t_padded = t + pad_len;

        let mut mel_padded = vec![0.0f32; 128 * t_padded];
        for m in 0..128 {
            for f in 0..t {
                mel_padded[m * t_padded + f] = mel[m * t + f];
            }
        }

        let num_chunks = t_padded / 100;
        let mut all_outputs = Vec::new();

        for i in 0..num_chunks {
            let mut chunk = vec![0.0f32; 128 * 100];
            for m in 0..128 {
                for f in 0..100 {
                    chunk[m * 100 + f] = mel_padded[m * t_padded + i * 100 + f];
                }
            }

            let shape = vec![1i64, 128i64, 100i64];
            let input_tensor = Tensor::from_array((shape, chunk))?;

            let outputs = self
                .session_frontend
                .run(ort::inputs!["chunk_mel" => input_tensor])?;

            let output = &outputs[0];
            let output_raw = output.try_extract_tensor::<f32>()?;
            all_outputs.push(output_raw.1.to_vec());
        }

        let valid_frames = Self::get_feat_extract_output_lengths(t);
        let mut hidden_states = vec![0.0f32; valid_frames * self.n_embd];

        for (chunk_idx, output) in all_outputs.iter().enumerate() {
            for frame_idx in 0..13usize {
                let src_offset = frame_idx * self.n_embd;
                let dst_offset = (chunk_idx * 13 + frame_idx) * self.n_embd;
                if dst_offset + self.n_embd <= hidden_states.len()
                    && src_offset + self.n_embd <= output.len()
                {
                    hidden_states[dst_offset..dst_offset + self.n_embd]
                        .copy_from_slice(&output[src_offset..src_offset + self.n_embd]);
                }
            }
        }

        Ok(hidden_states)
    }

    fn run_backend(&mut self, hidden_states: &[f32]) -> Result<Vec<f32>, Box<dyn Error>> {
        let seq_len = hidden_states.len() / self.n_embd;
        let (hidden_input, mask, actual_seq_len) = if self.active_dml && seq_len < self.h_target_len
        {
            let mut padded = hidden_states.to_vec();
            padded.resize(self.h_target_len * self.n_embd, 0.0);

            let mut mask_vec = vec![0.0f32; self.h_target_len * self.h_target_len];
            for i in 0..self.h_target_len {
                for j in seq_len..self.h_target_len {
                    mask_vec[i * self.h_target_len + j] = -10000.0;
                }
            }
            (padded, mask_vec, self.h_target_len)
        } else {
            (
                hidden_states.to_vec(),
                vec![0.0f32; seq_len * seq_len],
                seq_len,
            )
        };

        let shape_hidden = vec![1i64, actual_seq_len as i64, self.n_embd as i64];
        let input_tensor = Tensor::from_array((shape_hidden, hidden_input))?;

        let shape_mask = vec![1i64, 1i64, actual_seq_len as i64, actual_seq_len as i64];
        let mask_tensor = Tensor::from_array((shape_mask, mask))?;

        let outputs = self.session_backend.run(ort::inputs! {
            "hidden_states" => input_tensor,
            "attention_mask" => mask_tensor
        })?;

        let output = &outputs[0];
        let output_raw = output.try_extract_tensor::<f32>()?;
        let output_vec = output_raw.1.to_vec();

        let original_seq_len = hidden_states.len() / self.n_embd;
        let valid_size = original_seq_len * self.n_embd_out;
        Ok(output_vec[..valid_size.min(output_vec.len())].to_vec())
    }

    fn get_feat_extract_output_lengths(input_lengths: usize) -> usize {
        let input_lengths_leave = input_lengths % 100;
        let feat_lengths = if input_lengths_leave == 0 {
            0
        } else {
            (input_lengths_leave - 1) / 2 + 1
        };
        let tail = if feat_lengths == 0 {
            0
        } else {
            ((feat_lengths - 1) / 2 + 1 - 1) / 2 + 1
        };
        (input_lengths / 100) * 13 + tail
    }

    pub fn n_embd(&self) -> usize {
        self.n_embd
    }

    pub fn n_embd_out(&self) -> usize {
        self.n_embd_out
    }
}
