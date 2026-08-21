//! Trained MLP classification head for the smart router.
//!
//! Ports the state-embedding classifier from the rwkv-router paper path
//! (`paper/scripts/03_classification.py`, test_acc=0.9325): a two-layer MLP
//! over the mean-pooled last-layer hidden state of the RWKV backbone.
//!
//! Pipeline (matching the PyTorch training exactly):
//!   standardize (x-mean)/std -> Linear -> GELU -> LayerNorm -> Linear -> softmax
//!
//! Weight JSON contract (exported by `client/scripts/router_head/train_mlp.py`):
//! ```json
//! { "version": 1, "input_dim": 2560, "hidden_dim": 256,
//!   "mean": [input_dim], "std": [input_dim],
//!   "w1": [hidden_dim * input_dim], "b1": [hidden_dim],   // w1 row-major [out][in]
//!   "ln_g": [hidden_dim], "ln_b": [hidden_dim],
//!   "w2": [4 * hidden_dim], "b2": [4] }                    // w2 row-major [out][in]
//! ```
//! Linear weights use the PyTorch `nn.Linear.weight` layout ([out_features,
//! in_features] row-major), so `y = x @ W^T + b` — the exporter can flatten
//! the tensor directly without transposing.

use serde::Deserialize;
use std::path::Path;

const LN_EPS: f32 = 1e-5;
const STD_MIN: f32 = 1e-6;
const MAX_HEAD_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Trained router classification head (pure logic, no GPU dependency).
#[derive(Debug, Clone)]
pub struct RouterHead {
    input_dim: usize,
    hidden_dim: usize,
    mean: Vec<f32>,
    std: Vec<f32>,
    /// Linear1 weight, row-major [hidden_dim][input_dim].
    w1: Vec<f32>,
    b1: Vec<f32>,
    ln_g: Vec<f32>,
    ln_b: Vec<f32>,
    /// Linear2 weight, row-major [4][hidden_dim].
    w2: Vec<f32>,
    b2: Vec<f32>,
}

#[derive(Deserialize)]
struct HeadJson {
    version: u32,
    input_dim: usize,
    hidden_dim: usize,
    mean: Vec<f32>,
    std: Vec<f32>,
    w1: Vec<f32>,
    b1: Vec<f32>,
    ln_g: Vec<f32>,
    ln_b: Vec<f32>,
    w2: Vec<f32>,
    b2: Vec<f32>,
}

impl RouterHead {
    /// Loads a head from a JSON weight file.
    pub fn from_json_file(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        let meta = std::fs::metadata(path).map_err(|e| format!("router head stat failed: {e}"))?;
        if meta.len() > MAX_HEAD_FILE_BYTES {
            return Err(format!("router head file too large: {} bytes", meta.len()));
        }
        let text =
            std::fs::read_to_string(path).map_err(|e| format!("router head read failed: {e}"))?;
        Self::from_json_str(&text)
    }

    /// Parses a head from a JSON string.
    pub fn from_json_str(text: &str) -> Result<Self, String> {
        let raw: HeadJson =
            serde_json::from_str(text).map_err(|e| format!("router head parse failed: {e}"))?;
        if raw.version != 1 {
            return Err(format!("unsupported router head version: {}", raw.version));
        }
        let head = RouterHead {
            input_dim: raw.input_dim,
            hidden_dim: raw.hidden_dim,
            mean: raw.mean,
            std: raw.std,
            w1: raw.w1,
            b1: raw.b1,
            ln_g: raw.ln_g,
            ln_b: raw.ln_b,
            w2: raw.w2,
            b2: raw.b2,
        };
        head.validate()?;
        Ok(head)
    }

