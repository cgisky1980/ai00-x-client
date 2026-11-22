//! 会话状态缓存的前缀判定。
//!
//! RWKV 的 RNN 状态不可回退：只有「新 prompt 严格以缓存 token 为前缀」时才能
//! 复用缓存状态、只 prefill 增量；一旦中途分叉，必须整段重算（拿旧状态硬喂
//! 后缀会得到错乱输出——2026-11 的"双重喂入"事故即此类）。

/// 缓存可复用时的跳过长度（= cached 的全长）。
///
/// 返回 `Some(cached.len())` 当且仅当 `cached` 非空且 `prompt` **严格**以
/// `cached` 为前缀（严格 = prompt 更长，末尾至少还有一个待生成位置的 token）。
pub fn cache_extension(prompt: &[u32], cached: &[u32]) -> Option<usize> {
    if cached.is_empty() || prompt.len() <= cached.len() {
        return None;
    }
    prompt.starts_with(cached).then_some(cached.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_when_prompt_strictly_extends_cache() {
        assert_eq!(cache_extension(&[1, 2, 3, 4], &[1, 2, 3]), Some(3));
    }

    #[test]
    fn rejects_identical_prompt() {
        // 等价 prompt（无增量）不能借缓存状态：模型要从末 token 出 logits，
        // 缓存里只有状态没有 logits，必须整段重算。
        assert_eq!(cache_extension(&[1, 2, 3], &[1, 2, 3]), None);
    }

    #[test]
    fn rejects_divergent_prompt() {
        assert_eq!(cache_extension(&[1, 2, 9, 4], &[1, 2, 3, 4]), None);
        assert_eq!(cache_extension(&[9, 2, 3, 4], &[1, 2, 3]), None);
    }

    #[test]
    fn rejects_empty_cache_or_shorter_prompt() {
        assert_eq!(cache_extension(&[1, 2], &[]), None);
        assert_eq!(cache_extension(&[1], &[1, 2, 3]), None);
    }
}
