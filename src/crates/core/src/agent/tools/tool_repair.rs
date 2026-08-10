pub const TOOL_ALIASES: &[(&str, &str)] = &[
    ("read", "Read"),
    ("write", "Write"),
    ("edit", "Edit"),
    ("delete", "Delete"),
    ("grep", "Grep"),
    ("glob", "Glob"),
    ("bash", "Bash"),
    ("run", "Bash"),
    ("ls", "LS"),
    ("search", "Grep"),
    ("find", "Glob"),
];

pub fn repair_tool_call(name: &str, valid_tools: &[&str]) -> Option<String> {
    let name_lower = name.to_lowercase();

    for (alias, canonical) in TOOL_ALIASES {
        if name_lower == alias.to_lowercase() && valid_tools.iter().any(|t| t == canonical) {
            return Some(canonical.to_string());
        }
    }

    let mut best: Option<(usize, &str)> = None;
    for valid in valid_tools {
        let dist = levenshtein_distance(&name_lower, &valid.to_lowercase());
        if dist <= 2 {
            match best {
                Some((best_dist, _)) if dist < best_dist => {
                    best = Some((dist, valid));
                }
                None => {
                    best = Some((dist, valid));
                }
                _ => {}
            }
        }
    }

    best.map(|(_, v)| v.to_string())
}

pub fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();

    let a_chars: Vec<char> = a_lower.chars().collect();
    let b_chars: Vec<char> = b_lower.chars().collect();

    let a_len = a_chars.len();
    let b_len = b_chars.len();

    if a_len == 0 {
        return b_len;
    }
    if b_len == 0 {
        return a_len;
    }

    let mut prev = vec![0usize; b_len + 1];
    let mut curr = vec![0usize; b_len + 1];

    for (j, slot) in prev.iter_mut().enumerate().take(b_len + 1) {
        *slot = j;
    }

    for i in 1..=a_len {
        curr[0] = i;
        for j in 1..=b_len {
            let cost = if a_chars[i - 1] == b_chars[j - 1] {
                0
            } else {
                1
            };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    prev[b_len]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_alias_mapping() {
        let valid = &[
            "Read", "Write", "Edit", "Delete", "Grep", "Glob", "Bash", "LS",
        ];
        assert_eq!(repair_tool_call("read", valid), Some("Read".to_string()));
        assert_eq!(repair_tool_call("READ", valid), Some("Read".to_string()));
        assert_eq!(repair_tool_call("run", valid), Some("Bash".to_string()));
        assert_eq!(repair_tool_call("ls", valid), Some("LS".to_string()));
        assert_eq!(repair_tool_call("search", valid), Some("Grep".to_string()));
        assert_eq!(repair_tool_call("find", valid), Some("Glob".to_string()));
    }

    #[test]
    fn test_levenshtein_fallback() {
        let valid = &["Read", "Write", "Edit"];
        assert_eq!(repair_tool_call("Reed", valid), Some("Read".to_string()));
        assert_eq!(repair_tool_call("Writ", valid), Some("Write".to_string()));
    }

    #[test]
    fn test_no_match() {
        let valid = &["Read", "Write"];
        assert_eq!(repair_tool_call("xyz", valid), None);
    }

    #[test]
    fn test_levenshtein_distance() {
        assert_eq!(levenshtein_distance("kitten", "sitting"), 3);
        assert_eq!(levenshtein_distance("", "abc"), 3);
        assert_eq!(levenshtein_distance("abc", ""), 3);
        assert_eq!(levenshtein_distance("abc", "abc"), 0);
        assert_eq!(levenshtein_distance("Read", "read"), 0);
    }
}