    fn validate(&self) -> Result<(), String> {
        let (i, h) = (self.input_dim, self.hidden_dim);
        let checks = [
            (self.mean.len(), i, "mean"),
            (self.std.len(), i, "std"),
            (self.w1.len(), h * i, "w1"),
            (self.b1.len(), h, "b1"),
            (self.ln_g.len(), h, "ln_g"),
            (self.ln_b.len(), h, "ln_b"),
            (self.w2.len(), 4 * h, "w2"),
            (self.b2.len(), 4, "b2"),
        ];
        for (actual, expected, name) in checks {
            if actual != expected {
                return Err(format!(
                    "router head field '{name}' has {actual} elements, expected {expected}"
                ));
            }
        }
        if i == 0 || h == 0 {
            return Err("router head dims must be positive".to_string());
        }
        Ok(())
    }

    /// Expected hidden-state dimension (must equal the backbone n_embd).
    pub fn input_dim(&self) -> usize {
        self.input_dim
    }

    /// MLP hidden layer width.
    pub fn hidden_dim(&self) -> usize {
        self.hidden_dim
    }

    /// Classifies a mean-pooled hidden state into R0-R3 probabilities.
    pub fn forward(&self, hidden: &[f32]) -> Result<[f32; 4], String> {
        if hidden.len() != self.input_dim {
            return Err(format!(
                "hidden dim {} != head input_dim {} (model/head mismatch)",
                hidden.len(),
                self.input_dim
            ));
        }

        // 1. Standardize with train-set statistics.
        let x: Vec<f32> = hidden
            .iter()
            .zip(&self.mean)
            .zip(&self.std)
            .map(|((&h, &m), &s)| (h - m) / s.max(STD_MIN))
            .collect();

        // 2. Linear1: z = x @ w1^T + b1.
        let mut z = self.b1.clone();
        for (j, acc) in z.iter_mut().enumerate() {
            let row = &self.w1[j * self.input_dim..(j + 1) * self.input_dim];
            let mut sum = *acc;
            for (wv, xv) in row.iter().zip(&x) {
                sum += wv * xv;
            }
            *acc = sum;
        }

        // 3. GELU (tanh approximation; max error vs exact ~3e-4).
        for v in z.iter_mut() {
            *v = gelu(*v);
        }

        // 4. LayerNorm (eps=1e-5, matching PyTorch default).
        let mu: f32 = z.iter().sum::<f32>() / z.len() as f32;
        let var: f32 = z.iter().map(|v| (v - mu) * (v - mu)).sum::<f32>() / z.len() as f32;
        let inv_std = 1.0 / (var + LN_EPS).sqrt();
        let y: Vec<f32> = z
            .iter()
            .zip(&self.ln_g)
            .zip(&self.ln_b)
            .map(|((&v, &g), &b)| (v - mu) * inv_std * g + b)
            .collect();

        // 5. Linear2: logits = y @ w2^T + b2, then softmax.
        let mut logits = [0.0f32; 4];
        for (j, acc) in logits.iter_mut().enumerate() {
            let row = &self.w2[j * self.hidden_dim..(j + 1) * self.hidden_dim];
            let mut sum = self.b2[j];
            for (wv, yv) in row.iter().zip(&y) {
                sum += wv * yv;
            }
            *acc = sum;
        }
        Ok(softmax4(&logits))
    }
}

fn gelu(x: f32) -> f32 {
    const SQRT_2_OVER_PI: f32 = 0.797_884_6;
    let inner = SQRT_2_OVER_PI * (x + 0.044_715 * x * x * x);
    0.5 * x * (1.0 + inner.tanh())
}

