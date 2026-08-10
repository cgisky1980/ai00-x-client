use super::assets::Assets;
use super::tokenizer::Tokenizer;

// Constants from PROTOCOL
pub const PAD: usize = 2148;
pub const BOS: usize = 2149;
pub const EOS: usize = 2150;
pub const BOS_TOKEN: usize = 151672;
pub const EOS_TOKEN: usize = 151673;
pub const THINK: usize = 2154;
pub const NOTHINK: usize = 2155;
pub const THINK_BOS: usize = 2156;
pub const THINK_EOS: usize = 2157;

// Magic token derived from Python implementation (assets.text_table[151671])
pub const TEXT_AUDIO_MARKER: usize = 151671;

pub struct PromptData {
    pub embd: Vec<Vec<f32>>,
    pub text_ids: Vec<u32>,
    pub spk_emb: Vec<f32>,
}

pub struct PromptBuilder;

impl PromptBuilder {
    #[allow(clippy::too_many_arguments)]
    pub fn build_clone_prompt(
        text: &str,
        tokenizer: &Tokenizer,
        assets: &Assets,
        ref_codes: &[i32],
        ref_text_ids: &[u32],
        spk_emb: &[f32],
        lang_id: usize,
        instruct: Option<&str>,
    ) -> PromptData {
        let tts_pad = &assets.tts_pad;

        let text_ids = tokenizer.encode(text);
        let mut text_pool_ids: Vec<u32> = ref_text_ids.to_vec();
        text_pool_ids.extend(text_ids.iter().copied());
        text_pool_ids.push(EOS_TOKEN as u32);

        let text_pool: Vec<Vec<f32>> = text_pool_ids
            .iter()
            .map(|&id| assets.get_text_embedding(id as usize))
            .collect();

        let mut audio_pool: Vec<Vec<f32>> = Vec::new();
        audio_pool.push(assets.get_codec_embedding(0, BOS as i32));

        let n_steps = ref_codes.len() / 16;
        for step in 0..n_steps {
            let mut step_sum = vec![0.0f32; 2048];
            for q in 0..16 {
                let c = ref_codes[step * 16 + q];
                let emb = assets.get_codec_embedding(q, c);
                for i in 0..2048 {
                    step_sum[i] += emb[i];
                }
            }
            audio_pool.push(step_sum);
        }

        let t_len = text_pool.len();
        let a_len = audio_pool.len();

        let max_len = t_len.max(a_len);
        let mut body = Vec::with_capacity(max_len);
        for i in 0..max_len {
            let text_vec = if i < t_len { &text_pool[i] } else { tts_pad };
            let audio_vec = if i < a_len { &audio_pool[i] } else { tts_pad };
            let fused: Vec<f32> = text_vec
                .iter()
                .zip(audio_vec.iter())
                .map(|(t, a)| t + a)
                .collect();
            body.push(fused);
        }

        Self::build_core_with_clone_body(
            text,
            tokenizer,
            assets,
            Some(lang_id),
            Some(spk_emb),
            instruct,
            body,
        )
    }

    pub fn build_custom_prompt(
        text: &str,
        tokenizer: &Tokenizer,
        assets: &Assets,
        spk_id: usize,
        lang_id: usize,
        instruct: Option<&str>,
    ) -> Result<PromptData, String> {
        Self::build_core(
            text,
            tokenizer,
            assets,
            Some(lang_id),
            Some(spk_id),
            None,
            instruct,
            None,
        )
    }

