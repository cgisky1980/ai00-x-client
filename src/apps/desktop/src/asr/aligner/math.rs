//! Basic tensor math primitives for the pure-Rust ForcedAligner forward pass.
//!
//! All tensors here are **row-major f32** — the model loader
//! ([`super::model`]) converts GGUF's column-major layout to row-major on
//! load so every operator below can stay a straightforward `A[m,k] * B[k,n]`
//! matmul without GGML's `ne[]`-axis gymnastics.
//!
//! Conventions:
//! - `matmul(a, b, m, k, n)`: `c[i,j] = Σ_k a[i,k] * b[k,j]`, shapes
//!   `a=[m,k]`, `b=[k,n]`, `c=[m,n]` (all row-major).
//! - `linear(x, w, b, m, k, n)`: `y = x @ w^T + b` where `x=[m,k]`,
//!   `w=[n,k]`, `b=[n]`, `y=[m,n]`. (PyTorch `nn.Linear` convention.)

/// Standard row-major matmul: `c[m,n] = a[m,k] @ b[k,n]`.
pub fn matmul(a: &[f32], b: &[f32], m: usize, k: usize, n: usize) -> Vec<f32> {
    debug_assert_eq!(a.len(), m * k);
    debug_assert_eq!(b.len(), k * n);
    let mut c = vec![0.0_f32; m * n];
    for i in 0..m {
        let a_row = &a[i * k..(i + 1) * k];
        let c_row = &mut c[i * n..(i + 1) * n];
        for kk in 0..k {
            let aik = a_row[kk];
            if aik == 0.0 {
                continue;
            }
            let b_row = &b[kk * n..(kk + 1) * n];
            for j in 0..n {
                c_row[j] += aik * b_row[j];
            }
        }
    }
    c
}

/// `y[m,n] = x[m,k] @ w[n,k]^T + b[n]` (PyTorch `nn.Linear`).
pub fn linear(x: &[f32], w: &[f32], b: Option<&[f32]>, m: usize, k: usize, n: usize) -> Vec<f32> {
    debug_assert_eq!(x.len(), m * k);
    debug_assert_eq!(w.len(), n * k);
    let mut y = vec![0.0_f32; m * n];
    for i in 0..m {
        let x_row = &x[i * k..(i + 1) * k];
        let y_row = &mut y[i * n..(i + 1) * n];
        for o in 0..n {
            let w_row = &w[o * k..(o + 1) * k];
            let mut acc = 0.0_f32;
            for kk in 0..k {
                acc += x_row[kk] * w_row[kk];
            }
            y_row[o] = acc;
        }
        if let Some(b) = b {
            for o in 0..n {
                y[i * n + o] += b[o];
            }
        }
    }
    y
}

/// RMSNorm: `y = x / sqrt(mean(x^2) + eps) * weight`.
/// Input `x` is `[m, n]`, `weight` is `[n]`.
pub fn rms_norm(x: &[f32], weight: &[f32], m: usize, n: usize, eps: f32) -> Vec<f32> {
    debug_assert_eq!(x.len(), m * n);
    debug_assert_eq!(weight.len(), n);
    let mut y = vec![0.0_f32; m * n];
    for i in 0..m {
        let row = &x[i * n..(i + 1) * n];
        let mut ss = 0.0_f32;
        for &v in row {
            ss += v * v;
        }
        let inv = 1.0_f32 / (ss / n as f32 + eps).sqrt();
        let out_row = &mut y[i * n..(i + 1) * n];
        for j in 0..n {
            out_row[j] = row[j] * inv * weight[j];
        }
    }
    y
}

/// LayerNorm (with bias): `y = (x - mean) / sqrt(var + eps) * weight + bias`.
/// Input `x` is `[m, n]`, `weight`/`bias` are `[n]`.
pub fn layer_norm(
    x: &[f32],
    weight: &[f32],
    bias: &[f32],
    m: usize,
    n: usize,
    eps: f32,
) -> Vec<f32> {
    debug_assert_eq!(x.len(), m * n);
    debug_assert_eq!(weight.len(), n);
    debug_assert_eq!(bias.len(), n);
    let mut y = vec![0.0_f32; m * n];
    for i in 0..m {
        let row = &x[i * n..(i + 1) * n];
        let mut mean = 0.0_f32;
        for &v in row {
            mean += v;
        }
        mean /= n as f32;
        let mut var = 0.0_f32;
        for &v in row {
            var += (v - mean) * (v - mean);
        }
        var /= n as f32;
        let inv = 1.0_f32 / (var + eps).sqrt();
        let out_row = &mut y[i * n..(i + 1) * n];
        for j in 0..n {
            out_row[j] = (row[j] - mean) * inv * weight[j] + bias[j];
        }
    }
    y
}