fn softmax4(logits: &[f32; 4]) -> [f32; 4] {
    let max = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exps: [f32; 4] = std::array::from_fn(|i| (logits[i] - max).exp());
    let sum: f32 = exps.iter().sum();
    if sum > 0.0 && sum.is_finite() {
        std::array::from_fn(|i| exps[i] / sum)
    } else {
        [0.25; 4]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a tiny head (input=2, hidden=2) with known weights so the
    /// forward pass can be verified by hand.
    fn toy_head() -> RouterHead {
        // mean=0, std=1 -> standardization is identity.
        // w1 (row-major [2][2]): z0 = x0, z1 = x1 (identity Linear).
        // ln_g=1, ln_b=0 -> LN is pure normalization.
        // w2 (row-major [4][2]): logits = [y0, y1, y0+y1, 0].
        let json = r#"{
            "version": 1, "input_dim": 2, "hidden_dim": 2,
            "mean": [0.0, 0.0], "std": [1.0, 1.0],
            "w1": [1.0, 0.0, 0.0, 1.0], "b1": [0.0, 0.0],
            "ln_g": [1.0, 1.0], "ln_b": [0.0, 0.0],
            "w2": [1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0],
            "b2": [0.0, 0.0, 0.0, 0.0]
        }"#;
        RouterHead::from_json_str(json).expect("toy head should parse")
    }

    #[test]
    fn forward_matches_hand_computation() {
        let head = toy_head();
        // x = [1, 1] -> z = [gelu(1), gelu(1)] (equal) -> LN -> y = [0, 0]
        // logits = [0, 0, 0, 0] -> uniform softmax.
        let probs = head.forward(&[1.0, 1.0]).unwrap();
        for p in probs {
            assert!((p - 0.25).abs() < 1e-6, "{probs:?}");
        }
    }

    #[test]
    fn forward_distinguishes_directions() {
        let head = toy_head();
        // x = [3, 0]: z = [gelu(3), 0] -> LN -> y = [+1, -1]
        //   logits = [1, -1, 0, 0] -> argmax 0.
        let probs0 = head.forward(&[3.0, 0.0]).unwrap();
        // x = [0, 3]: mirrored -> logits = [-1, 1, 0, 0] -> argmax 1.
        let probs1 = head.forward(&[0.0, 3.0]).unwrap();
        let argmax = |p: &[f32; 4]| {
            p.iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
                .map(|(i, _)| i)
                .unwrap()
        };
        assert_eq!(argmax(&probs0), 0, "{probs0:?}");
        assert_eq!(argmax(&probs1), 1, "{probs1:?}");
        assert!(probs0[0] > 0.5, "{probs0:?}");
        assert!(probs1[1] > 0.5, "{probs1:?}");
    }

    #[test]
    fn standardization_is_applied() {
        let json = r#"{
            "version": 1, "input_dim": 1, "hidden_dim": 1,
            "mean": [2.0], "std": [0.5],
            "w1": [1.0], "b1": [0.0],
            "ln_g": [1.0], "ln_b": [0.0],
            "w2": [1.0, 0.0, 0.0, 0.0],
            "b2": [0.0, 0.0, 0.0, 0.0]
        }"#;
        let head = RouterHead::from_json_str(json).unwrap();
        // x = (3-2)/0.5 = 2 -> z = gelu(2) -> LN(单元素) = 0 -> logits 全 0 -> uniform。
        let probs = head.forward(&[3.0]).unwrap();
        assert!((probs[0] - 0.25).abs() < 1e-6, "{probs:?}");
    }

    #[test]
    fn rejects_dim_mismatch_and_bad_fields() {
        let head = toy_head();
        assert!(head.forward(&[1.0]).is_err());
        assert!(head.forward(&[1.0, 2.0, 3.0]).is_err());

        let bad = r#"{
            "version": 1, "input_dim": 2, "hidden_dim": 2,
            "mean": [0.0, 0.0], "std": [1.0, 1.0],
            "w1": [1.0, 0.0], "b1": [0.0, 0.0],
            "ln_g": [1.0, 1.0], "ln_b": [0.0, 0.0],
            "w2": [1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0],
            "b2": [0.0, 0.0, 0.0, 1.0]
        }"#;
        assert!(RouterHead::from_json_str(bad).is_err());
        assert!(RouterHead::from_json_str("{}").is_err());
    }

    #[test]
    fn input_dim_reported() {
        assert_eq!(toy_head().input_dim(), 2);
    }
}
