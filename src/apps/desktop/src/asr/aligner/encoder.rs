//! Audio encoder forward pass — ported from
//! `forced_aligner.cpp`::`ForcedAligner::encode_audio`.
//!
//! Pipeline:
//! 1. Split mel into chunks of 100 frames (zero-pad the last chunk).
//! 2. 3× Conv2d (stride 2, pad 1, kernel 3) per chunk → [n_chunks, 480, 16, max_out_w].
//! 3. Flatten conv features to `[total_out_frames, 7680]` (each frame =
//!    `out_c * out_h = 480 * 16`), then `conv_out` linear → `[total_out_frames, 1024]`.
//! 4. Add sinusoidal PE (per-chunk position, restarts at 0 for each chunk).
//! 5. 24-layer transformer with **windowed** (block-diagonal) attention:
//!    `window_aftercnn = max_out_w * 8 = 104`. Pre-norm + GELU FFN.
//! 6. `ln_post` → `proj1` + GELU → `proj2`.

use super::math;
use super::mel::MelSpectrogram;
use super::model::{ForcedAlignerModel, Tensor};

/// Output: `[total_out_frames, text_hidden_size]` row-major.
pub fn encode_audio(model: &ForcedAlignerModel, mel: &MelSpectrogram) -> Result<Vec<f32>, String> {
    let hp = model.hparams();
    let n_mel = mel.n_mel;
    let n_frames = mel.n_len;
    let n_state = hp.audio_d_model as usize;
    let n_head = hp.audio_attention_heads as usize;
    let n_layer = hp.audio_encoder_layers as usize;
    let n_state_head = n_state / n_head;
    let eps = hp.audio_layer_norm_eps;
    let kq_scale = 1.0_f32 / (n_state_head as f32).sqrt();

    // ---- Chunking ----
    const N_WINDOW: i32 = 50;
    const N_WINDOW_INFER: i32 = 800;
    let chunk_mel_size = (N_WINDOW * 2) as usize; // 100
    let n_chunks = n_frames.div_ceil(chunk_mel_size);

    // chunk_lengths[c] = actual mel frames in chunk c (last chunk may be short).
    let mut chunk_lengths = Vec::with_capacity(n_chunks);
    let mut chunk_out_lens = Vec::with_capacity(n_chunks);
    for c in 0..n_chunks {
        let len = if c < n_chunks - 1 {
            chunk_mel_size
        } else {
            let l = n_frames - c * chunk_mel_size;
            if l == 0 {
                chunk_mel_size
            } else {
                l
            }
        };
        chunk_lengths.push(len);
        chunk_out_lens.push(chunk_output_len(len as i32) as usize);
    }
    let total_out_frames: usize = chunk_out_lens.iter().sum();
    let max_chunk_len = chunk_mel_size;
    let max_out_w = chunk_output_len(max_chunk_len as i32) as usize;

    log::info!(
        "[FA.encoder] n_frames={}, n_chunks={}, chunk_mel_size={}, max_out_w={}, total_out={}",
        n_frames,
        n_chunks,
        chunk_mel_size,
        max_out_w,
        total_out_frames
    );

    // ---- Build mel_batch: [n_chunks, 1, n_mel=128, max_chunk_len] row-major ----
    let mut mel_batch = vec![0.0_f32; n_chunks * n_mel * max_chunk_len];
    for c in 0..n_chunks {
        let clen = chunk_lengths[c];
        let start_frame = c * chunk_mel_size;
        for m in 0..n_mel {
            for f in 0..clen {
                // mel.data is mel-major: data[m*n_len + frame]
                let mel_v = mel.data[m * n_frames + start_frame + f];
                // mel_batch[c, 0, m, f] row-major
                mel_batch[c * n_mel * max_chunk_len + m * max_chunk_len + f] = mel_v;
            }
        }
    }

    // ---- 3x Conv2d ----
    // NOTE: GGUF stores audio-encoder tensors with the `audio.` prefix
    // (e.g. `audio.encoder.conv1.weight`), while text-decoder tensors are
    // unprefixed. See OpenVoiceOS/qwen3-forced-aligner-0.6b-q8-0.
    let conv1_w = model.require("audio.encoder.conv1.weight")?;
    let conv1_b = model.require("audio.encoder.conv1.bias")?;
    let conv2_w = model.require("audio.encoder.conv2.weight")?;
    let conv2_b = model.require("audio.encoder.conv2.bias")?;
    let conv3_w = model.require("audio.encoder.conv3.weight")?;
    let conv3_b = model.require("audio.encoder.conv3.bias")?;

    let (after_conv1, _h1, _w1) = conv2d_for_encoder(
        &mel_batch,
        conv1_w,
        Some(&conv1_b.data),
        n_chunks,
        1,
        n_mel,
        max_chunk_len,
        hp.audio_conv_channels as usize,
    );
    let (after_conv2, _h2, _w2) = conv2d_for_encoder(
        &after_conv1,
        conv2_w,
        Some(&conv2_b.data),
        n_chunks,
        hp.audio_conv_channels as usize,
        _h1,
        _w1,
        hp.audio_conv_channels as usize,
    );
    let (after_conv3, out_h, out_w) = conv2d_for_encoder(
        &after_conv2,
        conv3_w,
        Some(&conv3_b.data),
        n_chunks,
        hp.audio_conv_channels as usize,
        _h2,
        _w2,
        hp.audio_conv_channels as usize,
    );
    // after_conv3: [n_chunks, out_c=480, out_h=16, out_w=max_out_w=13]
    let conv_channels = hp.audio_conv_channels as usize;
    debug_assert_eq!(out_h * conv_channels, 480 * 16); // feat_dim=7680

    // ---- Flatten + conv_out linear (7680 → 1024) ----
    let feat_dim = conv_channels * out_h; // 7680
                                          // Build [total_out_frames, feat_dim] by extracting each chunk's first valid frames.
    let conv_out_w = model.require("audio.encoder.conv_out.weight")?;
    let pe = math::sinusoidal_pe(max_out_w, n_state);

    let mut hidden = vec![0.0_f32; total_out_frames * n_state];
    let mut dst_offset = 0_usize;
    for c in 0..n_chunks {
        let valid = chunk_out_lens[c];
        // For each valid frame t in chunk c: extract after_conv3[c, :, :, t]
        // (a [out_c, out_h] = [480, 16] slice, row-major flatten = 7680).
        // after_conv3 row-major: [c, out_c, out_h, out_w]
        // element(c, oc, oh, ow) = after_conv3[c*out_c*out_h*out_w + oc*out_h*out_w + oh*out_w + ow]
        // We fix ow = t, want [out_c, out_h] flatten in oc-major order:
        //   slice[(oc*out_h + oh)] = element(c, oc, oh, t)
        let mut frame_features = vec![0.0_f32; valid * feat_dim];
        for t in 0..valid {
            for oc in 0..conv_channels {
                for oh in 0..out_h {
                    frame_features[t * feat_dim + oc * out_h + oh] = after_conv3
                        [c * conv_channels * out_h * out_w + oc * out_h * out_w + oh * out_w + t];
                }
            }
        }
        // Linear: feat_dim → n_state
        let proj = math::linear(
            &frame_features,
            &conv_out_w.data,
            None,
            valid,
            feat_dim,
            n_state,
        );
        // Add sinusoidal PE (per-chunk position t).
        for t in 0..valid {
            for d in 0..n_state {
                hidden[(dst_offset + t) * n_state + d] =
                    proj[t * n_state + d] + pe[t * n_state + d];
            }
        }
        dst_offset += valid;
    }
    debug_assert_eq!(dst_offset, total_out_frames);

    // ---- Windowed attention mask ----
    let n_ctx = total_out_frames;
    let window_aftercnn = max_out_w * (N_WINDOW_INFER as usize / chunk_mel_size); // 13 * 8 = 104
    let mut attn_mask = vec![f32::NEG_INFINITY; n_ctx * n_ctx];
    let mut start = 0_usize;
    while start < n_ctx {
        let end = (start + window_aftercnn).min(n_ctx);
        for r in start..end {
            for cc in start..end {
                attn_mask[r * n_ctx + cc] = 0.0;
            }
        }
        start = end;
    }

    // ---- 24-layer transformer ----
    let mut inp_l = hidden;
    for il in 0..n_layer {
        let layer_prefix = format!("audio.encoder.blk.{}.", il);
        let attn_norm_w = model.require(&format!("{}attn_norm.weight", layer_prefix))?;
        let attn_norm_b = model.require(&format!("{}attn_norm.bias", layer_prefix))?;
        let attn_q_w = model.require(&format!("{}attn_q.weight", layer_prefix))?;
        let attn_q_b = model.require(&format!("{}attn_q.bias", layer_prefix))?;
        let attn_k_w = model.require(&format!("{}attn_k.weight", layer_prefix))?;
        let attn_k_b = model.require(&format!("{}attn_k.bias", layer_prefix))?;
        let attn_v_w = model.require(&format!("{}attn_v.weight", layer_prefix))?;
        let attn_v_b = model.require(&format!("{}attn_v.bias", layer_prefix))?;
        let attn_out_w = model.require(&format!("{}attn_out.weight", layer_prefix))?;
        let attn_out_b = model.require(&format!("{}attn_out.bias", layer_prefix))?;
        let ffn_up_w = model.require(&format!("{}ffn_up.weight", layer_prefix))?;
        let ffn_up_b = model.require(&format!("{}ffn_up.bias", layer_prefix))?;
        let ffn_down_w = model.require(&format!("{}ffn_down.weight", layer_prefix))?;
        let ffn_down_b = model.require(&format!("{}ffn_down.bias", layer_prefix))?;
        let ffn_norm_w = model.require(&format!("{}ffn_norm.weight", layer_prefix))?;
        let ffn_norm_b = model.require(&format!("{}ffn_norm.bias", layer_prefix))?;

        // Pre-norm: LayerNorm(attn_norm) → Q/K/V → attention → out → residual.
        let normed = math::layer_norm(
            &inp_l,
            &attn_norm_w.data,
            &attn_norm_b.data,
            n_ctx,
            n_state,
            eps,
        );
        let q = math::linear(
            &normed,
            &attn_q_w.data,
            Some(&attn_q_b.data),
            n_ctx,
            n_state,
            n_state,
        );
        let k = math::linear(
            &normed,
            &attn_k_w.data,
            Some(&attn_k_b.data),
            n_ctx,
            n_state,
            n_state,
        );
        let v = math::linear(
            &normed,
            &attn_v_w.data,
            Some(&attn_v_b.data),
            n_ctx,
            n_state,
            n_state,
        );

        // Attention: [n_ctx, n_head, n_state_head] → per-head QK^T → softmax(mask, scale) → V.
        let attn_out = attention(
            &q,
            &k,
            &v,
            Some(&attn_mask),
            n_ctx,
            n_head,
            n_state_head,
            kq_scale,
        );

        // Output projection.
        let proj = math::linear(
            &attn_out,
            &attn_out_w.data,
            Some(&attn_out_b.data),
            n_ctx,
            n_state,
            n_state,
        );
        // Residual.
        for i in 0..inp_l.len() {
            inp_l[i] += proj[i];
        }

        // FFN: LayerNorm(ffn_norm) → up → GELU → down → residual.
        let normed2 = math::layer_norm(
            &inp_l,
            &ffn_norm_w.data,
            &ffn_norm_b.data,
            n_ctx,
            n_state,
            eps,
        );
        let up = math::linear(
            &normed2,
            &ffn_up_w.data,
            Some(&ffn_up_b.data),
            n_ctx,
            n_state,
            hp.audio_ffn_dim as usize,
        );
        let mut act = up;
        for v in act.iter_mut() {
            *v = math::gelu(*v);
        }
        let down = math::linear(
            &act,
            &ffn_down_w.data,
            Some(&ffn_down_b.data),
            n_ctx,
            hp.audio_ffn_dim as usize,
            n_state,
        );
        for i in 0..inp_l.len() {
            inp_l[i] += down[i];
        }
    }

    // ---- ln_post ----
    let ln_post_w = model.require("audio.encoder.ln_post.weight")?;
    let ln_post_b = model.require("audio.encoder.ln_post.bias")?;
    let mut cur = math::layer_norm(
        &inp_l,
        &ln_post_w.data,
        &ln_post_b.data,
        n_ctx,
        n_state,
        eps,
    );

    // ---- proj1 + GELU + proj2 ----
    if let Some(proj1_w) = model.get("audio.encoder.proj1.weight") {
        let proj1_b = model.get("audio.encoder.proj1.bias");
        let p = math::linear(
            &cur,
            &proj1_w.data,
            proj1_b.map(|t| t.data.as_slice()),
            n_ctx,
            n_state,
            hp.audio_d_model as usize,
        );
        for v in p.iter().zip(cur.iter_mut()) {
            *v.1 = math::gelu(*v.0);
        }
    }
    if let Some(proj2_w) = model.get("audio.encoder.proj2.weight") {
        let proj2_b = model.get("audio.encoder.proj2.bias");
        cur = math::linear(
            &cur,
            &proj2_w.data,
            proj2_b.map(|t| t.data.as_slice()),
            n_ctx,
            hp.audio_d_model as usize,
            hp.text_hidden_size as usize,
        );
    }

    log::info!(
        "[FA.encoder] done: output [{} x {}]",
        n_ctx,
        hp.text_hidden_size
    );
    Ok(cur)
}

