use crate::asr::audio::{load_audio, resample};
use crate::asr::encoder::AudioEncoder;
use crate::asr::gguf::GgufReader;
use crate::asr::llama::{LlamaBatch, LlamaContext, LlamaModel, LlamaSampler};
use std::path::Path;
use std::sync::Arc;

pub struct AsrEngine {
    encoder: AudioEncoder,
    model: Arc<LlamaModel>,
    context: LlamaContext,
    sampler: LlamaSampler,
    embedding_table: Vec<f32>,
    n_ctx: usize,
    encoder_n_embd: usize,
    id_im_start: i32,
    id_im_end: i32,
    id_audio_start: i32,
    id_audio_end: i32,
    id_asr_text: i32,
}

impl AsrEngine {
    pub fn load(model_dir: &Path, use_gpu: bool) -> Result<Self, String> {
        // println!("[ASR] Loading ASR Engine from {:?}", model_dir);

        let frontend_path = model_dir.join("qwen3_asr_encoder_frontend.int4.onnx");
        let backend_path = model_dir.join("qwen3_asr_encoder_backend.int4.onnx");
        let llm_path = model_dir.join("qwen3_asr_llm.q4_k.gguf");

        if !frontend_path.exists() {
            return Err(format!("Frontend not found: {:?}", frontend_path));
        }
        if !backend_path.exists() {
            return Err(format!("Backend not found: {:?}", backend_path));
        }
        if !llm_path.exists() {
            return Err(format!("LLM not found: {:?}", llm_path));
        }

        log::info!("[ASR] Loading LLM decoder...");
        let model = Arc::new(LlamaModel::load(&llm_path, if use_gpu { 99 } else { 0 })?);

        let n_ctx = 2048;
        let context = LlamaContext::new(&model, n_ctx as u32, 4096, 0, -1)?;
        let sampler = LlamaSampler::new(model.n_vocab, 0.4, 50, 1.0, 0.0, 1.15, 0.0, 0.0, 64, 42);

        // println!("[ASR] Loading token embeddings...");
        let gguf_reader =
            GgufReader::open(&llm_path).map_err(|e| format!("Failed to open GGUF: {}", e))?;
        let embedding_table = gguf_reader
            .read_token_embeddings()
            .map_err(|e| format!("Failed to read embeddings: {}", e))?;

        log::info!("[ASR] GPU warmup complete, loading encoder...");
        std::thread::sleep(std::time::Duration::from_secs(2));
        let encoder = AudioEncoder::load(&frontend_path, &backend_path, use_gpu)
            .map_err(|e| format!("Failed to load encoder: {}", e))?;

        let encoder_n_embd = encoder.n_embd_out();
        // println!(
        //     "[ASR] Token embeddings loaded: {} floats",
        //     embedding_table.len()
        // );

        // println!("[ASR] Engine loaded successfully!");
        let id_im_start = 151643;
        let id_audio_start = 151644;
        let id_im_end = 151645;
        let id_audio_end = 151646;

        // Try to resolve asr_text, or panic if not found (since we know it's critical)
        // Previous testing showed it might be 151704 or similar, NOT 151936.
        // Let's print all special tokens we care about to be sure.
        // println!("[ASR] Checking special tokens...");
        let id_asr_text = match Self::resolve_special_token(&model, &["<|asr_text|>", "<asr_text>"])
        {
            Ok(id) => {
                // println!("[ASR] Found <|asr_text|> = {}", id);
                id
            }
            Err(e) => {
                log::error!("[ASR] Failed to resolve <|asr_text|>: {}", e);
                log::error!("[ASR] Model: {:?}", llm_path);
                return Err(format!(
                    "Failed to resolve <|asr_text|> token in vocab. Model may be incompatible. Error: {}",
                    e
                ));
            }
        };

        Ok(Self {
            encoder,
            model,
            context,
            sampler,
            embedding_table,
            n_ctx,
            encoder_n_embd,
            id_im_start,
            id_im_end,
            id_audio_start,
            id_audio_end,
            id_asr_text,
        })
    }

    pub fn transcribe(
        &mut self,
        audio_path: &Path,
        language: Option<&str>,
    ) -> Result<String, String> {
        // println!("[ASR] Transcribing: {:?}", audio_path);

        let (audio, sample_rate) = load_audio(audio_path)?;

        let audio_16k = if sample_rate != 16000 {
            resample(&audio, sample_rate, 16000)
        } else {
            audio
        };

        self.decode(&audio_16k, language)
    }

