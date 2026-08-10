//! Audio generation model checker
//!
//! Checks if required MNN model files exist for the specified variant

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Required model file status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFileStatus {
    pub name: String,
    pub exists: bool,
    pub size_bytes: Option<u64>,
}

/// Overall model readiness status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioGenModelStatus {
    pub variant: String,
    pub ready: bool,
    pub missing_files: Vec<String>,
    pub files: Vec<ModelFileStatus>,
}

/// Get the list of required model files for a given variant and quantization
fn required_model_files(variant: &str, mnn_int8: bool, mnn_t5_fp32: bool) -> Vec<String> {
    let variant_key = variant.replace("sm-", "");

    // Shared files
    let mut files = vec![
        "tokenizer.json".to_string(),
        "decoder_fused_wn.mnn".to_string(),
    ];

    // T5 text encoder
    if mnn_t5_fp32 {
        files.push("text_encoder.mnn".to_string());
    } else {
        files.push("text_encoder_int4.mnn".to_string());
    }

    // Number conditioner (variant-specific)
    if mnn_int8 {
        files.push(format!("number_conditioner_{variant_key}_int8.mnn"));
    } else {
        files.push(format!("number_conditioner_{variant_key}_fp16.mnn"));
    }

    // DiT (variant-specific)
    if mnn_int8 {
        files.push(format!("dit_{variant_key}_int8.mnn"));
    } else {
        files.push(format!("dit_{variant_key}_fp16_f32io.mnn"));
    }

    // Bridge library
    #[cfg(target_os = "windows")]
    files.push("mnn_dit_bridge.dll".to_string());
    #[cfg(target_os = "linux")]
    files.push("libmnn_dit_bridge.so".to_string());
    #[cfg(target_os = "macos")]
    files.push("libmnn_dit_bridge.dylib".to_string());

    files
}

/// Check if all required model files exist for the given variant
pub fn check_audio_gen_models(
    models_dir: &Path,
    variant: &str,
    mnn_int8: bool,
    mnn_t5_fp32: bool,
) -> AudioGenModelStatus {
    let required = required_model_files(variant, mnn_int8, mnn_t5_fp32);
    let mut files = Vec::new();
    let mut missing = Vec::new();

    for name in &required {
        // Check in models_dir directly and in dll/ subdirectory for bridge lib
        let path = models_dir.join(name);
        let dll_path = models_dir.join("dll").join(name);

        let (exists, size) = if path.exists() {
            (true, std::fs::metadata(&path).ok().map(|m| m.len()))
        } else if dll_path.exists() {
            (true, std::fs::metadata(&dll_path).ok().map(|m| m.len()))
        } else {
            (false, None)
        };

        if !exists {
            missing.push(name.clone());
        }

        files.push(ModelFileStatus {
            name: name.clone(),
            exists,
            size_bytes: size,
        });
    }

    AudioGenModelStatus {
        variant: variant.to_string(),
        ready: missing.is_empty(),
        missing_files: missing,
        files,
    }
}

/// HuggingFace repository for MNN models
pub const HF_REPO_ID: &str = "cgisky/stable-audio-3-mnn";

/// Build download URL for a model file from HuggingFace
pub fn build_hf_url(filename: &str, mirror: Option<&str>) -> String {
    let base = mirror.unwrap_or("https://huggingface.co");
    format!("{}/{}/resolve/main/{}", base, HF_REPO_ID, filename)
}