/// Conv2d wrapper that pulls weight/bias out of a `Tensor` and enforces the
/// `[out_c, in_c, kh, kw]` row-major weight layout expected by `math::conv2d`.
#[allow(clippy::too_many_arguments)]
fn conv2d_for_encoder(
    x: &[f32],
    weight: &Tensor,
    bias: Option<&[f32]>,
    batch: usize,
    in_c: usize,
    h: usize,
    w: usize,
    out_c: usize,
) -> (Vec<f32>, usize, usize) {
    debug_assert_eq!(weight.shape, vec![out_c, in_c, 3, 3]);
    math::conv2d(x, &weight.data, bias, batch, in_c, h, w, out_c, 3, 3, 2, 1)
}

/// Multi-head attention with optional additive mask (broadcast per row).
/// Q/K/V: `[n_tokens, n_head, head_dim]` row-major. Returns `[n_tokens, n_state]`.
#[allow(clippy::too_many_arguments)]
fn attention(
    q: &[f32],
    k: &[f32],
    v: &[f32],
    mask: Option<&[f32]>,
    n_tokens: usize,
    n_head: usize,
    head_dim: usize,
    scale: f32,
) -> Vec<f32> {
    let n_state = n_head * head_dim;
    let mut out = vec![0.0_f32; n_tokens * n_state];

    for h in 0..n_head {
        // For each query token i: compute scores against all keys j, softmax, weighted sum of V.
        for i in 0..n_tokens {
            let q_vec = &q[(i * n_head + h) * head_dim..(i * n_head + h + 1) * head_dim];
            // Scores: [n_tokens].
            let mut scores = vec![0.0_f32; n_tokens];
            for j in 0..n_tokens {
                let k_vec = &k[(j * n_head + h) * head_dim..(j * n_head + h + 1) * head_dim];
                let mut s = 0.0_f32;
                for d in 0..head_dim {
                    s += q_vec[d] * k_vec[d];
                }
                scores[j] = s * scale;
            }
            // Softmax with mask.
            let mut max_val = f32::NEG_INFINITY;
            for j in 0..n_tokens {
                let m = mask.map(|mm| mm[i * n_tokens + j]).unwrap_or(0.0);
                let v = scores[j] + m;
                if v > max_val {
                    max_val = v;
                }
                scores[j] = v;
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
                    let v_vec = &v[(j * n_head + h) * head_dim..(j * n_head + h + 1) * head_dim];
                    acc += scores[j] * v_vec[d];
                }
                out_row[d] = acc;
            }
        }
    }
    out
}

/// `(input - 1) / 2 + 1` applied 3 times (one per Conv2d stride-2 layer).
fn chunk_output_len(mut len: i32) -> i32 {
    for _ in 0..3 {
        len = (len - 1) / 2 + 1;
    }
    len
}
