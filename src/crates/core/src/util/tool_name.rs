//! 工具名归一：本地小模型偶尔把工具名写坏（实测 research worker 三次产出
//! `ai0000-research_collect`——多一个 `0`），引擎侧回 unknown tool，整轮白烧。
//!
//! 这里按「精确 → 忽略大小写/符号 → 编辑距离 ≤2」三级把写坏的名字映射回
//! 请求里真实存在的工具名；拿不准（多个候选同样接近）就原样返回，交给引擎报错。

/// 把模型写坏的工具名映射回 `available` 里的规范名。
pub fn normalize_tool_name(name: &str, available: &[String]) -> String {
    if available.is_empty() || available.iter().any(|candidate| candidate == name) {
        return name.to_string();
    }
    let key = tool_name_key(name);
    if let Some(hit) = available
        .iter()
        .find(|candidate| tool_name_key(candidate) == key)
    {
        return hit.clone();
    }
    let mut best: Option<(usize, &String)> = None;
    let mut ambiguous = false;
    for candidate in available {
        let distance = bounded_levenshtein(&key, &tool_name_key(candidate), 3);
        if distance > 2 {
            continue;
        }
        match best {
            Some((best_distance, _)) if distance == best_distance => ambiguous = true,
            Some((best_distance, _)) if distance > best_distance => {}
            _ => {
                best = Some((distance, candidate));
                ambiguous = false;
            }
        }
    }
    match best {
        Some((_, candidate)) if !ambiguous => candidate.clone(),
        _ => name.to_string(),
    }
}

/// 工具名比较键：小写并去掉除字母数字外的所有字符
/// （`ai0000-research_collect` 与 `ai00_research_collect` 只差一个 `0`）。
fn tool_name_key(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

/// 带提前退出的编辑距离：长度差或整行最小代价超限即返回 `cap + 1`。
fn bounded_levenshtein(a: &str, b: &str, cap: usize) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > cap {
        return cap + 1;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        current[0] = i + 1;
        let mut row_min = current[0];
        for (j, cb) in b.iter().enumerate() {
            let substitution = prev[j] + usize::from(ca != cb);
            let insertion = current[j] + 1;
            let deletion = prev[j + 1] + 1;
            current[j + 1] = substitution.min(insertion).min(deletion);
            row_min = row_min.min(current[j + 1]);
        }
        if row_min > cap {
            return cap + 1;
        }
        std::mem::swap(&mut prev, &mut current);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn available() -> Vec<String> {
        vec![
            "ai00_research_collect".to_string(),
            "ai00_web_extract".to_string(),
            "ai00_plan_write".to_string(),
        ]
    }

    #[test]
    fn repairs_degraded_name() {
        // 实测退化形态：多一个 0、连字符代替下划线（任务 t-1795357657531-fhs）
        assert_eq!(
            normalize_tool_name("ai0000-research_collect", &available()),
            "ai00_research_collect"
        );
    }

    #[test]
    fn repairs_case_and_symbol_drift() {
        assert_eq!(
            normalize_tool_name("AI00_WEB_EXTRACT", &available()),
            "ai00_web_extract"
        );
        assert_eq!(
            normalize_tool_name("ai00.web-extract", &available()),
            "ai00_web_extract"
        );
    }

    #[test]
    fn keeps_exact_and_unrelated_names() {
        assert_eq!(
            normalize_tool_name("ai00_plan_write", &available()),
            "ai00_plan_write"
        );
        assert_eq!(
            normalize_tool_name("totally_unknown", &available()),
            "totally_unknown"
        );
        assert_eq!(normalize_tool_name("anything", &[]), "anything");
    }

    #[test]
    fn leaves_ambiguous_name_untouched() {
        let available = vec!["tool_alpha".to_string(), "tool_alphb".to_string()];
        assert_eq!(normalize_tool_name("tool_alphc", &available), "tool_alphc");
    }
}
