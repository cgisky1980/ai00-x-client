use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use sa3_rs::audio;
use sa3_rs::{GenerateOptions, StableAudio3};

use super::types::{AudioGenOptions, AudioGenResult, AudioGenVariant};

/// Singleton cancellation flag for audio generation.
/// Set to true by `generate_audio` when a new request supersedes an in-flight one.
/// Cleared at the start of each new generation in `AudioGenEngine::generate()`.
/// SA3's denoise loop checks this between steps and aborts early if true.
static CANCEL_FLAG: std::sync::OnceLock<Arc<AtomicBool>> = std::sync::OnceLock::new();

/// Get the shared cancellation flag. Used by both `generate_audio` (to signal
/// cancellation) and `AudioGenEngine::generate` (to pass to SA3).
pub fn cancel_flag() -> &'static Arc<AtomicBool> {
    CANCEL_FLAG.get_or_init(|| Arc::new(AtomicBool::new(false)))
}

/// Signal that the current in-flight generation should be cancelled.
pub fn signal_cancel() {
    cancel_flag().store(true, Ordering::SeqCst);
}

/// Clear the cancellation flag (called at the start of a new generation).
pub fn clear_cancel() {
    cancel_flag().store(false, Ordering::SeqCst);
}

pub struct AudioGenEngine {
    sa3: StableAudio3,
}

impl AudioGenEngine {
    pub fn new(
        models_dir: &Path,
        variant: &AudioGenVariant,
        mnn_gpu: i32,
        mnn_int8: bool,
        default_duration: f32,
    ) -> Result<Self> {
        let sa3 = StableAudio3::new(
            models_dir,
            variant.as_str(),
            mnn_gpu,
            mnn_int8,
            false, // mnn_fp32
            false, // mnn_t5_fp32
            default_duration,
        )?;
        Ok(Self { sa3 })
    }

    pub fn generate(
        &mut self,
        opts: &AudioGenOptions,
        output_dir: &Path,
    ) -> Result<AudioGenResult> {
        // Note: cancellation flag is cleared by the worker thread before
        // calling this method, so we don't need to clear it here.

        let gen_opts = GenerateOptions {
            prompt: opts.prompt.clone(),
            negative_prompt: opts.negative_prompt.clone(),
            duration: opts.duration,
            steps: opts.steps,
            cfg_scale: opts.cfg_scale,
            seed: opts.seed,
            variant: Some(opts.variant.as_str().to_string()),
            cancelled: Some(cancel_flag().clone()),
            ..Default::default()
        };

        let audio_array = self.sa3.generate(&gen_opts)?;

        // Generate output filename
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let variant_label = match &opts.variant {
            AudioGenVariant::Music => "music",
            AudioGenVariant::Sfx => "sfx",
        };
        let filename = format!(
            "audio_gen_{}_{}_{}s.wav",
            variant_label, timestamp, opts.duration as u32
        );
        let output_path = output_dir.join(&filename);

        // Save as WAV
        std::fs::create_dir_all(output_dir)?;
        audio::save_audio(
            output_path
                .to_str()
                .ok_or_else(|| anyhow!("Invalid output path"))?,
            &audio_array,
            opts.duration,
        )?;

        Ok(AudioGenResult {
            file_path: output_path.to_string_lossy().to_string(),
            duration_secs: opts.duration,
            sample_rate: 44100,
            channels: 2,
        })
    }
}
