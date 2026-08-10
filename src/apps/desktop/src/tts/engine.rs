const DEBUG_LOG_TTS_ENGINE: bool = false;
const DEBUG_SAVE_CODES: bool = true; // 调试码本保存开关

/// 限制重复字符的最大次数
const MAX_CHAR_REPEAT: usize = 3;

/// 文本预处理：限制重复字符次数，并处理单字+标点的情况
fn normalize_repeated_chars(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut result = String::new();
    let mut prev_char: Option<char> = None;
    let mut repeat_count: usize = 0;

    // 中文标点符号
    let punctuation_chars: Vec<char> = vec!['，', '。', '！', '？', '、', '；', '：', '…', '～'];

    for ch in chars {
        if Some(ch) == prev_char {
            repeat_count += 1;
            if repeat_count <= MAX_CHAR_REPEAT {
                result.push(ch);
            }
            // 超过重复次数限制，跳过该字符
        } else {
            // 检查是否是"单字+标点"的情况
            // 如果当前字符是标点，且结果中只有一个非标点字符，则跳过标点
            if punctuation_chars.contains(&ch) {
                // 统计结果中非标点字符的数量
                let non_punct_count = result
                    .chars()
                    .filter(|c| !punctuation_chars.contains(c) && !c.is_whitespace())
                    .count();
                if non_punct_count <= 1 {
                    // 单字+标点，跳过这个标点
                    continue;
                }
            }

            prev_char = Some(ch);
            repeat_count = 1;
            result.push(ch);
        }
    }
    result
}

macro_rules! debug_print {
    ($($arg:tt)*) => {
        if DEBUG_LOG_TTS_ENGINE {
            eprintln!($($arg)*);
        }
    };
}

use super::assets::Assets;
use super::cache;
use super::onnx::{AudioDecoder, AudioEncoder, SpeakerEncoder};
use super::prompt::PromptBuilder;
use super::tokenizer::Tokenizer;
use super::voice_file::VoiceFile;
use crate::asr::llama::{LlamaBatch, LlamaContext, LlamaModel, LlamaSampler};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::Hasher;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 调试信息，用于记录推理过程中的关键参数
struct DebugInfo {
    text: String,
    instruct: Option<String>,
    speaker_name: Option<String>,
    max_steps: usize,
}

pub struct AudioSample {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl AudioSample {
    pub fn load_wav(path: impl AsRef<Path>) -> Result<Self, String> {
        let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
        let spec = reader.spec();
        let samples: Vec<f32> = reader
            .samples::<i16>()
            .map(|s| s.unwrap_or(0) as f32 / 32768.0)
            .collect();

        Ok(Self {
            samples,
            sample_rate: spec.sample_rate,
            channels: spec.channels,
        })
    }