/// Exact GELU (erf-based, matches PyTorch `nn.GELU()` default).
/// We use the tanh approximation which is what ggml_gelu uses internally.
#[inline]
pub fn gelu(x: f32) -> f32 {
    // tanh approximation: 0.5 * x * (1 + tanh(sqrt(2/pi) * (x + 0.044715 * x^3)))
    const C: f32 = 0.797_884_6; // sqrt(2/pi)
    let x3 = x * x * x;
    0.5_f32 * x * (1.0_f32 + (C * (x + 0.044_715 * x3)).tanh())
}

/// SiLU (swish): `x * sigmoid(x)`.
#[inline]
pub fn silu(x: f32) -> f32 {
    x / (1.0_f32 + (-x).exp())
}

/// Sigmoid.
#[inline]
pub fn sigmoid(x: f32) -> f32 {
    1.0_f32 / (1.0_f32 + (-x).exp())
}

/// In-place RoPE (NeOX style) for a single layer's Q or K tensor.
///
/// `x` is `[n_tokens, n_heads, head_dim]` (row-major). For each token at
/// position `pos[t]`, each head's `head_dim` vector is split into two
/// halves `[d_low, d_high]` and rotated:
///   `x'[i]       = x[i] * cos(theta) - x[i + d/2] * sin(theta)`
///   `x'[i + d/2] = x[i + d/2] * cos(theta) + x[i] * sin(theta)`
/// where `theta = pos * inv_freq[i]`, `inv_freq[i] = 1 / theta_base^(2i/d)`.
///
/// This matches `ggml_rope_ext(..., GGML_ROPE_TYPE_NEOX, ...)` for Qwen3.
pub fn rope_neox_inplace(
    x: &mut [f32],
    pos: &[i32],
    n_tokens: usize,
    n_heads: usize,
    head_dim: usize,
    theta_base: f32,
) {
    debug_assert_eq!(x.len(), n_tokens * n_heads * head_dim);
    debug_assert_eq!(pos.len(), n_tokens);
    let half = head_dim / 2;
    let mut inv_freq = vec![0.0_f32; half];
    for (i, item) in inv_freq.iter_mut().enumerate().take(half) {
        *item = 1.0_f32 / theta_base.powf((2 * i) as f32 / head_dim as f32);
    }

    for (t, &p_val) in pos.iter().enumerate().take(n_tokens) {
        let p = p_val as f32;
        let head_stride = n_heads * head_dim;
        for h in 0..n_heads {
            let base = t * head_stride + h * head_dim;
            for i in 0..half {
                let theta = p * inv_freq[i];
                let (sin_t, cos_t) = theta.sin_cos();
                let xi = x[base + i];
                let xj = x[base + i + half];
                x[base + i] = xi * cos_t - xj * sin_t;
                x[base + i + half] = xi * sin_t + xj * cos_t;
            }
        }
    }
}

/// Softmax along the last dim of `x` (row-major `[m, n]`), with optional
/// additive mask and per-row scale. `mask` is `[n]` applied broadcast across
/// rows (typical causal mask), or `None`.
pub fn softmax_masked(x: &[f32], mask: Option<&[f32]>, scale: f32, m: usize, n: usize) -> Vec<f32> {
    debug_assert_eq!(x.len(), m * n);
    if let Some(mask) = mask {
        debug_assert_eq!(mask.len(), n);
    }
    let mut y = vec![0.0_f32; m * n];
    for i in 0..m {
        let row = &x[i * n..(i + 1) * n];
        let out_row = &mut y[i * n..(i + 1) * n];
        let mut max_val = f32::NEG_INFINITY;
        for j in 0..n {
            let mask_v = mask.map(|mm| mm[j]).unwrap_or(0.0_f32);
            let v = row[j] * scale + mask_v;
            if v > max_val {
                max_val = v;
            }
            out_row[j] = v;
        }
        let mut sum = 0.0_f32;
        for item in out_row.iter_mut().take(n) {
            let e = (*item - max_val).exp();
            *item = e;
            sum += e;
        }
        let inv = if sum > 0.0 { 1.0_f32 / sum } else { 0.0 };
        for item in out_row.iter_mut().take(n) {
            *item *= inv;
        }
    }
    y
}

