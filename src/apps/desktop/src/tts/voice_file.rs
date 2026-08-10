use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceFile {
    #[serde(default)]
    pub ref_text: String,
    #[serde(default)]
    pub audio_codes: Vec<i64>,
    #[serde(alias = "spk_emb")]
    pub speaker_embedding: Vec<f32>,

    pub name: Option<String>,
    pub gender: Option<String>,
    pub age: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub gender_confidence: Option<f64>,
    pub age_confidence: Option<f64>,
}

impl VoiceFile {
    pub fn new(ref_text: String, audio_codes: Vec<i64>, speaker_embedding: Vec<f32>) -> Self {
        Self {
            ref_text,
            audio_codes,
            speaker_embedding,
            name: None,
            gender: None,
            age: None,
            description: None,
            tags: None,
            gender_confidence: None,
            age_confidence: None,
        }
    }

    pub fn with_metadata(
        mut self,
        name: Option<String>,
        gender: Option<String>,
        age: Option<String>,
        description: Option<String>,
    ) -> Self {
        self.name = name;
        self.gender = gender;
        self.age = age;
        self.description = description;
        self
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let reader = std::io::BufReader::new(file);
        serde_json::from_reader(reader).map_err(|e| e.to_string())
    }

    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), String> {
        let file = File::create(path).map_err(|e| e.to_string())?;
        let writer = std::io::BufWriter::new(file);
        serde_json::to_writer_pretty(writer, self).map_err(|e| e.to_string())
    }
}
