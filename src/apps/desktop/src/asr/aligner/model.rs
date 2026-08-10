//! GGUF model loader for the Qwen3-ForcedAligner.
//!
//! Reads all metadata + tensors via [`super::super::gguf::GgufReader`] and
//! stores them in row-major format for straightforward use with the
//! [`super::math`] primitives.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use super::super::gguf::{GgufReader, MetaValue};

/// Hyperparameters for the Qwen3-ForcedAligner (defaults match the
/// `parse_hparams` defaults in `forced_aligner.cpp`).
#[derive(Debug, Clone)]
pub struct HParams {
    // Audio encoder
    pub audio_encoder_layers: i32,
    pub audio_d_model: i32,
    pub audio_attention_heads: i32,
    pub audio_ffn_dim: i32,
    pub audio_num_mel_bins: i32,
    pub audio_conv_channels: i32,
    pub audio_layer_norm_eps: f32,
    // Text decoder
    pub text_decoder_layers: i32,
    pub text_hidden_size: i32,
    pub text_attention_heads: i32,
    pub text_kv_heads: i32,
    pub text_intermediate_size: i32,
    pub text_head_dim: i32,
    pub text_rms_norm_eps: f32,
    pub text_rope_theta: f32,
    pub vocab_size: i32,
    // Classification head
    pub classify_num: i32,
    // Special tokens
    pub timestamp_token_id: i32,
    pub audio_start_token_id: i32,
    pub audio_end_token_id: i32,
    pub audio_pad_token_id: i32,
    // Timestamp conversion (milliseconds)
    pub timestamp_segment_time_ms: i32,
}

impl Default for HParams {
    fn default() -> Self {
        Self {
            audio_encoder_layers: 24,
            audio_d_model: 1024,
            audio_attention_heads: 16,
            audio_ffn_dim: 4096,
            audio_num_mel_bins: 128,
            audio_conv_channels: 480,
            audio_layer_norm_eps: 1e-5,
            text_decoder_layers: 28,
            text_hidden_size: 1024,
            text_attention_heads: 16,
            text_kv_heads: 8,
            text_intermediate_size: 3072,
            text_head_dim: 128,
            text_rms_norm_eps: 1e-6,
            text_rope_theta: 1_000_000.0,
            vocab_size: 152_064,
            classify_num: 5000,
            timestamp_token_id: 151_705,
            audio_start_token_id: 151_669,
            audio_end_token_id: 151_670,
            audio_pad_token_id: 151_676,
            timestamp_segment_time_ms: 80,
        }
    }
}

/// A tensor stored in row-major f32 with an explicit shape.
#[derive(Debug, Clone)]
pub struct Tensor {
    pub shape: Vec<usize>, // row-major, e.g. [out, in] for 2D linear weights
    pub data: Vec<f32>,
}

impl Tensor {
    pub fn numel(&self) -> usize {
        self.shape.iter().product()
    }
}

/// The full ForcedAligner model: hparams + tensor cache + BPE vocab/merges.
pub struct ForcedAlignerModel {
    hparams: HParams,
    tensors: HashMap<String, Tensor>,
    /// Vocab: token ID → surface form (already in BPE-unicode space, e.g. "Ġthe").
    pub vocab: Vec<String>,
    /// Reverse lookup: surface form → token ID.
    pub token_to_id: HashMap<String, i32>,
    /// BPE merge ranks: "first second" → priority (lower = merge first).
    pub bpe_ranks: HashMap<String, i32>,
}

impl ForcedAlignerModel {
    pub fn hparams(&self) -> &HParams {
        &self.hparams
    }

    pub fn get(&self, name: &str) -> Option<&Tensor> {
        self.tensors.get(name)
    }

    /// Get a tensor or return an error mentioning what's missing.
    pub fn require(&self, name: &str) -> Result<&Tensor, String> {
        self.tensors
            .get(name)
            .ok_or_else(|| format!("Required tensor '{}' not found in GGUF", name))
    }