/// Compute sinusoidal positional embedding (matches the C++ reference
/// `compute_sinusoidal_pe`): layout is `[n_ctx, d_model]` row-major where
/// `pe[pos, i] = sin(pos * div_term[i])` for `i < d/2` and
/// `pe[pos, i + d/2] = cos(pos * div_term[i])` for `i < d/2`.
pub fn sinusoidal_pe(n_ctx: usize, d_model: usize) -> Vec<f32> {
    let half = d_model / 2;
    let mut pe = vec![0.0_f32; n_ctx * d_model];
    for pos in 0..n_ctx {
        for i in 0..half {
            let div_term = (-((10_000.0_f32).ln()) * i as f32 / (half - 1) as f32).exp();
            let angle = pos as f32 * div_term;
            pe[pos * d_model + i] = angle.sin();
            pe[pos * d_model + half + i] = angle.cos();
        }
    }
    pe
}

/// 2D convolution (PyTorch `nn.Conv2d` semantics) with stride=2, padding=1,
/// kernel=3 — the exact configuration used by the ForcedAligner audio
/// encoder. Input `x` is `[batch, in_c, h, w]` row-major; weight is
/// `[out_c, in_c, kh, kw]`; bias is `[out_c]`.
///
/// Output shape: `[batch, out_c, out_h, out_w]` where
/// `out_h = (h + 2*pad - kh) / stride + 1`, same for `out_w`.
#[allow(clippy::too_many_arguments)]
pub fn conv2d(
    x: &[f32],
    weight: &[f32],
    bias: Option<&[f32]>,
    batch: usize,
    in_c: usize,
    h: usize,
    w: usize,
    out_c: usize,
    kh: usize,
    kw: usize,
    stride: usize,
    pad: usize,
) -> (Vec<f32>, usize, usize) {
    let out_h = (h + 2 * pad - kh) / stride + 1;
    let out_w = (w + 2 * pad - kw) / stride + 1;
    let mut y = vec![0.0_f32; batch * out_c * out_h * out_w];

    for b in 0..batch {
        for oc in 0..out_c {
            let bias_v = bias.map(|bv| bv[oc]).unwrap_or(0.0_f32);
            for oh in 0..out_h {
                for ow in 0..out_w {
                    let mut acc = bias_v;
                    for ic in 0..in_c {
                        for ky in 0..kh {
                            let iy = oh * stride + ky - pad;
                            if iy >= h {
                                continue;
                            }
                            for kx in 0..kw {
                                let ix = ow * stride + kx - pad;
                                if ix >= w {
                                    continue;
                                }
                                let xv = x[((b * in_c + ic) * h + iy) * w + ix];
                                let wv = weight[((oc * in_c + ic) * kh + ky) * kw + kx];
                                acc += xv * wv;
                            }
                        }
                    }
                    y[((b * out_c + oc) * out_h + oh) * out_w + ow] = acc;
                }
            }
        }
    }
    (y, out_h, out_w)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_matmul_basic() {
        // 2x3 * 3x2 = 2x2
        let a = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]; // [[1,2,3],[4,5,6]]
        let b = [7.0, 8.0, 9.0, 10.0, 11.0, 12.0]; // [[7,8],[9,10],[11,12]]
        let c = matmul(&a, &b, 2, 3, 2);
        // [1*7+2*9+3*11, 1*8+2*10+3*12] = [58, 64]
        // [4*7+5*9+6*11, 4*8+5*10+6*12] = [139, 154]
        assert_eq!(c, vec![58.0, 64.0, 139.0, 154.0]);
    }

    #[test]
    fn test_linear_basic() {
        // x=[[1,2]], w=[[1,1],[1,1]] (n=2, k=2), b=[0,0] → y=[[3,3]]
        let x = [1.0, 2.0];
        let w = [1.0, 1.0, 1.0, 1.0];
        let y = linear(&x, &w, None, 1, 2, 2);
        assert_eq!(y, vec![3.0, 3.0]);
    }

    #[test]
    fn test_rms_norm() {
        let x = [1.0, 2.0, 3.0, 4.0];
        let w = [1.0, 1.0, 1.0, 1.0];
        let y = rms_norm(&x, &w, 1, 4, 1e-6);
        // mean of squares = (1+4+9+16)/4 = 7.5, sqrt(7.5+eps) ≈ 2.7386
        let inv = 1.0 / (7.5_f32 + 1e-6).sqrt();
        assert!((y[0] - 1.0 * inv).abs() < 1e-5);
        assert!((y[3] - 4.0 * inv).abs() < 1e-5);
    }

    #[test]
    fn test_gelu() {
        // GELU(0) ≈ 0, GELU(1) ≈ 0.8412 (tanh approx)
        assert!(gelu(0.0).abs() < 1e-6);
        assert!((gelu(1.0) - 0.841_192).abs() < 1e-3);
    }
}