    pub fn decode(&mut self, audio_16k: &[f32], language: Option<&str>) -> Result<String, String> {
        // 识别入口诊断：样本数/时长/能量（ASR 排障用）
        {
            let sum_sq: f64 = audio_16k.iter().map(|s| (*s as f64) * (*s as f64)).sum();
            let rms = (sum_sq / audio_16k.len().max(1) as f64).sqrt();
            log::info!(
                "[ASR] decode: samples={} (~{}ms), rms={:.4}",
                audio_16k.len(),
                audio_16k.len() * 1000 / 16000,
                rms
            );
        }
        let audio_embd = self
            .encoder
            .encode(audio_16k)
            .map_err(|e| format!("Encoding failed: {}", e))?;

        let mut prefix_text = String::new();
        let max_retries = 2;
        // Greedy decoding first (ASR hallucination loops are amplified by
        // sampling noise); only heat up after a loop is detected.
        let base_temp = 0.0;
        let base_penalty = 1.15;

        for attempt in 0..=max_retries {
            let temp = if attempt == 0 {
                0.0
            } else {
                0.2 + attempt as f32 * 0.2
            };
            let penalty = base_penalty + attempt as f32 * 0.1;
            self.sampler.set_temperature(temp);
            self.sampler.set_repeat_penalty(penalty);

            let prompt_embd = self.build_prompt_embd(
                &audio_embd,
                &prefix_text,
                "You are a helpful assistant.",
                language,
            )?;
            let (chunk, loop_detected) = self.generate_chunk(&prompt_embd)?;

            prefix_text.push_str(&chunk);

            if !loop_detected {
                break;
            }

            log::warn!(
                "[ASR] Loop detected on attempt {}, retrying with temp={:.2}, penalty={:.2}",
                attempt,
                temp,
                penalty
            );
        }

        self.sampler.set_temperature(base_temp);
        self.sampler.set_repeat_penalty(base_penalty);

        let deduped = self.dedup_repetitions(&prefix_text);
        Ok(deduped)
    }

    fn build_prompt_embd(
        &self,
        audio_embd: &[f32],
        prefix_text: &str,
        context: &str,
        language: Option<&str>,
    ) -> Result<Vec<f32>, String> {
        if self.encoder_n_embd != self.model.n_embd {
            return Err(format!(
                "Embedding dim mismatch: encoder={} model={}",
                self.encoder_n_embd, self.model.n_embd
            ));
        }
        if !audio_embd.len().is_multiple_of(self.model.n_embd) {
            return Err("Audio embeddings shape is invalid".to_string());
        }

        let prefix_tokens = self.build_prompt_prefix(context);
        let suffix_tokens = self.build_prompt_suffix(language, prefix_text);
        let n_pre = prefix_tokens.len();
        let n_aud = audio_embd.len() / self.model.n_embd;
        let n_suf = suffix_tokens.len();
        let total_len = n_pre + n_aud + n_suf;
        if total_len > self.n_ctx {
            return Err(format!(
                "Context overflow: total_len={} n_ctx={}",
                total_len, self.n_ctx
            ));
        }

        let mut full_embd = vec![0.0f32; total_len * self.model.n_embd];
        self.copy_tokens_to_embd(&prefix_tokens, &mut full_embd, 0);
        self.copy_embeddings_to_embd(audio_embd, &mut full_embd, n_pre * self.model.n_embd);
        self.copy_tokens_to_embd(
            &suffix_tokens,
            &mut full_embd,
            (n_pre + n_aud) * self.model.n_embd,
        );
        Ok(full_embd)
    }

    fn generate_chunk(&mut self, full_embd: &[f32]) -> Result<(String, bool), String> {
        let total_len = full_embd.len() / self.model.n_embd;

        let pos_base: Vec<i32> = (0..total_len as i32).collect();
        let pos_arr: Vec<i32> = pos_base
            .iter()
            .chain(pos_base.iter())
            .chain(pos_base.iter())
            .chain(std::iter::repeat_n(&0, total_len))
            .copied()
            .collect();

        let mut batch = LlamaBatch::new((total_len * 4).max(8192), self.model.n_embd, 1, 4);
        batch.set_embd(full_embd, &pos_arr, 0);

        self.context.clear_kv_cache();
        self.context.decode(&mut batch)?;

        let mut tokens = Vec::new();
        let mut last_token = -1;
        let mut repeat_count = 0;
        let mut loop_detected = false;

        for _i in 0..512 {
            let token =
                self.sampler
                    .sample_with_allow(&self.context, 0, None, None, None, Some(&tokens));

            if token == self.model.eos_token || token == self.id_im_end {
                break;
            }

            // Single-token rapid repeat detection
            if token == last_token {
                repeat_count += 1;
                if repeat_count > 5 {
                    // Drop the consecutive repeated tokens so the polluted
                    // prefix never feeds back into the retry prompt.
                    let keep = tokens.len().saturating_sub(repeat_count);
                    tokens.truncate(keep);
                    loop_detected = true;
                    break;
                }
            } else {
                repeat_count = 0;
            }
            last_token = token;

            // Short-sequence loop detection (2-token or 3-token cycles)
            tokens.push(token);
            if let Some(truncate_at) = Self::detect_short_loop(&tokens) {
                tokens.truncate(truncate_at);
                loop_detected = true;
                break;
            }

            if let Err(_e) = self.context.decode_token(token) {
                break;
            }
        }

        let text = self.decode_tokens(&tokens);
        let cleaned = Self::clean_text(&text);
        Ok((cleaned, loop_detected))
    }

