//! 轻量 GGUF 元数据读取器（只读 header + KV 元数据，不加载张量）。
//!
//! 供 llama-server 启动前读取模型层数 / KV 注意力形状，用于在显存不足
//! 全量 offload 时计算可行的部分卸载层数（-ngl）。纯 std::io 实现，
//! 无第三方依赖；GGUF v2/v3 布局相同。

use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::path::Path;

/// 部分卸载决策所需的模型元数据。
pub struct LlmMeta {
    /// transformer 层数（`<arch>.block_count`）
    pub n_layers: u32,
    /// KV 头数（`<arch>.attention.head_count_kv`，MHA 模型取数组首元素）
    pub n_kv_heads: u32,
    /// 每头维度（`<arch>.attention.key_length`，缺省 embedding_length/head_count）
    pub head_dim: u32,
}

/// 标量收集器：只保留关心的标量 KV，数组取首元素，其余消费后丢弃。
#[derive(Default)]
struct MetaScraper {
    scalars: HashMap<String, u64>,
    strings: HashMap<String, String>,
}

impl MetaScraper {
    fn u64_of(&self, key: &str) -> Option<u64> {
        self.scalars.get(key).copied()
    }

    fn finish(self) -> Result<LlmMeta, String> {
        let arch = self
            .strings
            .get("general.architecture")
            .cloned()
            .ok_or_else(|| "gguf: missing general.architecture".to_string())?;
        let n_layers = self
            .u64_of(&format!("{arch}.block_count"))
            .ok_or_else(|| format!("gguf: missing {arch}.block_count"))?;
        let n_kv_heads = self
            .u64_of(&format!("{arch}.attention.head_count_kv"))
            .ok_or_else(|| format!("gguf: missing {arch}.attention.head_count_kv"))?;
        let head_dim = match self.u64_of(&format!("{arch}.attention.key_length")) {
            Some(v) => v,
            None => {
                let n_heads = self
                    .u64_of(&format!("{arch}.attention.head_count"))
                    .ok_or_else(|| format!("gguf: missing {arch}.attention.head_count"))?;
                let emb = self
                    .u64_of(&format!("{arch}.embedding_length"))
                    .ok_or_else(|| format!("gguf: missing {arch}.embedding_length"))?;
                if n_heads == 0 {
                    return Err("gguf: attention.head_count is 0".to_string());
                }
                emb / n_heads
            }
        };
        if n_layers == 0 || n_kv_heads == 0 || head_dim == 0 {
            return Err(format!(
                "gguf: degenerate meta (layers={n_layers}, kv_heads={n_kv_heads}, head_dim={head_dim})"
            ));
        }
        let fit =
            |v: u64, what: &str| u32::try_from(v).map_err(|_| format!("gguf: {what} overflow"));
        Ok(LlmMeta {
            n_layers: fit(n_layers, "block_count")?,
            n_kv_heads: fit(n_kv_heads, "head_count_kv")?,
            head_dim: fit(head_dim, "head_dim")?,
        })
    }
}