    /// Load (and cache) the model from `path`.
    pub fn load(path: &Path) -> Result<&'static ForcedAlignerModel, String> {
        static CACHE: OnceLock<Result<ForcedAlignerModel, String>> = OnceLock::new();
        let err = CACHE.get_or_init(|| Self::load_inner(path));
        match err {
            Ok(m) => Ok(m),
            Err(e) => Err(e.clone()),
        }
    }

    fn load_inner(path: &Path) -> Result<ForcedAlignerModel, String> {
        log::info!("[FA] loading ForcedAligner GGUF: {}", path.display());
        let reader = GgufReader::open(path).map_err(|e| format!("GGUF open failed: {e}"))?;

        let hparams = Self::parse_hparams(&reader);
        let tensors = Self::load_all_tensors(&reader)?;
        let (vocab, token_to_id, bpe_ranks) = Self::load_vocab(&reader)?;

        log::info!(
            "[FA] model loaded: {} tensors, vocab={}, merges={}",
            tensors.len(),
            vocab.len(),
            bpe_ranks.len()
        );

        Ok(ForcedAlignerModel {
            hparams,
            tensors,
            vocab,
            token_to_id,
            bpe_ranks,
        })
    }

    fn parse_hparams(reader: &GgufReader) -> HParams {
        let mut hp = HParams::default();
        let get_u32 = |key: &str, default: i32| -> i32 {
            reader.meta_u32(key).map(|v| v as i32).unwrap_or(default)
        };
        let get_f32 = |key: &str, default: f32| -> f32 { reader.meta_f32(key).unwrap_or(default) };

        hp.audio_encoder_layers = get_u32(
            "qwen3-asr.audio.encoder.layer_count",
            hp.audio_encoder_layers,
        );
        hp.audio_d_model = get_u32("qwen3-asr.audio.encoder.embedding_length", hp.audio_d_model);
        hp.audio_attention_heads = get_u32(
            "qwen3-asr.audio.encoder.attention.head_count",
            hp.audio_attention_heads,
        );
        hp.audio_ffn_dim = get_u32(
            "qwen3-asr.audio.encoder.feed_forward_length",
            hp.audio_ffn_dim,
        );
        hp.audio_num_mel_bins = get_u32("qwen3-asr.audio.num_mel_bins", hp.audio_num_mel_bins);
        hp.audio_conv_channels = get_u32("qwen3-asr.audio.conv_channels", hp.audio_conv_channels);

        hp.text_decoder_layers = get_u32("qwen3-asr.block_count", hp.text_decoder_layers);
        hp.text_hidden_size = get_u32("qwen3-asr.embedding_length", hp.text_hidden_size);
        hp.text_attention_heads =
            get_u32("qwen3-asr.attention.head_count", hp.text_attention_heads);
        hp.text_kv_heads = get_u32("qwen3-asr.attention.head_count_kv", hp.text_kv_heads);
        hp.text_intermediate_size =
            get_u32("qwen3-asr.feed_forward_length", hp.text_intermediate_size);
        hp.text_head_dim = get_u32("qwen3-asr.attention.key_length", hp.text_head_dim);
        hp.text_rms_norm_eps = get_f32(
            "qwen3-asr.attention.layer_norm_rms_epsilon",
            hp.text_rms_norm_eps,
        );
        hp.text_rope_theta = get_f32("qwen3-asr.rope.freq_base", hp.text_rope_theta);
        hp.vocab_size = get_u32("qwen3-asr.vocab_size", hp.vocab_size);

        hp.classify_num = get_u32("qwen3-asr.classify_num", hp.classify_num);
        hp.timestamp_token_id = get_u32("qwen3-asr.timestamp_token_id", hp.timestamp_token_id);
        hp.audio_start_token_id =
            get_u32("qwen3-asr.audio.start_token_id", hp.audio_start_token_id);
        hp.audio_end_token_id = get_u32("qwen3-asr.audio.end_token_id", hp.audio_end_token_id);
        hp.audio_pad_token_id = get_u32("qwen3-asr.audio.pad_token_id", hp.audio_pad_token_id);

        log::info!("[FA] hparams: {:?}", hp);
        hp
    }

    /// Read every tensor from the GGUF and convert to row-major.
    fn load_all_tensors(reader: &GgufReader) -> Result<HashMap<String, Tensor>, String> {
        let mut out = HashMap::new();
        for meta in reader.list_tensors() {
            let data = reader
                .read_tensor_by_meta(meta)
                .map_err(|e| format!("Failed to read tensor '{}': {e}", meta.name))?;
            let row_shape = Self::to_row_major_shape(&meta.shape, meta.type_id, meta.name.as_str());
            // For 4D conv2d weights we need an actual data transpose; for
            // 1D/2D the storage already matches the row-major interpretation
            // when the shape is flipped (GGML stores ne[0] as the innermost
            // dim, which equals row-major with reversed axes).
            let row_data = if meta.shape.len() == 4 {
                Self::transpose_4d_to_row_major(&data, &meta.shape)
            } else {
                data
            };
            out.insert(
                meta.name.clone(),
                Tensor {
                    shape: row_shape,
                    data: row_data,
                },
            );
        }
        Ok(out)
    }

    /// Compute the row-major shape for a GGUF tensor.
    /// For 1D/2D: just reverse the GGUF ne[] axes (data is unchanged).
    /// For 4D conv2d: produce `[out_c, in_c, kh, kw]` and transpose data.
    fn to_row_major_shape(gguf_shape: &[usize], _type_id: u32, name: &str) -> Vec<usize> {
        match gguf_shape.len() {
            1 => gguf_shape.to_vec(),
            2 => vec![gguf_shape[1], gguf_shape[0]], // [in, out] → [out, in]
            4 => {
                // GGUF conv2d weight: [kw, kh, in_c, out_c] (ne[0..3]).
                // Row-major target: [out_c, in_c, kh, kw].
                // Sanity check: kernel dims should be small (3, 3) for this model.
                let kw = gguf_shape[0];
                let kh = gguf_shape[1];
                let in_c = gguf_shape[2];
                let out_c = gguf_shape[3];
                log::trace!(
                    "[FA] conv2d tensor '{}': GGUF [kw={}, kh={}, in_c={}, out_c={}]",
                    name,
                    kw,
                    kh,
                    in_c,
                    out_c
                );
                vec![out_c, in_c, kh, kw]
            }
            other => {
                log::warn!(
                    "[FA] tensor '{}' has unexpected ndim={} (shape={:?}) — keeping as-is",
                    name,
                    other,
                    gguf_shape
                );
                gguf_shape.iter().rev().copied().collect()
            }
        }
    }

    /// Transpose a 4D GGUF tensor `[n0, n1, n2, n3]` (col-major, n0 innermost)
    /// to row-major `[n3, n2, n1, n0]`.
    fn transpose_4d_to_row_major(data: &[f32], gguf_shape: &[usize]) -> Vec<f32> {
        let n0 = gguf_shape[0];
        let n1 = gguf_shape[1];
        let n2 = gguf_shape[2];
        let n3 = gguf_shape[3];
        let total = n0 * n1 * n2 * n3;
        debug_assert_eq!(data.len(), total);
        let mut out = vec![0.0_f32; total];
        for i3 in 0..n3 {
            for i2 in 0..n2 {
                for i1 in 0..n1 {
                    for i0 in 0..n0 {
                        let col_idx = i0 + n0 * i1 + n0 * n1 * i2 + n0 * n1 * n2 * i3;
                        let row_idx = i3 * (n2 * n1 * n0) + i2 * (n1 * n0) + i1 * n0 + i0;
                        out[row_idx] = data[col_idx];
                    }
                }
            }
        }
        out
    }

    /// Load BPE vocab + merge ranks from GGUF metadata.
    #[allow(clippy::type_complexity)]
    fn load_vocab(
        reader: &GgufReader,
    ) -> Result<(Vec<String>, HashMap<String, i32>, HashMap<String, i32>), String> {
        let vocab: Vec<String> = match reader.metadata().get("tokenizer.ggml.tokens") {
            Some(MetaValue::Array(arr)) => arr
                .iter()
                .map(|v| v.as_string().unwrap_or("").to_string())
                .collect(),
            _ => return Err("tokenizer.ggml.tokens not found in GGUF".into()),
        };

        let mut token_to_id = HashMap::with_capacity(vocab.len());
        for (i, s) in vocab.iter().enumerate() {
            token_to_id.insert(s.clone(), i as i32);
        }

        let mut bpe_ranks = HashMap::new();
        if let Some(MetaValue::Array(arr)) = reader.metadata().get("tokenizer.ggml.merges") {
            for (i, v) in arr.iter().enumerate() {
                if let Some(s) = v.as_string() {
                    bpe_ranks.insert(s.to_string(), i as i32);
                }
            }
        }

        Ok((vocab, token_to_id, bpe_ranks))
    }
}