    fn detect_short_loop(tokens: &[i32]) -> Option<usize> {
        let n = tokens.len();
        if n < 6 {
            return None;
        }
        for period in [2, 3] {
            if n >= period * 3 {
                let last = &tokens[n - period * 3..];
                let pattern = &last[..period];
                let mut ok = true;
                for chunk in last.chunks(period) {
                    if chunk != pattern {
                        ok = false;
                        break;
                    }
                }
                if ok {
                    return Some(n - period * 3);
                }
            }
        }
        None
    }

    fn build_prompt_prefix(&self, context: &str) -> Vec<i32> {
        let mut tokens = vec![self.id_im_start];
        let system_str = format!("system\n{}", context);
        tokens.extend(self.model.tokenize(&system_str, false, true));
        tokens.push(self.id_im_end);

        tokens.push(self.id_im_start);
        let user_str = "user\n";
        tokens.extend(self.model.tokenize(user_str, false, true));
        tokens.push(self.id_audio_start);
        tokens
    }

    fn build_prompt_suffix(&self, language: Option<&str>, prefix_text: &str) -> Vec<i32> {
        let mut tokens = vec![self.id_audio_end];
        tokens.push(self.id_im_end);
        tokens.push(self.id_im_start);

        let mut suffix_head = "assistant\n".to_string();
        // NOTE: In Qwen3 ASR Python code, it just appends "language {lang}".
        // But some impls might need a newline?
        // Based on Python `self.tokenizer.encode(f"language {language}")`, it doesn't add explicit newline.
        if let Some(lang) = language {
            suffix_head.push_str(&format!("language {}", lang));
        }

        // IMPORTANT: We must NOT enable special tokens here for normal text!
        tokens.extend(self.model.tokenize(&suffix_head, false, true));

        // Append <|asr_text|> (critical trigger)
        tokens.push(self.id_asr_text);

        if !prefix_text.is_empty() {
            // Prefix text (like previous chunk context)
            tokens.extend(self.model.tokenize(prefix_text, false, true));
        }

        tokens
    }

    fn copy_tokens_to_embd(&self, tokens: &[i32], embd: &mut [f32], offset: usize) {
        let n_embd = self.model.n_embd;
        for (i, &token) in tokens.iter().enumerate() {
            let token_idx = token as usize;
            if token_idx * n_embd + n_embd > self.embedding_table.len() {
                continue;
            }
            let embd_offset = token_idx * n_embd;
            for j in 0..n_embd {
                embd[offset + i * n_embd + j] = self.embedding_table[embd_offset + j];
            }
        }
    }

    fn copy_embeddings_to_embd(&self, src: &[f32], dst: &mut [f32], offset: usize) {
        let count = src.len().min(dst.len().saturating_sub(offset));
        log::debug!(
            "[ASR] Copying {} audio embeddings ({} tokens) at offset {}",
            count,
            count / self.encoder_n_embd,
            offset
        );
        dst[offset..offset + count].copy_from_slice(&src[..count]);
    }