fn read_u32(r: &mut impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64(r: &mut impl Read) -> std::io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

fn read_string(r: &mut impl Read) -> std::io::Result<String> {
    let len = read_u64(r)?;
    // 防御：字符串长度上限 4MB，超出视为损坏文件
    if len > 4 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "gguf string too long",
        ));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    String::from_utf8(buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// GGUF 元数据值类型（gguf.h enum gguf_type）。
const T_STRING: u32 = 8;
const T_ARRAY: u32 = 9;

/// 标量类型字节宽度；None 表示字符串/数组之外的嵌套容器不存在的保证失败。
fn scalar_len(t: u32) -> Option<u64> {
    match t {
        0 | 1 | 7 => Some(1), // u8/i8/bool
        2 | 3 => Some(2),     // u16/i16
        4..=6 => Some(4),     // u32/i32/f32
        10..=12 => Some(8),   // u64/i64/f64
        _ => None,
    }
}

/// 标量字节 → u64（仅计数有意义的整型/布尔；浮点不捕获）。
fn scalar_as_u64(t: u32, raw: &[u8]) -> Option<u64> {
    Some(match t {
        0 => raw[0] as u64,
        1 => raw[0] as i8 as i64 as u64,
        2 => u16::from_le_bytes(raw[..2].try_into().ok()?) as u64,
        3 => i16::from_le_bytes(raw[..2].try_into().ok()?) as i64 as u64,
        4 => u32::from_le_bytes(raw[..4].try_into().ok()?) as u64,
        5 => i32::from_le_bytes(raw[..4].try_into().ok()?) as i64 as u64,
        7 => (raw[0] != 0) as u64,
        10 => u64::from_le_bytes(raw[..8].try_into().ok()?),
        11 => i64::from_le_bytes(raw[..8].try_into().ok()?) as u64,
        _ => return None,
    })
}

/// 单次批量读上限：超过则分块丢弃（防御损坏/超常文件）。
const BATCH_LIMIT: u64 = 64 * 1024 * 1024;

/// 消费一个任意类型的值；顶层标量/字符串按 key 捕获。
fn consume_value(
    r: &mut impl Read,
    t: u32,
    key: &str,
    s: &mut MetaScraper,
    depth: u32,
) -> std::io::Result<()> {
    if t == T_STRING {
        let v = read_string(r)?;
        if depth == 0 {
            s.strings.insert(key.to_string(), v);
        }
        return Ok(());
    }
    if t == T_ARRAY {
        if depth > 1 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "gguf nested array too deep",
            ));
        }
        let elem_t = read_u32(r)?;
        let count = read_u64(r)?;
        match scalar_len(elem_t) {
            Some(w) => {
                // 标量数组：小数组批量读，超大数组分块丢弃；只捕获顶层首元素
                let total = w.saturating_mul(count);
                if total <= BATCH_LIMIT {
                    let mut buf = vec![0u8; total as usize];
                    r.read_exact(&mut buf)?;
                    if depth == 0 && count > 0 {
                        if let Some(v) = scalar_as_u64(elem_t, &buf[..w as usize]) {
                            s.scalars.insert(key.to_string(), v);
                        }
                    }
                } else {
                    let mut remaining = total;
                    let mut chunk = [0u8; 65536];
                    while remaining > 0 {
                        let n = remaining.min(chunk.len() as u64) as usize;
                        r.read_exact(&mut chunk[..n])?;
                        remaining -= n as u64;
                    }
                }
            }
            None => {
                // 字符串数组（如 tokenizer.ggml.tokens）或嵌套数组：逐元素消费
                for i in 0..count {
                    consume_value(r, elem_t, &format!("{key}[{i}]"), s, depth + 1)?;
                }
            }
        }
        return Ok(());
    }
    let w = scalar_len(t).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, format!("gguf type {t}"))
    })?;
    let mut raw = [0u8; 8];
    r.read_exact(&mut raw[..w as usize])?;
    if depth == 0 {
        if let Some(v) = scalar_as_u64(t, &raw) {
            s.scalars.insert(key.to_string(), v);
        }
    }
    Ok(())
}

/// 读取 GGUF 的 LLM 形状元数据（层数 / KV 头数 / 每头维度）。
pub fn read_llm_meta(path: &Path) -> Result<LlmMeta, String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("gguf open {}: {e}", path.display()))?;
    let mut r = BufReader::with_capacity(256 * 1024, file);
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)
        .map_err(|e| format!("gguf read magic: {e}"))?;
    if &magic != b"GGUF" {
        return Err(format!("gguf: bad magic in {}", path.display()));
    }
    let _version = read_u32(&mut r).map_err(|e| format!("gguf read version: {e}"))?;
    let _tensor_count = read_u64(&mut r).map_err(|e| format!("gguf read tensor_count: {e}"))?;
    let kv_count = read_u64(&mut r).map_err(|e| format!("gguf read kv_count: {e}"))?;

    let mut scraper = MetaScraper::default();
    for _ in 0..kv_count {
        let key = read_string(&mut r).map_err(|e| format!("gguf read key: {e}"))?;
        let vtype = read_u32(&mut r).map_err(|e| format!("gguf read value type: {e}"))?;
        consume_value(&mut r, vtype, &key, &mut scraper, 0)
            .map_err(|e| format!("gguf read value `{key}`: {e}"))?;
        // 拿到 general.architecture 后仍需继续扫描——层数/KV 形状键带 arch 前缀
    }
    scraper.finish()
}

#[cfg(test)]
mod tests {
    /// 手动验证：`AI00_TEST_GGUF=<gguf路径> cargo test --release -p ai00-x-desktop read_llm_meta`
    /// 未设置环境变量时跳过（CI 无本地模型）。
    #[test]
    #[allow(clippy::unwrap_used)] // 测试代码：手动验证用
    fn reads_real_gguf_meta() {
        let Ok(path) = std::env::var("AI00_TEST_GGUF") else {
            eprintln!("AI00_TEST_GGUF not set; skipped");
            return;
        };
        let meta = super::read_llm_meta(std::path::Path::new(&path)).unwrap();
        println!(
            "layers={} kv_heads={} head_dim={}",
            meta.n_layers, meta.n_kv_heads, meta.head_dim
        );
        assert!(meta.n_layers > 0 && meta.n_kv_heads > 0 && meta.head_dim > 0);
    }
}
