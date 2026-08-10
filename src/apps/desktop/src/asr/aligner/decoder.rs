//! Text decoder forward pass — ported from
//! `forced_aligner.cpp`::`ForcedAligner::build_decoder_graph` +
//! `forward_decoder`.
//!
//! Single non-autoregressive forward pass through a 28-layer Qwen3
//! transformer with **audio embeddings injected** in place of the
//! `<audio_pad>` slots. Output = 5000-class logits at each position.
//!
//! Per-layer ops:
//! 1. RMSNorm(attn_norm) → Q/K/V (separate projections, GQA).
//! 2. RMSNorm q_norm/k_norm over `head_dim`.
//! 3. RoPE NeOX (theta = 1_000_000).
//! 4. Grouped-query causal attention (n_head=16, n_kv_head=8).
//! 5. `attn_output` projection + residual.
//! 6. RMSNorm(ffn_norm) → SwiGLU (`silu(gate) * up → down`) + residual.
//!
//! Final: RMSNorm(output_norm) → `output.weight` (classify head, 5000 classes).

use super::math;
use super::model::ForcedAlignerModel;

/// Run the decoder forward pass.
///
/// - `tokens`: full input sequence including `<audio_start>` + audio pads +
///   `<audio_end>` + text tokens.
/// - `audio_embd`: `[n_audio_frames, text_hidden_size]` row-major (output of
///   the audio encoder).
/// - `audio_start_pos`: position in `tokens` where audio embeddings should be
///   injected (i.e. immediately after `<audio_start>`).
///
/// Returns logits `[n_tokens, classify_num]` row-major.
pub fn forward_decoder(
    model: &ForcedAlignerModel,
    tokens: &[i32],
    audio_embd: &[f32],
    n_audio_frames: i32,
    audio_start_pos: i32,
) -> Result<Vec<f32>, String> {
    let hp = model.hparams();
    let n_tokens = tokens.len();
    let hidden = hp.text_hidden_size as usize;
    let n_head = hp.text_attention_heads as usize;
    let n_kv_head = hp.text_kv_heads as usize;
    let head_dim = hp.text_head_dim as usize;
    let intermediate = hp.text_intermediate_size as usize;
    let n_layer = hp.text_decoder_layers as usize;
    let eps = hp.text_rms_norm_eps;
    let rope_theta = hp.text_rope_theta;
    let n_groups = n_head / n_kv_head; // GQA: query heads per kv head
    let kq_scale = 1.0_f32 / (head_dim as f32).sqrt();

    log::info!(
        "[FA.decoder] n_tokens={}, hidden={}, n_head={}, n_kv_head={}, head_dim={}, layers={}",
        n_tokens,
        hidden,
        n_head,
        n_kv_head,
        head_dim,
        n_layer
    );

    // ---- 1. Embedding lookup ----
    let token_embd = model.require("token_embd.weight")?;
    // token_embd GGUF shape: [hidden, vocab] col-major → row-major [vocab, hidden].
    debug_assert_eq!(token_embd.shape, vec![hp.vocab_size as usize, hidden]);
    let mut embd = vec![0.0_f32; n_tokens * hidden];
    for (i, &tok) in tokens.iter().enumerate() {
        let id = tok as usize;
        if id < hp.vocab_size as usize {
            embd[i * hidden..(i + 1) * hidden]
                .copy_from_slice(&token_embd.data[id * hidden..(id + 1) * hidden]);
        }
    }

    // ---- 2. Inject audio embeddings at [audio_start_pos, audio_start_pos + n_audio) ----
    let n_audio = n_audio_frames as usize;
    let start = audio_start_pos as usize;
    if start + n_audio > n_tokens {
        return Err(format!(
            "Audio injection out of range: start={} + n_audio={} > n_tokens={}",
            start, n_audio, n_tokens
        ));
    }
    for i in 0..n_audio {
        embd[(start + i) * hidden..(start + i + 1) * hidden]
            .copy_from_slice(&audio_embd[i * hidden..(i + 1) * hidden]);
    }

    // ---- 3. Positions for RoPE (0..n_tokens) ----
    let positions: Vec<i32> = (0..n_tokens as i32).collect();

    // ---- 4. Causal mask [n_tokens, n_tokens] (0 below diag, -inf above). ----
    let mut causal_mask = vec![0.0_f32; n_tokens * n_tokens];
    for q in 0..n_tokens {
        for k in (q + 1)..n_tokens {
            causal_mask[q * n_tokens + k] = f32::NEG_INFINITY;
        }
    }

    // ---- 5. 28-layer transformer ----
    let mut inp_l = embd;
    for il in 0..n_layer {
        let p = format!("blk.{}.", il);
        let attn_norm = model.require(&format!("{}attn_norm.weight", p))?;
        let q_w = model.require(&format!("{}attn_q.weight", p))?;
        let k_w = model.require(&format!("{}attn_k.weight", p))?;
        let v_w = model.require(&format!("{}attn_v.weight", p))?;
        let out_w = model.require(&format!("{}attn_output.weight", p))?;
        let ffn_norm = model.require(&format!("{}ffn_norm.weight", p))?;
        let gate_w = model.require(&format!("{}ffn_gate.weight", p))?;
        let up_w = model.require(&format!("{}ffn_up.weight", p))?;
        let down_w = model.require(&format!("{}ffn_down.weight", p))?;

        // q_norm/k_norm are optional in general but present in Qwen3.
        let q_norm_w = model.get(&format!("{}attn_q_norm.weight", p));
        let k_norm_w = model.get(&format!("{}attn_k_norm.weight", p));

        // --- Attention block ---
        let normed = math::rms_norm(&inp_l, &attn_norm.data, n_tokens, hidden, eps);
        // Q: [n_tokens, n_head*head_dim]
        let mut q = math::linear(
            &normed,
            &q_w.data,
            None,
            n_tokens,
            hidden,
            n_head * head_dim,
        );
        // K/V: [n_tokens, n_kv_head*head_dim]
        let mut k = math::linear(
            &normed,
            &k_w.data,
            None,
            n_tokens,
            hidden,
            n_kv_head * head_dim,
        );
        let v = math::linear(
            &normed,
            &v_w.data,
            None,
            n_tokens,
            hidden,
            n_kv_head * head_dim,
        );

        // q_norm / k_norm: RMSNorm over head_dim, applied per (token, head).
        if let Some(qn) = q_norm_w {
            q = rms_norm_per_head(&q, &qn.data, n_tokens, n_head, head_dim, eps);
        }
        if let Some(kn) = k_norm_w {
            k = rms_norm_per_head(&k, &kn.data, n_tokens, n_kv_head, head_dim, eps);
        }

        // RoPE NeOX on Q and K.
        // Q layout: [n_tokens, n_head, head_dim] row-major — rope_neox_inplace
        // expects exactly this layout.
        math::rope_neox_inplace(&mut q, &positions, n_tokens, n_head, head_dim, rope_theta);
        math::rope_neox_inplace(
            &mut k, &positions, n_tokens, n_kv_head, head_dim, rope_theta,
        );

        // GQA causal attention → [n_tokens, n_head*head_dim].
        let attn_out = gqa_attention(
            &q,
            &k,
            &v,
            &causal_mask,
            n_tokens,
            n_head,
            n_kv_head,
            head_dim,
            n_groups,
            kq_scale,
        );

        // Output projection + residual.
        let proj = math::linear(
            &attn_out,
            &out_w.data,
            None,
            n_tokens,
            n_head * head_dim,
            hidden,
        );
        for i in 0..inp_l.len() {
            inp_l[i] += proj[i];
        }

        // --- FFN block (SwiGLU) ---
        let normed2 = math::rms_norm(&inp_l, &ffn_norm.data, n_tokens, hidden, eps);
        let gate = math::linear(&normed2, &gate_w.data, None, n_tokens, hidden, intermediate);
        let up = math::linear(&normed2, &up_w.data, None, n_tokens, hidden, intermediate);
        let mut act = vec![0.0_f32; n_tokens * intermediate];
        for i in 0..gate.len() {
            act[i] = math::silu(gate[i]) * up[i];
        }
        let down = math::linear(&act, &down_w.data, None, n_tokens, intermediate, hidden);
        for i in 0..inp_l.len() {
            inp_l[i] += down[i];
        }
    }

    // ---- 6. Final RMSNorm + classify head ----
    let output_norm = model.require("output_norm.weight")?;
    let normed = math::rms_norm(&inp_l, &output_norm.data, n_tokens, hidden, eps);

    let classify_w = model.require("output.weight")?;
    // GGUF `output.weight`: [hidden, classify_num] col-major → row-major [classify_num, hidden].
    let logits = math::linear(
        &normed,
        &classify_w.data,
        None,
        n_tokens,
        hidden,
        hp.classify_num as usize,
    );

    log::info!(
        "[FA.decoder] done: logits [{} x {}]",
        n_tokens,
        hp.classify_num
    );
    Ok(logits)
}