    pub fn decode_tokens(&self, tokens: &[i32]) -> String {
        let mut bytes = Vec::new();
        for &token_id in tokens {
            if let Some(piece) = self.model.token_to_piece_bytes(token_id) {
                bytes.extend_from_slice(&piece);
            }
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let text = text.replace("<|im_start|>", "");
        let text = text.replace("<|im_end|>", "");
        let text = text.replace("<|audio_start|>", "");
        let text = text.replace("<|audio_end|>", "");
        let text = text.replace("<|asr_text|>", "");

        text.trim().to_string()
    }

    #[allow(dead_code)]
    fn qwen3_position(start: i32, len: usize) -> Vec<i32> {
        let mut pos = Vec::with_capacity(len * 4);
        let range: Vec<i32> = (start..start + len as i32).collect();
        pos.extend_from_slice(&range);
        pos.extend_from_slice(&range);
        pos.extend_from_slice(&range);
        pos.extend(std::iter::repeat_n(0, len));
        pos
    }

    fn resolve_special_token(model: &LlamaModel, candidates: &[&str]) -> Result<i32, String> {
        for &token in candidates {
            let tokens = model.tokenize(token, false, true);
            if tokens.len() == 1 {
                return Ok(tokens[0]);
            }
        }

        for token_id in 0..model.n_vocab as i32 {
            if let Some(text) = model.token_to_piece(token_id) {
                let trimmed = text.trim();
                for &candidate in candidates {
                    if trimmed == candidate {
                        return Ok(token_id);
                    }
                }
            }
        }

        Err(format!(
            "Special token not found in vocab: {:?}",
            candidates
        ))
    }

    fn clean_text(text: &str) -> String {
        let mut cleaned = text
            .replace("====解码有误，强制熔断====", "")
            .replace("<|im_start|>", "")
            .replace("<|im_end|>", "")
            .replace("<|audio_start|>", "")
            .replace("<|audio_end|>", "")
            .replace("<|asr_text|>", "")
            .replace("<asr_text>", "");

        let prefixes = [
            "system",
            "user",
            "assistant",
            "language Chinese",
            "language English",
            "You are a helpful assistant.",
        ];

        loop {
            let mut changed = false;
            let trimmed = cleaned.trim_start().to_string();
            for prefix in prefixes {
                if let Some(rest) = trimmed.strip_prefix(prefix) {
                    cleaned = rest.trim_start().to_string();
                    changed = true;
                    break;
                }
            }
            if !changed {
                cleaned = trimmed;
                break;
            }
        }

        cleaned.trim().to_string()
    }

    fn dedup_repetitions(&self, text: &str) -> String {
        let chars: Vec<char> = text.chars().collect();
        let mut result = chars.clone();

        for unit_len in (2..=4).rev() {
            let min_repeats = if unit_len >= 3 { 2 } else { 3 };
            result = Self::compress_repeats(&result, unit_len, min_repeats);
        }

        result = Self::compress_single_char_repeats(&result, 4);

        result.into_iter().collect()
    }

    fn compress_repeats(chars: &[char], unit_len: usize, min_repeats: usize) -> Vec<char> {
        if chars.len() < unit_len * min_repeats {
            return chars.to_vec();
        }
        let mut out = Vec::with_capacity(chars.len());
        let mut i = 0;
        while i < chars.len() {
            if i + unit_len * min_repeats <= chars.len() {
                let unit = &chars[i..i + unit_len];
                let mut repeats = 1;
                while i + repeats * unit_len + unit_len <= chars.len()
                    && &chars[i + repeats * unit_len..i + repeats * unit_len + unit_len] == unit
                {
                    repeats += 1;
                }
                if repeats >= min_repeats {
                    out.extend_from_slice(unit);
                    i += repeats * unit_len;
                    continue;
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        out
    }

    fn compress_single_char_repeats(chars: &[char], min_repeats: usize) -> Vec<char> {
        let mut out = Vec::with_capacity(chars.len());
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            let mut count = 1;
            while i + count < chars.len() && chars[i + count] == c {
                count += 1;
            }
            if count >= min_repeats {
                out.push(c);
            } else {
                out.extend(std::iter::repeat_n(c, count));
            }
            i += count;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compress_single_char_repeats() {
        let input: Vec<char> = "好好好好好".chars().collect();
        let result = AsrEngine::compress_single_char_repeats(&input, 4);
        assert_eq!(result.into_iter().collect::<String>(), "好");

        let input2: Vec<char> = "哈哈哈".chars().collect();
        let result2 = AsrEngine::compress_single_char_repeats(&input2, 4);
        assert_eq!(result2.into_iter().collect::<String>(), "哈哈哈");
    }

    #[test]
    fn test_compress_repeats() {
        let input: Vec<char> = "的是的是的是的是".chars().collect();
        let result = AsrEngine::compress_repeats(&input, 2, 3);
        assert_eq!(result.into_iter().collect::<String>(), "的是");

        let input2: Vec<char> = "你好你好你好".chars().collect();
        let result2 = AsrEngine::compress_repeats(&input2, 2, 3);
        assert_eq!(result2.into_iter().collect::<String>(), "你好");
    }

    #[test]
    fn test_detect_short_loop() {
        // Full sequence is a 3-token cycle: ABCABCABC -> truncate at 0
        let tokens = vec![1, 2, 3, 1, 2, 3, 1, 2, 3];
        assert_eq!(AsrEngine::detect_short_loop(&tokens), Some(0));

        // Prefix is non-loop, then ABABAB cycle -> truncate at 3
        let tokens2 = vec![0, 1, 2, 1, 2, 1, 2, 1, 2];
        assert_eq!(AsrEngine::detect_short_loop(&tokens2), Some(3));

        // No loop
        let tokens3 = vec![1, 2, 3, 4, 5];
        assert_eq!(AsrEngine::detect_short_loop(&tokens3), None);
    }
}
