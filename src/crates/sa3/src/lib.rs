pub mod audio;
pub mod config;
pub mod models;
pub mod schedule;

use std::io::Write;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use ndarray::{Array2, Array3};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

fn sample_standard_normal(rng: &mut StdRng) -> f32 {
    // Box-Muller transform
    let u1: f32 = rng.gen();
    let u2: f32 = rng.gen();
    let u1 = u1.max(1e-10); // avoid log(0)
    (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos()
}

use config::{compute_latent_len, IO_CHANNELS, LOCAL_ADD_COND_DIM, SAMPLE_RATE};
use models::StableAudio3Models;
use schedule::build_schedule;

fn log(msg: &str) {
    println!("{msg}");
    let _ = std::io::stdout().flush();
}

pub struct StableAudio3 {
    pub models: StableAudio3Models,
    variant: String,
}

pub struct GenerateOptions {
    pub prompt: String,
    pub negative_prompt: String,
    pub duration: f32,
    pub steps: usize,
    pub cfg_scale: f32,
    pub seed: Option<u64>,
    pub init_audio: Option<Array3<f32>>,
    pub init_noise_level: f32,
    pub inpaint_audio: Option<Array3<f32>>,
    pub inpaint_start_seconds: Option<f32>,
    pub inpaint_end_seconds: Option<f32>,
    pub variant: Option<String>,
    /// When set, checked between denoising steps; if true, generation aborts early.
    pub cancelled: Option<Arc<AtomicBool>>,
}

impl Default for GenerateOptions {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            negative_prompt: String::new(),
            duration: 10.0,
            steps: 8,
            cfg_scale: 1.0,
            seed: None,
            init_audio: None,
            init_noise_level: 0.9,
            inpaint_audio: None,
            inpaint_start_seconds: None,
            inpaint_end_seconds: None,
            variant: None,
            cancelled: None,
        }
    }
}