/// RMSNorm applied per (token, head) over the `head_dim` axis.
/// Input `x` is `[n_tokens, n_head, head_dim]` row-major.
fn rms_norm_per_head(
    x: &[f32],
    weight: &[f32],
    n_tokens: usize,
    n_head: usize,
    head_dim: usize,
    eps: f32,
) -> Vec<f32> {
    debug_assert_eq!(x.len(), n_tokens * n_head * head_dim);
    debug_assert_eq!(weight.len(), head_dim);
    let mut y = vec![0.0_f32; x.len()];
    for t in 0..n_tokens {
        for h in 0..n_head {
            let base = (t * n_head + h) * head_dim;
            let row = &x[base..base + head_dim];
            let mut ss = 0.0_f32;
            for &v in row {
                ss += v * v;
            }
            let inv = 1.0_f32 / (ss / head_dim as f32 + eps).sqrt();
            for d in 0..head_dim {
                y[base + d] = row[d] * inv * weight[d];
            }
        }
    }
    y
}

/// Grouped-query attention with causal mask.
///
/// - `q`: `[n_tokens, n_head, head_dim]` row-major.
/// - `k`, `v`: `[n_tokens, n_kv_head, head_dim]` row-major.
/// - `mask`: `[n_tokens, n_tokens]` additive mask.
///
/// Returns `[n_tokens, n_head * head_dim]` row-major.
#[allow(clippy::too_many_arguments)]
fn gqa_attention(
    q: &[f32],
    k: &[f32],
    v: &[f32],
    mask: &[f32],
    n_tokens: usize,
    n_head: usize,
    n_kv_head: usize,
    head_dim: usize,
    n_groups: usize,
    scale: f32,
) -> Vec<f32> {
    let mut out = vec![0.0_f32; n_tokens * n_head * head_dim];
    for h in 0..n_head {
        let kv_h = h / n_groups; // each kv head serves n_groups query heads
        for i in 0..n_tokens {
            let q_vec = &q[(i * n_head + h) * head_dim..(i * n_head + h + 1) * head_dim];

            // Scores against all keys j (causal: j <= i).
            let mut scores = vec![0.0_f32; n_tokens];
            for j in 0..n_tokens {
                let k_vec =
                    &k[(j * n_kv_head + kv_h) * head_dim..(j * n_kv_head + kv_h + 1) * head_dim];
                let mut s = 0.0_f32;
                for d in 0..head_dim {
                    s += q_vec[d] * k_vec[d];
                }
                scores[j] = s * scale + mask[i * n_tokens + j];
            }

            // Softmax.
            let mut max_val = f32::NEG_INFINITY;
            for &s in &scores {
                if s > max_val {
                    max_val = s;
                }
            }
            let mut sum = 0.0_f32;
            for s in scores.iter_mut() {
                *s = (*s - max_val).exp();
                sum += *s;
            }
            let inv = if sum > 0.0 { 1.0 / sum } else { 0.0 };
            for s in scores.iter_mut() {
                *s *= inv;
            }

            // Weighted sum of V → head_dim.
            let out_row = &mut out[(i * n_head + h) * head_dim..(i * n_head + h + 1) * head_dim];
            for d in 0..head_dim {
                let mut acc = 0.0_f32;
                for j in 0..n_tokens {
                    let v_vec = &v
                        [(j * n_kv_head + kv_h) * head_dim..(j * n_kv_head + kv_h + 1) * head_dim];
                    acc += scores[j] * v_vec[d];
                }
                out_row[d] = acc;
            }
        }
    }
    out
}
