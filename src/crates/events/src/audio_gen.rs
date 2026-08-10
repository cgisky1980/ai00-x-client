//! Audio Generation and Playback Event Definitions
//!
//! Events for the Stable Audio 3 music/SFX generation engine
//! and the multi-channel audio playback system

use serde::{Deserialize, Serialize};

/// Audio generation event types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AudioGenEvent {
    /// Engine initialization started
    InitStarted { variant: String },

    /// Engine initialization completed
    InitCompleted { variant: String },

    /// Engine initialization failed
    InitFailed { variant: String, error: String },

    /// Audio generation started
    GenerateStarted {
        prompt: String,
        duration: f32,
        steps: usize,
    },

    /// Audio generation progress
    GenerateProgress {
        step: usize,
        total_steps: usize,
        percentage: f32,
    },

    /// Audio generation completed successfully
    GenerateDone {
        file_path: String,
        duration_secs: f32,
        sample_rate: u32,
        channels: u16,
    },

    /// Audio generation failed
    GenerateError { error: String },

    // --- Playback events ---
    /// A channel started playing
    PlaybackStarted {
        channel_id: u64,
        name: String,
        kind: String,
    },

    /// A channel was stopped (manually or via fade-out)
    PlaybackStopped { channel_id: u64, reason: String },

    /// A non-looping channel finished playing naturally
    PlaybackFinished { channel_id: u64 },

    /// Preview audio finished playing - user can choose to save
    PreviewFinished { file_path: String },
}