    pub fn save_wav(&self, path: impl AsRef<Path>) -> Result<(), String> {
        let spec = hound::WavSpec {
            channels: self.channels,
            sample_rate: self.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;

        for &sample in &self.samples {
            let amp = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
            writer.write_sample(amp).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Sampler configuration for TTS generation
#[derive(Debug, Clone)]
pub struct SamplerConfig {
    /// Temperature for sampling (higher = more random, 0.0 = greedy)
    pub temperature: f32,
    /// Top-K sampling (0 = disabled)
    pub top_k: i32,
    /// Top-P (nucleus) sampling (1.0 = disabled)
    pub top_p: f32,
    /// Min-P sampling threshold (0.0 = disabled)
    pub min_p: f32,
    /// Repeat penalty (1.0 = disabled)
    pub repeat_penalty: f32,
    /// Frequency penalty (0.0 = disabled)
    pub frequency_penalty: f32,
    /// Presence penalty (0.0 = disabled)
    pub presence_penalty: f32,
    /// Number of recent tokens to consider for penalties
    pub penalty_last_n: usize,
    /// Random seed for Talker (None = use speaker embedding hash)
    pub seed: Option<u64>,
    /// Random seed for Predictor (None = use same as seed)
    pub sub_seed: Option<u64>,
}

impl Default for SamplerConfig {
    fn default() -> Self {
        Self {
            temperature: 0.9, // 与原版一致
            top_k: 50,
            top_p: 1.0, // 与原版一致（禁用）
            min_p: 0.0,
            repeat_penalty: 1.05,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            penalty_last_n: 128,
            seed: None,
            sub_seed: None,
        }
    }
}

impl SamplerConfig {
    pub fn new(temperature: f32, top_k: i32, top_p: f32, seed: Option<u64>) -> Self {
        Self {
            temperature,
            top_k,
            top_p,
            min_p: 0.0,
            repeat_penalty: 1.05,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            penalty_last_n: 128,
            seed,
            sub_seed: None,
        }
    }

    pub fn with_penalties(
        mut self,
        min_p: f32,
        repeat_penalty: f32,
        frequency_penalty: f32,
        presence_penalty: f32,
        penalty_last_n: usize,
    ) -> Self {
        self.min_p = min_p;
        self.repeat_penalty = repeat_penalty;
        self.frequency_penalty = frequency_penalty;
        self.presence_penalty = presence_penalty;
        self.penalty_last_n = penalty_last_n;
        self
    }
}

/// Structured speaker info for API responses
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerInfo {
    pub id: String,
    pub name: Option<String>,
    pub gender: Option<String>,
    pub age: Option<String>,
}

/// Main TTS Engine Struct
///
/// IMPORTANT: Field ordering matters for Drop!
/// Rust drops fields in declaration order. Contexts MUST be declared before models
/// because context destructors reference model memory. If models are dropped first,
/// context destructors will access freed memory (ACCESS_VIOLATION).
pub struct TtsEngine {
    assets: Assets,
    tokenizer: Tokenizer,
    // ONNX Models
    encoder: Option<AudioEncoder>,
    speaker_encoder: Option<SpeakerEncoder>,
    decoder: Arc<Mutex<AudioDecoder>>,
    // Llama: Contexts MUST be listed before models for correct drop order
    talker_ctx: LlamaContext,
    predictor_ctx: LlamaContext,
    talker_model: Arc<LlamaModel>,
    predictor_model: Arc<LlamaModel>,

    // Speakers Cache
    speakers: HashMap<String, VoiceFile>,

    // Config
    _model_dir: PathBuf,
    max_steps: usize,
    sampler_config: SamplerConfig,
}

impl TtsEngine {
    /// Initialize the TTS Engine from the specified model directory.
    ///
    /// This function loads all necessary models (GGUF, Onnx, Tokenizer) from the given directory.
    /// It ensures that the essential components for inference are present.
    ///
    /// # Arguments
    ///
    /// * `model_dir` - Path to the directory containing model files.
    /// * `quant` - Quantization level (e.g., "none", "q5_k_m", "q8_0").
    /// * `n_threads` - Number of threads to use for generation (default: 4 if <= 0).
    pub async fn new(
        model_dir: impl AsRef<Path>,
        quant: &str,
        _n_threads: i32,
    ) -> Result<Self, String> {
        let model_dir = model_dir.as_ref();
        println!("Loading TtsEngine from: {:?} (quant: {})", model_dir, quant);

        // 0. Auto-download check (Models + Runtimes)
        Self::download_models(model_dir, quant).await?;

        let quant_dir = match quant {
            "q5_k_m" => "gguf_q5_k_m",
            "q4km" => "gguf_q4_k_m",
            "q8_0" => "gguf_q8_0",
            _ => "gguf",
        };

        // 1. Assets - 从量化目录加载（支持 Q8_0 反量化）
        let assets_path = model_dir.join(quant_dir);
        let assets =
            Assets::load(&assets_path).map_err(|e| format!("Failed to load assets: {}", e))?;
        println!(
            "Asset check text_table len: {}, head: {:?}",
            assets.text_table.len(),
            &assets.text_table[0..5.min(assets.text_table.len())]
        );

        // 2. Tokenizer
        let tokenizer =
            Tokenizer::load(model_dir).map_err(|e| format!("Failed to load tokenizer: {}", e))?;

        // 3. Initialize ONNX Runtime (must be called before any ONNX session)
        println!("Initializing ONNX Runtime...");
        crate::runtime::init_onnx_runtime()
            .map_err(|e| format!("Failed to init ONNX Runtime: {}", e))?;

        // 4. ONNX Models (Optional for preset mode, but good to have)
        let onnx_dir = model_dir.join("onnx");
        let encoder = AudioEncoder::load(
            &onnx_dir
                .join("qwen3_tts_codec_encoder.onnx")
                .to_string_lossy(),
        )
        .ok();

        let speaker_encoder = SpeakerEncoder::load(
            &onnx_dir
                .join("qwen3_tts_speaker_encoder.onnx")
                .to_string_lossy(),
        )
        .ok();

        // 5. Load GGUF Models
        let talker_path = model_dir.join(quant_dir).join("qwen3_tts_talker.gguf");
        let predictor_path = model_dir.join(quant_dir).join("qwen3_tts_predictor.gguf");

        log::info!("[TTS] Loading Talker model...");
        let talker_model = Arc::new(
            LlamaModel::load(&talker_path, 99)
                .map_err(|e| format!("Failed to load Talker: {}", e))?,
        );

        std::thread::sleep(std::time::Duration::from_secs(1));
        log::info!("[TTS] Loading Predictor model...");
        let predictor_model = Arc::new(
            LlamaModel::load(&predictor_path, 99)
                .map_err(|e| format!("Failed to load Predictor: {}", e))?,
        );

        // 5. Create Contexts
        // talker: n_ctx=4096, n_batch=2048, embeddings=1, threads=-1 (auto)
        let talker_ctx = LlamaContext::new(&talker_model, 4096, 2048, 1, -1)
            .map_err(|e| format!("Failed to create Talker context: {}", e))?;

        // predictor: n_ctx=512, n_batch=32, embeddings=0, threads=4
        let predictor_ctx = LlamaContext::new(&predictor_model, 512, 32, 0, 4)
            .map_err(|e| format!("Failed to create Predictor context: {}", e))?;

        // 6. 预加载 decoder（预热）
        println!("Pre-loading AudioDecoder...");
        let decoder =
            AudioDecoder::load(&onnx_dir.join("qwen3_tts_decoder.onnx").to_string_lossy())
                .map_err(|e| format!("Failed to load AudioDecoder: {}", e))?;
        let decoder = Arc::new(Mutex::new(decoder));
        println!("AudioDecoder pre-loaded and warmed up.");

        println!("TtsEngine loaded successfully.");

        let mut engine = Self {
            assets,
            tokenizer,
            encoder,
            speaker_encoder,
            decoder,
            talker_model,
            predictor_model,
            talker_ctx,
            predictor_ctx,
            speakers: HashMap::new(),
            _model_dir: model_dir.to_path_buf(),
            max_steps: 512, // 减小默认的 max_steps 避免超出 n_ctx (4096)
            sampler_config: SamplerConfig::default(),
        };

        // 6. Load Speakers
        let speakers_dir = model_dir.join("preset_speakers"); // Default to preset directory
        let speakers_dir = if speakers_dir.exists() {
            speakers_dir
        } else {
            PathBuf::from("speakers")
        };

        if speakers_dir.exists() {
            engine.load_speakers(&speakers_dir)?;
        }

        Ok(engine)
    }

    /// Set the maximum number of generation steps (tokens).
    pub fn set_max_steps(&mut self, steps: usize) {
        self.max_steps = steps;
    }

    /// Set the sampler configuration for generation.
    pub fn set_sampler_config(&mut self, config: SamplerConfig) {
        self.sampler_config = config;
    }

    /// Get the current sampler configuration.
    pub fn get_sampler_config(&self) -> &SamplerConfig {
        &self.sampler_config
    }

    /// Get mutable sampler configuration.
    pub fn get_sampler_config_mut(&mut self) -> &mut SamplerConfig {
        &mut self.sampler_config
    }

    /// Get the speakers map.
    pub fn get_speakers_map(&self) -> &HashMap<String, VoiceFile> {
        &self.speakers
    }

    /// Get structured list of all loaded speakers.
    pub fn get_speakers_list(&self) -> Vec<SpeakerInfo> {
        self.speakers
            .iter()
            .map(|(id, v)| SpeakerInfo {
                id: id.clone(),
                name: v.name.clone(),
                gender: v.gender.clone(),
                age: v.age.clone(),
            })
            .collect()
    }

    pub fn delete_speaker(&mut self, speaker_id: &str) -> Result<(), String> {
        let speakers_dir = self._model_dir.join("preset_speakers");
        let path = if speaker_id.contains('/') {
            let parts: Vec<&str> = speaker_id.splitn(2, '/').collect();
            speakers_dir
                .join(parts[0])
                .join(format!("{}.json", parts[1]))
        } else {
            speakers_dir.join(format!("{}.json", speaker_id))
        };
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        self.speakers.remove(speaker_id);
        Ok(())
    }

    pub fn update_speaker_meta(
        &mut self,
        speaker_id: &str,
        name: Option<String>,
        gender: Option<String>,
        age: Option<String>,
    ) -> Result<String, String> {
        let speakers_dir = self._model_dir.join("preset_speakers");
        let voice = self
            .speakers
            .get_mut(speaker_id)
            .ok_or_else(|| format!("Speaker not found: {}", speaker_id))?;
        if let Some(n) = name {
            voice.name = Some(n);
        }
        if let Some(a) = age {
            voice.age = Some(a);
        }

        let new_gender = gender.as_deref();
        let needs_move = new_gender.is_some() && speaker_id.contains('/');
        let old_dir = if speaker_id.contains('/') {
            speaker_id.split('/').next().unwrap_or("")
        } else {
            ""
        };
        let new_dir = new_gender.unwrap_or(old_dir);

        if needs_move && old_dir != new_dir {
            let stem = speaker_id
                .split_once('/')
                .map(|x| x.1)
                .unwrap_or(speaker_id);
            let old_path = speakers_dir.join(old_dir).join(format!("{}.json", stem));
            let new_dir_path = speakers_dir.join(new_dir);
            std::fs::create_dir_all(&new_dir_path).map_err(|e| e.to_string())?;
            let new_path = new_dir_path.join(format!("{}.json", stem));
            if old_path.exists() {
                std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
            }
            voice.gender = Some(new_dir.to_string());
            let new_id = format!("{}/{}", new_dir, stem);
            let removed = self.speakers.remove(speaker_id);
            if let Some(v) = removed {
                self.speakers.insert(new_id.clone(), v);
            }
            let voice = self.speakers.get_mut(&new_id).unwrap();
            voice.save(&new_path)?;
            Ok(new_id)
        } else {
            if let Some(g) = gender {
                voice.gender = Some(g);
            }
            let path = if speaker_id.contains('/') {
                let parts: Vec<&str> = speaker_id.splitn(2, '/').collect();
                speakers_dir
                    .join(parts[0])
                    .join(format!("{}.json", parts[1]))
            } else {
                speakers_dir.join(format!("{}.json", speaker_id))
            };
            voice.save(&path)?;
            Ok(speaker_id.to_string())
        }
    }

    /// Load all speakers from the specified directory.
    /// Supports both flat and nested directory structures:
    /// - Flat: `speakers_dir/*.json` (key = filename_stem)
    /// - Nested: `speakers_dir/{dirname}/*.json` (key = "{dirname}/{filename_stem}")
    pub fn load_speakers(&mut self, speakers_dir: impl AsRef<Path>) -> Result<(), String> {
        let speakers_dir = speakers_dir.as_ref();
        println!("Loading speakers from: {:?}", speakers_dir);

        let entries = std::fs::read_dir(speakers_dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();

            if path.is_dir() {
                let dir_name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown");
                let sub_entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
                for sub_entry in sub_entries {
                    let sub_entry = sub_entry.map_err(|e| e.to_string())?;
                    let sub_path = sub_entry.path();
                    if sub_path.extension().and_then(|s| s.to_str()) == Some("json") {
                        if let Ok(voice) = VoiceFile::load(&sub_path) {
                            let stem = sub_path
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("unknown");
                            let id = format!("{}/{}", dir_name, stem);
                            let mut v = voice;
                            v.audio_codes.clear();
                            self.speakers.insert(id, v);
                        }
                    }
                }
            } else if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(voice) = VoiceFile::load(&path) {
                    let id = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let mut v = voice;
                    v.audio_codes.clear();
                    self.speakers.insert(id, v);
                }
            }
        }
        println!("Loaded {} speakers.", self.speakers.len());
        Ok(())
    }

    /// Get a speaker by ID or name, with fallback to "vivian".
    pub fn get_speaker(&self, id_or_name: &str) -> &VoiceFile {
        if let Some(v) = self.speakers.get(id_or_name) {
            return v;
        }
        // Fallback to name match
        for v in self.speakers.values() {
            if let Some(ref name) = v.name {
                if name == id_or_name {
                    return v;
                }
            }
        }
        // Final fallback to vivian
        self.speakers.get("vivian").unwrap_or_else(|| {
            // Panic if even vivian is missing and cache is empty
            self.speakers
                .values()
                .next()
                .expect("No speakers loaded in engine!")
        })
    }

    /// Helper to download necessary files before loading.
    pub async fn download_models(_model_dir: impl AsRef<Path>, _quant: &str) -> Result<(), String> {
        // TODO: Implement download logic
        Ok(())
    }

    /// Generate speech from text using a reference audio.
    pub fn generate(
        &mut self,
        text: &str,
        ref_audio_path: impl AsRef<Path>,
        ref_text: &str,
        instruct: Option<&str>,
    ) -> Result<AudioSample, String> {
        let ref_audio_path = ref_audio_path.as_ref();

        // 1. Process Reference Audio
        let (ref_codes, spk_emb) = self.process_reference(ref_audio_path)?;

        // 2. Build Prompt
        // lang_id = 2055 (Chinese) hardcoded for now or parameterize later
        let ref_text_ids = self.tokenizer.encode(ref_text);
        let ref_codes_i32: Vec<i32> = ref_codes.iter().map(|&c| c as i32).collect();

        let prompt_data = PromptBuilder::build_clone_prompt(
            text,
            &self.tokenizer,
            &self.assets,
            &ref_codes_i32,
            &ref_text_ids,
            &spk_emb,
            2055,
            instruct,
        );

        self.run_inference(prompt_data)
    }

    /// Process reference audio to get codes and speaker embedding, using cache if available.
    fn process_reference(&mut self, audio_path: &Path) -> Result<(Vec<i64>, Vec<f32>), String> {
        let cache_path = audio_path.with_extension("cache");
        if cache_path.exists() {
            if let Ok((c, e)) = cache::load_cache(&cache_path) {
                return Ok((c, e));
            }
        }

        let audio = AudioSample::load_wav(audio_path)
            .map_err(|e| format!("Failed to load audio: {}", e))?;

        let ref_codes = self
            .encoder
            .as_mut()
            .ok_or("AudioEncoder not loaded (required for processing raw audio)".to_string())?
            .encode(&audio.samples)
            .map_err(|e| format!("Audio encode failed: {}", e))?;
        let spk_emb = self
            .speaker_encoder
            .as_mut()
            .ok_or("SpeakerEncoder not loaded (required for processing raw audio)".to_string())?
            .encode(&audio.samples)
            .map_err(|e| format!("Speaker extraction failed: {}", e))?;

        let _ = cache::save_cache(&cache_path, &ref_codes, &spk_emb);

        Ok((ref_codes, spk_emb))
    }

    // --- Helpers ---

    fn qwen3_position(start: i32, len: usize) -> Vec<i32> {
        let mut pos = Vec::with_capacity(len * 4);
        let range: Vec<i32> = (start..start + len as i32).collect();
        pos.extend_from_slice(&range); // Temporal
        pos.extend_from_slice(&range); // Height
        pos.extend_from_slice(&range); // Width
        pos.extend(std::iter::repeat_n(0, len)); // Channel
        pos
    }

    fn normal_position(cur_pos: usize, n_tokens: usize) -> Vec<i32> {
        (0..n_tokens).map(|i| (cur_pos + i) as i32).collect()
    }

    /// Create a VoiceFile from a reference audio file and its text.
    ///
    /// Requires that AudioEncoder and SpeakerEncoder are loaded.
    /// The reference audio MUST be 24000Hz.
    pub fn create_voice_file(
        &mut self,
        audio_path: impl AsRef<Path>,
        ref_text: String,
    ) -> Result<super::voice_file::VoiceFile, String> {
        let encoder = self.encoder.as_mut().ok_or(
            "AudioEncoder not loaded. Please ensure models/onnx/qwen3_tts_codec_encoder.onnx exists.",
        )?;
        let speaker_encoder = self.speaker_encoder.as_mut().ok_or(
            "SpeakerEncoder not loaded. Please ensure models/onnx/qwen3_tts_speaker_encoder.onnx exists.",
        )?;

        // 1. Load Audio
        let mut reader =
            hound::WavReader::open(audio_path).map_err(|e| format!("WAV error: {}", e))?;
        let spec = reader.spec();

        if spec.sample_rate != 24000 {
            return Err(format!(
                "Expected 24000Hz audio, found {}Hz",
                spec.sample_rate
            ));
        }

        let audio: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
            (hound::SampleFormat::Float, 32) => {
                reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect()
            }
            (hound::SampleFormat::Int, 16) => reader
                .samples::<i16>()
                .map(|s| (s.unwrap_or(0) as f32) / 32768.0)
                .collect(),
            (hound::SampleFormat::Int, 32) => reader
                .samples::<i32>()
                .map(|s| (s.unwrap_or(0) as f32) / 2147483648.0)
                .collect(),
            _ => {
                return Err(format!(
                    "Unsupported WAV format: {:?} {} bits",
                    spec.sample_format, spec.bits_per_sample
                ))
            }
        };

        // If stereo, take channel 1
        let audio = if spec.channels > 1 {
            audio.chunks(spec.channels as usize).map(|c| c[0]).collect()
        } else {
            audio
        };

        // 2. Run Encoders
        println!("Extracting audio codes...");
        let audio_codes = encoder.encode(&audio).map_err(|e| e.to_string())?;

        println!("Extracting speaker embedding...");
        let speaker_embedding = speaker_encoder.encode(&audio).map_err(|e| e.to_string())?;

        Ok(super::voice_file::VoiceFile::new(
            ref_text,
            audio_codes,
            speaker_embedding,
        ))
    }

    /// Generate speech using a pre-loaded VoiceFile.
    pub fn generate_with_voice(
        &mut self,
        text: &str,
        voice: &crate::tts::voice_file::VoiceFile,
        instruct: Option<&str>,
    ) -> Result<AudioSample, String> {
        self.generate_with_voice_streaming(text, voice, instruct, None)
    }

    /// Generate speech using a pre-loaded VoiceFile.
    pub fn generate_with_voice_streaming(
        &mut self,
        text: &str,
        voice: &crate::tts::voice_file::VoiceFile,
        instruct: Option<&str>,
        stream_tx: Option<std::sync::mpsc::Sender<Vec<f32>>>,
    ) -> Result<AudioSample, String> {
        // 文本预处理：限制重复字符次数
        let normalized_text = normalize_repeated_chars(text);
        // if normalized_text != text {
        //     println!("[TTS] Text normalized: '{}' -> '{}'", text, normalized_text);
        // }

        let prompt_data = if voice.audio_codes.is_empty() {
            PromptBuilder::build_core(
                &normalized_text,
                &self.tokenizer,
                &self.assets,
                Some(2055),
                None,
                Some(&voice.speaker_embedding),
                instruct,
                None,
            )
        } else {
            let ref_text_ids = self.tokenizer.encode(&voice.ref_text);
            let ref_codes_i32: Vec<i32> = voice.audio_codes.iter().map(|&c| c as i32).collect();

            Ok(PromptBuilder::build_clone_prompt(
                &normalized_text,
                &self.tokenizer,
                &self.assets,
                &ref_codes_i32,
                &ref_text_ids,
                &voice.speaker_embedding,
                2055,
                instruct,
            ))
        }?;

        let debug_info = DebugInfo {
            text: normalized_text.clone(),
            instruct: instruct.map(|s| s.to_string()),
            speaker_name: voice.name.clone(),
            max_steps: self.max_steps,
        };

        self.run_inference_stream(prompt_data, stream_tx, Some(debug_info))
    }

    fn run_inference(
        &mut self,
        prompt_data: crate::tts::prompt::PromptData,
    ) -> Result<AudioSample, String> {
        self.run_inference_stream(prompt_data, None, None)
    }

    fn run_inference_stream(
        &mut self,
        prompt_data: crate::tts::prompt::PromptData,
        stream_tx: Option<std::sync::mpsc::Sender<Vec<f32>>>,
        debug_info: Option<DebugInfo>,
    ) -> Result<AudioSample, String> {
        self.talker_ctx.clear_kv_cache();
        self.predictor_ctx.clear_kv_cache();

        let n_tokens_prompt = prompt_data.embd.len();
        let prompt_embeds_flat: Vec<f32> = prompt_data.embd.iter().flatten().copied().collect();
        let talker_embd = self.talker_model.n_embd;
        let predictor_embd = self.predictor_model.n_embd;

        let mut talker_batch = LlamaBatch::new(4096, talker_embd, 1, 4);
        let pos_arr = Self::qwen3_position(0, n_tokens_prompt);
        talker_batch.set_embd(&prompt_embeds_flat, &pos_arr, 0);

        self.talker_ctx
            .decode(&mut talker_batch)
            .map_err(|e| format!("Talker prefill failed: {}", e))?;

        let mut all_codes: Vec<i32> = Vec::new();
        let mut talker_history: Vec<i32> = Vec::new();
        let mut cur_pos = n_tokens_prompt;

        let mut predictor_batch = LlamaBatch::new(32, predictor_embd, 1, 1);

        // 使用 speaker embedding 生成确定性种子，保证同一说话人音色一致
        let seed = self.sampler_config.seed.unwrap_or_else(|| {
            // 基于 speaker embedding 计算确定性种子
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            hasher.write_usize(prompt_data.spk_emb.len());
            for &val in &prompt_data.spk_emb {
                hasher.write(&val.to_le_bytes());
            }
            let computed_seed = hasher.finish();
            println!(
                "[TTS] Computed seed from speaker embedding: {} (spk_emb len: {}, first 5 values: {:?})",
                computed_seed,
                prompt_data.spk_emb.len(),
                &prompt_data.spk_emb[..5.min(prompt_data.spk_emb.len())]
            );
            computed_seed
        });

        // 小模型（声学层）采样器：使用 sub_seed（如果设置了）或 seed
        let predictor_seed = self.sampler_config.sub_seed.unwrap_or(seed);
        println!(
            "[TTS] Talker seed: {}, Predictor seed: {}",
            seed, predictor_seed
        );
        let predictor_sampler = LlamaSampler::new(
            self.predictor_model.n_vocab,
            0.3, // 降低温度，提高声学层一致性
            50,  // 原版固定值
            1.0, // 原版固定值 (top_p=1.0 表示禁用)
            0.0, // min_p
            1.0, // repeat_penalty
            0.0, // frequency_penalty
            0.0, // presence_penalty
            0,   // penalty_last_n
            predictor_seed,
        );

        // 大模型（语义层）采样器：使用配置参数
        let talker_sampler = LlamaSampler::new(
            self.talker_model.n_vocab,
            self.sampler_config.temperature,
            self.sampler_config.top_k,
            self.sampler_config.top_p,
            self.sampler_config.min_p,
            self.sampler_config.repeat_penalty,
            self.sampler_config.frequency_penalty,
            self.sampler_config.presence_penalty,
            self.sampler_config.penalty_last_n,
            seed,
        );

        let (tx, rx) = std::sync::mpsc::channel::<(Vec<i64>, bool)>();

        let tts_pad = self.assets.tts_pad.clone();
        let decoder_arc = self.decoder.clone();

        let decoder_handle = std::thread::spawn(move || {
            let mut full_audio = Vec::new();
            let mut state = AudioDecoder::create_state();

            while let Ok((codes, is_final)) = rx.recv() {
                let n_frames = codes.len() / 16;
                // debug_print!("[Decoder] Received {} frames (is_final={})", n_frames, is_final);

                if n_frames == 0 {
                    if is_final {
                        let mut local_decoder = decoder_arc.lock().unwrap();
                        if let Ok(samples) = local_decoder.decode(&[], &mut state, true) {
                            if !samples.is_empty() {
                                debug_print!("[Decoder] Final flush: {} samples", samples.len());
                                if let Some(ref stx) = stream_tx {
                                    let _ = stx.send(samples.clone());
                                }
                                full_audio.extend(samples);
                            }
                        }
                        break;
                    }
                    continue;
                }

                let safe_codes: Vec<i64> = codes.iter().map(|&c| c.clamp(0, 2047)).collect();

                let mut local_decoder = decoder_arc.lock().unwrap();
                match local_decoder.decode(&safe_codes, &mut state, is_final) {
                    Ok(samples) => {
                        if !samples.is_empty() {
                            // debug_print!("[Decoder] Decoded {} samples", samples.len());
                            if let Some(ref stx) = stream_tx {
                                let _ = stx.send(samples.clone());
                            }
                            full_audio.extend(samples);
                        } else {
                            debug_print!(
                                "[Decoder] Decoded 0 samples (input frames: {})",
                                n_frames
                            );
                        }
                    }
                    Err(e) => {
                        debug_print!("[Decoder] Decode failed: {}", e);
                    }
                }
            }
            full_audio
        });

        // 多层联合静音检测参数
        // 第0层是语义码本，token 0-99 和 617 是静音相关特征
        const SEMANTIC_SILENT_THRESHOLD: i32 = 100;
        const EXTRA_SEMANTIC_SILENT_TOKENS: [i32; 1] = [617];
        // 第1-15层是声学码本，低索引token代表低能量/静音
        const ACOUSTIC_SILENT_THRESHOLD: i32 = 50;
        // 声学层静音比例阈值：超过这个比例的声学层是静音才判定为声学静音
        const ACOUSTIC_SILENT_RATIO: f32 = 0.7; // 70%以上声学层静音

        // 噪音检测参数
        // 噪音特征：语义层静音 但 声学层有能量（非静音）
        // 声学层活跃比例阈值：超过这个比例的声学层有能量才判定为噪音
        const NOISE_ACOUSTIC_ACTIVE_RATIO: f32 = 0.5; // 50%以上声学层有能量

        // 流式发送参数
        const SEND_INTERVAL: usize = 4;
        let mut last_sent_frame: usize = 0;

        // 声学码本重复检测参数
        const MAX_REPEATED_FRAMES: usize = 5; // 连续5帧相同视为异常（降低阈值，更快检测）
        let mut previous_acoustic_codes: Option<Vec<i32>> = None;
        let mut consecutive_repeated_frames: usize = 0;

        // 辅助函数：保存码本到文件（用于调试）
        let save_codes_to_file =
            |all_codes: &[i32], reason: &str, debug_info: &Option<DebugInfo>| {
                // 检查开关
                if !DEBUG_SAVE_CODES {
                    return;
                }

                // 创建调试目录（在 exe 所在目录下）
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                let debug_dir = exe_dir.join("debug_codes");
                if !debug_dir.exists() {
                    if let Err(e) = std::fs::create_dir_all(&debug_dir) {
                        eprintln!("[Debug] Failed to create debug directory: {}", e);
                        return;
                    }
                }

                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let filename = format!("codes_{}_{}.txt", timestamp, reason);
                let path = debug_dir.join(&filename);
                let mut content = String::new();

                // 写入调试信息
                content.push_str(&format!("# Debug codes dump - Reason: {}\n", reason));
                content.push_str(&format!("# Timestamp: {}\n", timestamp));
                content.push_str(&format!("# Total frames: {}\n", all_codes.len() / 16));
                content.push_str(&format!("# Total codes: {}\n\n", all_codes.len()));

                // 写入推理参数
                if let Some(info) = debug_info {
                    content.push_str("## Inference Info\n");
                    content.push_str(&format!(
                        "# Speaker: {}\n",
                        info.speaker_name.as_deref().unwrap_or("unknown")
                    ));
                    content.push_str(&format!("# Max steps: {}\n", info.max_steps));
                    if let Some(ref instruct) = info.instruct {
                        content.push_str(&format!("# Instruct: {}\n", instruct));
                    }
                    content.push_str(&format!("# Text: {}\n\n", info.text));
                }

                // 按帧格式化输出（每帧16个码本）
                content.push_str("## Codes\n");
                for (frame_idx, chunk) in all_codes.chunks(16).enumerate() {
                    content.push_str(&format!("Frame {:04}: ", frame_idx));
                    for (q, &code) in chunk.iter().enumerate() {
                        if q == 0 {
                            content.push_str(&format!("{:4}", code));
                        } else {
                            content.push_str(&format!(" {:4}", code));
                        }
                    }
                    content.push('\n');
                }

                match std::fs::write(path, &content) {
                    Ok(_) => println!("[Debug] Codes saved to: debug_codes/{}", filename),
                    Err(e) => eprintln!("[Debug] Failed to save codes: {}", e),
                }
            };

        debug_print!("[TTS] Starting loop: max_steps={}", self.max_steps);
        for step in 0..self.max_steps {
            debug_print!("[TTS] Step {}/{}: sampling talker...", step, self.max_steps);
            let allow_tokens: Vec<i32> = vec![2150, 2148, 2149];
            let sample_idx = if cur_pos == n_tokens_prompt {
                (n_tokens_prompt - 1) as i32
            } else {
                0
            };

            // 禁用惩罚机制，只保留检测和中断
            // 惩罚机制可能导致模型进入异常路径，生成循环噪音
            let penalty = 0.0;
            let _force_normal = false;
            let _penalty_active = false;

            let code_0 = talker_sampler.sample_with_silent_penalty(
                &self.talker_ctx,
                sample_idx,
                Some(0),
                Some(2048),
                Some(&allow_tokens),
                penalty,
                SEMANTIC_SILENT_THRESHOLD as usize,
                Some(&EXTRA_SEMANTIC_SILENT_TOKENS),
                Some(&talker_history),
            );

            debug_print!("[TTS] Sampled talker token: {}", code_0);
            talker_history.push(code_0);

            if code_0 == 2150 || code_0 == 151673 {
                println!("\n    EOS detected at step {} (code_0={})", step, code_0);
                break;
            }

            all_codes.push(code_0);

            // Predictor
            let emb_idx = if step == 0 { n_tokens_prompt - 1 } else { 0 };
            let m_hidden = self.talker_ctx.get_embedding_at(emb_idx).to_vec();

            let m_h_1024 = self.assets.project(&m_hidden);
            let code_0_1024 = self.assets.get_codec_embedding_1024(0, code_0);

            let mut predictor_input = Vec::with_capacity(2 * predictor_embd);
            predictor_input.extend_from_slice(&m_h_1024);
            predictor_input.extend_from_slice(&code_0_1024);

            self.predictor_ctx.clear_kv_cache();
            predictor_batch.clear();
            let pred_pos = Self::normal_position(0, 2);
            predictor_batch.set_embd(&predictor_input, &pred_pos, 0);

            debug_print!("[TTS] Decoding predictor prefill...");
            self.predictor_ctx
                .decode(&mut predictor_batch)
                .map_err(|e| format!("Predictor prefill failed: {}", e))?;

            let mut step_embeds_2048: Vec<Vec<f32>> = Vec::new();
            step_embeds_2048.push(self.assets.get_codec_embedding(0, code_0));

            // 收集声学码本 (第1-15层)
            let mut acoustic_codes: Vec<i32> = Vec::with_capacity(15);
            for q in 1..16 {
                let start_offset = (q - 1) * 2048;
                let end_offset = q * 2048;
                let sampled = predictor_sampler.sample(
                    &self.predictor_ctx,
                    0,
                    Some(start_offset),
                    Some(end_offset),
                );
                let code_q = sampled - start_offset as i32;
                all_codes.push(code_q);
                acoustic_codes.push(code_q);

                let emb = self.assets.get_codec_embedding(q, code_q);
                step_embeds_2048.push(emb.to_vec());

                if q < 15 {
                    let next_embed_1024 = self.assets.get_codec_embedding_1024(q, code_q);
                    let next_pos = Self::normal_position(q + 1, 1);
                    predictor_batch.clear();
                    predictor_batch.set_embd(&next_embed_1024, &next_pos, 0);
                    self.predictor_ctx
                        .decode(&mut predictor_batch)
                        .map_err(|e| format!("Predictor decode failed: {}", e))?;
                }
            }
            debug_print!(
                "[TTS] Predictor loop done. Codes count: {}",
                all_codes.len()
            );

            // 声学码本重复检测（检测无限循环噪音）
            let is_repeated_frame = if let Some(ref prev_codes) = previous_acoustic_codes {
                prev_codes == &acoustic_codes
            } else {
                false
            };

            if is_repeated_frame {
                consecutive_repeated_frames += 1;
            } else {
                consecutive_repeated_frames = 0;
            }
            previous_acoustic_codes = Some(acoustic_codes.clone());

            // 连续重复帧过多，判定为异常
            let is_loop_noise = consecutive_repeated_frames >= MAX_REPEATED_FRAMES;

            // 多层联合静音/噪音检测
            // 语义层静音：第0层是静音token
            let semantic_silent = code_0 < SEMANTIC_SILENT_THRESHOLD
                || EXTRA_SEMANTIC_SILENT_TOKENS.contains(&code_0);
            // 声学层静音：统计第1-15层中静音token的比例
            let acoustic_silent_count = acoustic_codes
                .iter()
                .filter(|&&c| c < ACOUSTIC_SILENT_THRESHOLD)
                .count();
            let acoustic_silent_ratio = acoustic_silent_count as f32 / acoustic_codes.len() as f32;
            let acoustic_silent = acoustic_silent_ratio >= ACOUSTIC_SILENT_RATIO;
            // 声学层活跃：声学层有能量（非静音）
            let acoustic_active_ratio = 1.0 - acoustic_silent_ratio;
            let acoustic_active = acoustic_active_ratio >= NOISE_ACOUSTIC_ACTIVE_RATIO;

            // 联合判断静音：语义静音 且 声学静音
            let is_silent_frame = semantic_silent && acoustic_silent;
            // 噪音判断：语义静音 但 声学活跃（有能量但无语义内容）
            let _is_noise_frame = semantic_silent && acoustic_active && !is_silent_frame;
            // 循环噪音检测：连续重复帧过多
            if is_loop_noise {
                println!(
                    "\n    [Debug] Loop noise detected: {} consecutive repeated frames",
                    consecutive_repeated_frames
                );
                save_codes_to_file(&all_codes, "loop_noise", &debug_info);
                break;
            }

            // 流式发送
            let current_frame = all_codes.len() / 16;

            if current_frame > last_sent_frame + SEND_INTERVAL {
                debug_print!("[TTS] Sending audio frame chunk...");
                let start_frame = last_sent_frame;
                let end_frame = last_sent_frame + SEND_INTERVAL;

                let start_idx = start_frame * 16;
                let end_idx = end_frame * 16;
                let frame_codes: Vec<i64> = all_codes[start_idx..end_idx]
                    .iter()
                    .map(|&c| c as i64)
                    .collect();

                let _ = tx.send((frame_codes, false));
                last_sent_frame += SEND_INTERVAL;
            }

            let mut feedback = vec![0.0f32; 2048];
            for embed in &step_embeds_2048 {
                for (i, val) in embed.iter().enumerate() {
                    feedback[i] += val;
                }
            }

            let text_vec = &tts_pad;
            for (i, val) in text_vec.iter().enumerate() {
                if i < feedback.len() {
                    feedback[i] += val;
                }
            }
            feedback.resize(talker_embd, 0.0);

            let talker_pos = Self::qwen3_position(cur_pos as i32, 1);
            talker_batch.clear();
            talker_batch.set_embd(&feedback, &talker_pos, 0);

            self.talker_ctx
                .decode(&mut talker_batch)
                .map_err(|e| format!("Talker step failed: {}", e))?;

            cur_pos += 1;
        }

        // 检查是否因为达到max_steps而结束（非正常结束）
        if all_codes.len() / 16 >= self.max_steps {
            println!(
                "\n    Warning: Reached max_steps limit ({}) with {} frames",
                self.max_steps,
                all_codes.len() / 16
            );
            save_codes_to_file(&all_codes, "max_steps", &debug_info);
        }

        // 发送剩余的帧
        let total_frames = all_codes.len() / 16;

        if total_frames > last_sent_frame {
            let start_frame = last_sent_frame;
            let end_frame = total_frames;

            let start_idx = start_frame * 16;
            let end_idx = end_frame * 16;
            let frame_codes: Vec<i64> = all_codes[start_idx..end_idx]
                .iter()
                .map(|&c| c as i64)
                .collect();

            let _ = tx.send((frame_codes, true));
        } else {
            let _ = tx.send((Vec::new(), true));
        }
        drop(tx);

        let audio_samples = decoder_handle
            .join()
            .map_err(|_| "Decoder thread panicked".to_string())?;

        Ok(AudioSample {
            samples: audio_samples,
            sample_rate: 24000,
            channels: 1,
        })
    }
}