    fn build_core_with_clone_body(
        text: &str,
        tokenizer: &Tokenizer,
        assets: &Assets,
        lang_id: Option<usize>,
        spk_emb: Option<&[f32]>,
        instruct: Option<&str>,
        body: Vec<Vec<f32>>,
    ) -> PromptData {
        let mut embeds = Vec::new();

        if let Some(ins) = instruct {
            let prefix = vec![151644, 872, 198];
            for id in prefix {
                embeds.push(assets.get_text_embedding(id));
            }
            let content_ids = tokenizer.encode(ins);
            for id in content_ids {
                embeds.push(assets.get_text_embedding(id as usize));
            }
            let suffix = vec![151645, 198];
            for id in suffix {
                embeds.push(assets.get_text_embedding(id));
            }
        }

        for id in [151644, 77091, 198] {
            embeds.push(assets.get_text_embedding(id));
        }

        let marker_emb = assets.get_text_embedding(TEXT_AUDIO_MARKER);

        if let Some(lid) = lang_id {
            let ids = [THINK, THINK_BOS, lid, THINK_EOS];
            for &id in &ids {
                let e = assets.get_codec_embedding(0, id as i32);
                let sum: Vec<f32> = marker_emb
                    .iter()
                    .zip(e.iter())
                    .map(|(a, b)| a + b)
                    .collect();
                embeds.push(sum);
            }
        } else {
            let ids = [NOTHINK, THINK_BOS, THINK_EOS];
            for &id in &ids {
                let e = assets.get_codec_embedding(0, id as i32);
                let sum: Vec<f32> = marker_emb
                    .iter()
                    .zip(e.iter())
                    .map(|(a, b)| a + b)
                    .collect();
                embeds.push(sum);
            }
        }

        if let Some(se) = spk_emb {
            let sum: Vec<f32> = marker_emb
                .iter()
                .zip(se.iter())
                .map(|(a, b)| a + b)
                .collect();
            embeds.push(sum);
        }

        embeds.extend(body);

        let text_ids = tokenizer.encode(text);
        let result_spk_emb = spk_emb
            .map(|s| s.to_vec())
            .unwrap_or_else(|| vec![0.0; 2048]);

        PromptData {
            embd: embeds,
            text_ids: text_ids.into_iter().collect(),
            spk_emb: result_spk_emb,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn build_core(
        text: &str,
        tokenizer: &Tokenizer,
        assets: &Assets,
        lang_id: Option<usize>,
        spk_id: Option<usize>,
        spk_emb: Option<&[f32]>,
        instruct: Option<&str>,
        mid_embeds: Option<Vec<Vec<f32>>>,
    ) -> Result<PromptData, String> {
        let mut embeds = Vec::new();
        let text_ids = tokenizer.encode(text);

        // Check if text_ids is empty (e.g., only punctuation)
        if text_ids.is_empty() {
            return Err("Text is empty or contains only unsupported characters".to_string());
        }

        // Check if text contains only punctuation and whitespace
        let text_trimmed: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        let only_punctuation = text_trimmed.chars().all(|c| {
            matches!(
                c,
                '，' | '。'
                    | '、'
                    | '；'
                    | '：'
                    | '？'
                    | '！'
                    | '"'
                    | '\''
                    | '（'
                    | '）'
                    | '【'
                    | '】'
                    | '《'
                    | '》'
                    | '…'
                    | '—'
                    | '～'
                    | ','
                    | '.'
                    | '!'
                    | '?'
                    | ';'
                    | ':'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '<'
                    | '>'
                    | '-'
                    | '~'
                    | '`'
                    | '@'
                    | '#'
                    | '$'
                    | '%'
                    | '^'
                    | '&'
                    | '*'
                    | '+'
                    | '='
                    | '|'
                    | '\\'
                    | '/'
                    | '{'
                    | '}'
                    | '_'
            )
        });
        if only_punctuation && !text_trimmed.is_empty() {
            return Err(
                "Text contains only punctuation marks, which may cause generation issues"
                    .to_string(),
            );
        }

        let result_spk_emb = spk_emb
            .map(|s| s.to_vec())
            .unwrap_or_else(|| vec![0.0; 2048]);

        let marker_emb = assets.get_text_embedding(TEXT_AUDIO_MARKER);

        // 1. Instruct Block (User)
        if let Some(ins) = instruct {
            // <|im_start|>user\n
            let prefix = vec![151644, 872, 198];
            for id in prefix {
                embeds.push(assets.get_text_embedding(id));
            }
            let content_ids = tokenizer.encode(ins);
            for id in content_ids {
                embeds.push(assets.get_text_embedding(id as usize));
            }
            // <|im_end|>\n
            let suffix = vec![151645, 198];
            for id in suffix {
                embeds.push(assets.get_text_embedding(id));
            }
        }

        // 2. Role Block (Assistant)
        // <|im_start|>assistant\n -> [151644, 77091, 198]
        for id in [151644, 77091, 198] {
            embeds.push(assets.get_text_embedding(id));
        }

        // 3. Control Block
        if let Some(lid) = lang_id {
            // THINK, THINK_BOS, lang_id, THINK_EOS
            let ids = [THINK, THINK_BOS, lid, THINK_EOS];
            for &id in &ids {
                let e = assets.get_codec_embedding(0, id as i32);
                let sum: Vec<f32> = marker_emb
                    .iter()
                    .zip(e.iter())
                    .map(|(a, b)| a + b)
                    .collect();
                embeds.push(sum);
            }
        } else {
            // NOTHINK, THINK_BOS, THINK_EOS
            let ids = [NOTHINK, THINK_BOS, THINK_EOS];
            for &id in &ids {
                let e = assets.get_codec_embedding(0, id as i32);
                let sum: Vec<f32> = marker_emb
                    .iter()
                    .zip(e.iter())
                    .map(|(a, b)| a + b)
                    .collect();
                embeds.push(sum);
            }
        }

        // Speaker ID/Emb
        if let Some(sid) = spk_id {
            let e = assets.get_codec_embedding(0, sid as i32);
            let sum: Vec<f32> = marker_emb
                .iter()
                .zip(e.iter())
                .map(|(a, b)| a + b)
                .collect();
            embeds.push(sum);
        } else if let Some(se) = spk_emb {
            let sum: Vec<f32> = marker_emb
                .iter()
                .zip(se.iter())
                .map(|(a, b)| a + b)
                .collect();
            embeds.push(sum);
        }

        // 4. Mid Embeds
        if let Some(mids) = mid_embeds {
            embeds.extend(mids);
        }

        // 5. Task Text Block
        // BOS_TOKEN + PAD
        let pad_0 = assets.get_codec_embedding(0, PAD as i32);
        let bos_token_emb = assets.get_text_embedding(BOS_TOKEN);
        let bos_sum: Vec<f32> = bos_token_emb
            .iter()
            .zip(pad_0.iter())
            .map(|(a, b)| a + b)
            .collect();
        embeds.push(bos_sum);

        for &id in &text_ids {
            let t_emb = assets.get_text_embedding(id as usize);
            let sum: Vec<f32> = t_emb.iter().zip(pad_0.iter()).map(|(a, b)| a + b).collect();
            embeds.push(sum);
        }

        // EOS_TOKEN + PAD
        let eos_token_emb = assets.get_text_embedding(EOS_TOKEN);
        let eos_sum: Vec<f32> = eos_token_emb
            .iter()
            .zip(pad_0.iter())
            .map(|(a, b)| a + b)
            .collect();
        embeds.push(eos_sum);

        // 6. Activation (BOS)
        // Python: assets.text_table[151671] + assets.emb_tables[0][p["BOS"]]
        let bos_emb = assets.get_codec_embedding(0, BOS as i32);
        let act_sum: Vec<f32> = marker_emb
            .iter()
            .zip(bos_emb.iter())
            .map(|(a, b)| a + b)
            .collect();
        embeds.push(act_sum);

        Ok(PromptData {
            embd: embeds,
            text_ids: text_ids.into_iter().collect(),
            spk_emb: result_spk_emb,
        })
    }
}