impl StableAudio3 {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        models_dir: &std::path::Path,
        variant: &str,
        mnn_gpu: i32,
        mnn_int8: bool,
        mnn_fp32: bool,
        mnn_t5_fp32: bool,
        duration: f32,
    ) -> Result<Self> {
        let t_lat = compute_latent_len(duration);
        let models = StableAudio3Models::load(
            models_dir,
            variant,
            mnn_gpu,
            mnn_int8,
            mnn_fp32,
            mnn_t5_fp32,
            t_lat,
        )?;
        Ok(Self {
            models,
            variant: variant.to_string(),
        })
    }

    pub fn generate(&mut self, opts: &GenerateOptions) -> Result<Array3<f32>> {
        let variant = opts.variant.as_deref().unwrap_or(&self.variant);
        let mut rng = match opts.seed {
            Some(seed) => StdRng::seed_from_u64(seed),
            None => StdRng::from_rng(rand::thread_rng())
                .unwrap_or_else(|_| StdRng::seed_from_u64(rand::random())),
        };

        let t_lat = compute_latent_len(opts.duration);
        log(&format!(
            "  [SA3] generate: duration={}, t_lat={}, steps={}, cfg={}, seed={:?}",
            opts.duration, t_lat, opts.steps, opts.cfg_scale, opts.seed
        ));

        let t0 = std::time::Instant::now();
        log("  [SA3] Step 1/4: encode_text...");
        let (pos_hidden, _) = self.models.encode_text(&opts.prompt)?;
        log(&format!(
            "  [SA3] encode_text done: shape={:?}",
            pos_hidden.shape()
        ));
        let t_text = t0.elapsed();

        let t1 = std::time::Instant::now();
        log("  [SA3] Step 2/4: encode_seconds...");
        let seconds_embed = self.models.encode_seconds(opts.duration, variant)?;
        log(&format!(
            "  [SA3] encode_seconds done: shape={:?}",
            seconds_embed.shape()
        ));
        let t_nc = t1.elapsed();

        let cross_attn_cond =
            ndarray::concatenate!(ndarray::Axis(1), pos_hidden.view(), seconds_embed.view());
        let global_embed = seconds_embed.clone().remove_axis(ndarray::Axis(1));

        let use_inpainting = opts.inpaint_audio.is_some()
            && (opts.inpaint_start_seconds.is_some() || opts.inpaint_end_seconds.is_some());

        let local_add_cond = if use_inpainting {
            log("  编码 inpaint 音频...");
            let inpaint_audio = opts.inpaint_audio.as_ref().unwrap();
            let inpaint_latent = self.models.encode_audio(inpaint_audio)?;
            let t_lat_enc = inpaint_latent.shape()[2];

            let mut mask = Array3::ones((1, 1, t_lat_enc));
            let start_s = opts.inpaint_start_seconds.unwrap_or(0.0);
            let end_s = opts.inpaint_end_seconds.unwrap_or(opts.duration);
            let start_lat =
                (start_s * SAMPLE_RATE as f32 / (SAMPLE_RATE as f32 * 4096.0 / 4096.0) / 4096.0)
                    .ceil() as usize;
            let end_lat = (end_s * SAMPLE_RATE as f32 / 4096.0).ceil() as usize;
            let start_lat = start_lat.min(t_lat_enc);
            let end_lat = end_lat.min(t_lat_enc);
            for t in start_lat..end_lat {
                mask[[0, 0, t]] = 0.0;
            }

            let masked_input = &inpaint_latent * &mask;
            let mut lac = Array3::zeros((1, LOCAL_ADD_COND_DIM, t_lat.min(t_lat_enc)));
            for t in 0..t_lat.min(t_lat_enc) {
                lac[[0, 0, t]] = mask[[0, 0, t]];
                for c in 0..IO_CHANNELS {
                    lac[[0, 1 + c, t]] = masked_input[[0, c, t]];
                }
            }
            lac
        } else {
            Array3::zeros((1, LOCAL_ADD_COND_DIM, t_lat))
        };

        let padding_mask = Array2::from_elem((1, t_lat), true);

        let use_cfg = opts.cfg_scale != 1.0;
        let neg_cross_attn = if use_cfg {
            let (neg_hidden, _) = self.models.encode_text(&opts.negative_prompt)?;
            Some(ndarray::concatenate!(
                ndarray::Axis(1),
                neg_hidden.view(),
                seconds_embed.view()
            ))
        } else {
            None
        };

        let schedule = build_schedule(opts.steps, t_lat);

        let sigma_max = if opts.init_audio.is_some() {
            opts.init_noise_level
        } else {
            1.0
        };

        let start_step = if sigma_max < 1.0 {
            schedule.iter().position(|&s| s <= sigma_max).unwrap_or(0)
        } else {
            0
        };

        let mut x = if let Some(ref init_audio) = opts.init_audio {
            log("  编码 init 音频...");
            let init_latent = self.models.encode_audio(init_audio)?;
            let init_latent_padded = if init_latent.shape()[2] < t_lat {
                let mut padded = Array3::zeros((1, IO_CHANNELS, t_lat));
                for c in 0..IO_CHANNELS {
                    for t in 0..init_latent.shape()[2].min(t_lat) {
                        padded[[0, c, t]] = init_latent[[0, c, t]];
                    }
                }
                padded
            } else {
                init_latent.to_owned()
            };
            let noise = Array3::from_shape_fn((1, IO_CHANNELS, t_lat), |(_, _, _)| {
                sample_standard_normal(&mut rng)
            });
            log(&format!(
                "  Init Audio mode: noise_level={sigma_max:.2}, start_step={start_step}"
            ));
            &init_latent_padded * (1.0 - sigma_max) + &noise * sigma_max
        } else {
            Array3::from_shape_fn((1, IO_CHANNELS, t_lat), |(_, _, _)| {
                sample_standard_normal(&mut rng)
            })
        };

        let mut dit_total = std::time::Duration::ZERO;
        for i in start_step..opts.steps {
            // Check cancellation flag between denoising steps
            if let Some(ref flag) = opts.cancelled {
                if flag.load(Ordering::SeqCst) {
                    log("  [SA3] Generation cancelled, aborting early");
                    return Err(anyhow!("Generation cancelled"));
                }
            }

            // Yield between denoising steps to allow GPU driver DPC processing.
            // Without this, continuous GPU usage accumulates DPC latency that
            // blocks the audio callback thread, causing crackling.
            std::thread::yield_now();

            let t_step = std::time::Instant::now();
            log(&format!(
                "  [SA3] Step 3/4: DiT denoise {}/{} (t_curr={:.6})...",
                i + 1 - start_step,
                opts.steps - start_step,
                schedule[i]
            ));
            let t_curr = schedule[i];
            let t_next = schedule[i + 1];

            let v = if use_cfg {
                let neg = neg_cross_attn.as_ref().unwrap();
                let v_pos = self.models.run_dit(
                    &x,
                    t_curr,
                    &cross_attn_cond,
                    &global_embed,
                    &local_add_cond,
                    &padding_mask,
                    variant,
                )?;
                let v_neg = self.models.run_dit(
                    &x,
                    t_curr,
                    neg,
                    &global_embed,
                    &local_add_cond,
                    &padding_mask,
                    variant,
                )?;

                let sigma = t_curr;
                let cond_denoised = &x - sigma * &v_pos;
                let uncond_denoised = &x - sigma * &v_neg;
                let diff = &cond_denoised - &uncond_denoised;

                let cond_norm = cond_denoised
                    .mapv(|v| v * v)
                    .sum_axis(ndarray::Axis(1))
                    .sum_axis(ndarray::Axis(1))
                    .mapv(|v| v.sqrt())
                    .insert_axis(ndarray::Axis(1))
                    .insert_axis(ndarray::Axis(1));
                let cond_unit = &cond_denoised / cond_norm.mapv(|v| v.max(1e-8));

                let parallel = (&diff * &cond_unit)
                    .sum_axis(ndarray::Axis(1))
                    .sum_axis(ndarray::Axis(1));
                let parallel = parallel
                    .insert_axis(ndarray::Axis(1))
                    .insert_axis(ndarray::Axis(1))
                    * cond_unit;
                let diff_orth = diff - &parallel;
                let cfg_denoised = cond_denoised + (opts.cfg_scale - 1.0) * diff_orth;

                if sigma > 1e-7 {
                    (&x - &cfg_denoised) / sigma
                } else {
                    v_pos
                }
            } else {
                self.models.run_dit(
                    &x,
                    t_curr,
                    &cross_attn_cond,
                    &global_embed,
                    &local_add_cond,
                    &padding_mask,
                    variant,
                )?
            };

            let denoised = &x - t_curr * &v;
            dit_total += t_step.elapsed();
            if t_next > 1e-7 {
                let noise =
                    Array3::from_shape_fn(x.dim(), |(_, _, _)| sample_standard_normal(&mut rng));
                x = (1.0 - t_next) * &denoised + t_next * noise;
            } else {
                x = denoised;
            }
        }

        log("  [SA3] Step 4/4: decode audio...");
        let t_dec_start = std::time::Instant::now();
        let audio = self.models.decode_chunks(&x, |ci, total, chunk| {
            let chunk_sec = chunk.shape()[2] as f32 / SAMPLE_RATE as f32;
            log(&format!(
                "    chunk {}/{}: {:.1}s 音频已就绪",
                ci, total, chunk_sec
            ));
        })?;
        let t_dec = t_dec_start.elapsed();
        let max_samples = (opts.duration * SAMPLE_RATE as f32) as usize;
        let n_samples = audio.shape()[2].min(max_samples);
        let channels = audio.shape()[1];
        let mut trimmed = Array3::zeros((1, channels, n_samples));
        for c in 0..channels {
            for s in 0..n_samples {
                trimmed[[0, c, s]] = audio[[0, c, s]];
            }
        }

        let noise_floor = 0.002f32;
        let window_size = (SAMPLE_RATE as f32 * 0.05) as usize;
        let n_windows = n_samples / window_size;
        let mut last_loud_window = 0usize;
        for w in 0..n_windows {
            let start = w * window_size;
            let mut energy = 0.0f32;
            for c in 0..channels {
                for s in start..start + window_size {
                    energy += trimmed[[0, c, s]] * trimmed[[0, c, s]];
                }
            }
            let rms = (energy / (channels * window_size) as f32).sqrt();
            if rms > noise_floor {
                last_loud_window = w;
            }
        }

        let content_end = ((last_loud_window + 2) * window_size).min(n_samples);
        let fade_len = (SAMPLE_RATE as f32 * 0.5) as usize;
        for c in 0..channels {
            for s in content_end..n_samples {
                let dist = s - content_end;
                let fade = if dist < fade_len {
                    1.0f32 - (dist as f32 / fade_len as f32).powi(2)
                } else {
                    0.0f32
                };
                trimmed[[0, c, s]] *= fade;
            }
        }

        let peak = trimmed.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        if peak > 1e-6 {
            let scale = 0.95 / peak;
            trimmed.mapv_inplace(|v| v * scale);
        }

        log(&format!(
            "  分步耗时: T5={:.2}s, NC={:.2}s, DiT={:.2}s, Decoder={:.2}s",
            t_text.as_secs_f64(),
            t_nc.as_secs_f64(),
            dit_total.as_secs_f64(),
            t_dec.as_secs_f64()
        ));
        log(&format!(
            "BENCH T5={:.4} NC={:.4} DiT={:.4} Dec={:.4} Tot={:.4}",
            t_text.as_secs_f64(),
            t_nc.as_secs_f64(),
            dit_total.as_secs_f64(),
            t_dec.as_secs_f64(),
            t_text.as_secs_f64()
                + t_nc.as_secs_f64()
                + dit_total.as_secs_f64()
                + t_dec.as_secs_f64()
        ));

        Ok(trimmed)
    }

    pub fn variant(&self) -> &str {
        &self.variant
    }
}
