use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AudioGenVariant {
    #[serde(rename = "sm-music")]
    Music,
    #[serde(rename = "sm-sfx")]
    Sfx,
}

impl AudioGenVariant {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Music => "sm-music",
            Self::Sfx => "sm-sfx",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioGenOptions {
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    #[serde(default = "default_duration")]
    pub duration: f32,
    #[serde(default = "default_steps")]
    pub steps: usize,
    #[serde(default = "default_cfg_scale")]
    pub cfg_scale: f32,
    #[serde(default)]
    pub seed: Option<u64>,
    #[serde(default = "default_variant")]
    pub variant: AudioGenVariant,
    /// Force CPU backend for this generation (used for background radio pre-generation)
    #[serde(default)]
    pub force_cpu: bool,
}

fn default_duration() -> f32 {
    10.0
}
fn default_steps() -> usize {
    8
}
fn default_cfg_scale() -> f32 {
    1.0
}
fn default_variant() -> AudioGenVariant {
    AudioGenVariant::Music
}

impl Default for AudioGenOptions {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            negative_prompt: String::new(),
            duration: default_duration(),
            steps: default_steps(),
            cfg_scale: default_cfg_scale(),
            seed: None,
            variant: default_variant(),
            force_cpu: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioGenResult {
    pub file_path: String,
    pub duration_secs: f32,
    pub sample_rate: u32,
    pub channels: u16,
}
