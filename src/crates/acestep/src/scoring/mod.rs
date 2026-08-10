//! Song quality scoring module.
//!
//! Provides objective audio quality assessment for generated songs.
//! The scoring is purely based on audio signal analysis — no lyrics
//! evaluation (lyrics are refined during the creation process).
//!
//! ## Scoring dimensions (each 0-100)
//!
//! | Dimension          | What it measures                          |
//! |--------------------|-------------------------------------------|
//! | `loudness`         | LUFS compliance (-23 ~ -14 LUFS target)   |
//! | `dynamic_range`    | Peak-to-RMS ratio (over-compression check)|
//! | `clipping`         | Sample clipping detection (100 = no clip) |
//! | `tempo_stability`  | BPM consistency via autocorrelation       |
//! | `spectral_balance` | Frequency band energy distribution        |
//!
//! The `overall` score is a weighted average of the 5 dimensions.

pub mod audio_analyzer;

use serde::{Deserialize, Serialize};

/// Complete song quality score.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SongScore {
    /// Weighted overall score (0-100).
    pub overall: f32,
    /// Per-dimension audio scores.
    pub audio: AudioScore,
    /// Unix timestamp (millis) when scoring was performed.
    pub scored_at: i64,
    /// Scoring algorithm version (e.g. "v1-basic", "v2-neural").
    pub version: String,
}

/// Per-dimension audio quality scores (each 0-100).
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioScore {
    /// Loudness compliance — 100 when LUFS is within -23..-14 range.
    pub loudness: f32,
    /// Dynamic range — higher when peak-to-RMS ratio is healthy.
    pub dynamic_range: f32,
    /// Clipping — 100 when no samples hit the clipping threshold.
    pub clipping: f32,
    /// Tempo stability — higher when BPM estimation is confident.
    pub tempo_stability: f32,
    /// Spectral balance — higher when low/mid/high energy is balanced.
    pub spectral_balance: f32,
}

/// Scoring algorithm version tag for the current implementation.
pub const SCORE_VERSION: &str = "v1-basic";

/// Weights for each dimension in the overall score (must sum to 1.0).
const W_CLIPPING: f32 = 0.25;
const W_LOUDNESS: f32 = 0.20;
const W_DYNAMIC: f32 = 0.20;
const W_SPECTRAL: f32 = 0.20;
const W_TEMPO: f32 = 0.15;

/// Compute the weighted overall score from per-dimension scores.
pub fn calculate_overall(audio: &AudioScore) -> f32 {
    let total = audio.clipping * W_CLIPPING
        + audio.loudness * W_LOUDNESS
        + audio.dynamic_range * W_DYNAMIC
        + audio.spectral_balance * W_SPECTRAL
        + audio.tempo_stability * W_TEMPO;
    total.round().clamp(0.0, 100.0)
}

/// Analyze an audio file and produce a complete `SongScore`.
///
/// This is the main entry point. It delegates to
/// [`audio_analyzer::analyze`] for signal-level analysis, then
/// computes the overall score.
pub fn score_audio(audio_path: &std::path::Path) -> anyhow::Result<SongScore> {
    let audio = audio_analyzer::analyze(audio_path)?;
    let overall = calculate_overall(&audio);
    Ok(SongScore {
        overall,
        audio,
        scored_at: chrono::Utc::now().timestamp_millis(),
        version: SCORE_VERSION.to_string(),
    })
}
