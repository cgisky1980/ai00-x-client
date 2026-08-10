//! BPE tokenizer for the Qwen3-ForcedAligner.
//!
//! Ported from `forced_aligner.cpp` (`load_vocab`, `bytes_to_bpe_string`,
//! `bpe_encode_word`, `tokenize_with_timestamps`, `strip_word_punctuation`).
//!
//! Pipeline: split on whitespace → strip punctuation → prepend leading
//! space (except first word) → GPT-2 byte→unicode map → BPE merge →
//! lookup token IDs → append two `<timestamp>` tokens per word.

use std::collections::HashMap;

use super::model::ForcedAlignerModel;

/// GPT-2 byte-to-unicode: printable bytes map to themselves; non-printable
/// bytes map to codepoints 256+n. Returns a 256-entry table of UTF-8 strings.
fn byte_to_unicode_table() -> Vec<String> {
    let mut byte_to_cp = [0u32; 256];
    let mut assigned = [false; 256];

    // Printable ASCII range (excluding space).
    for b in 0x21..=0x7E {
        byte_to_cp[b as usize] = b as u32;
        assigned[b as usize] = true;
    }
    // Latin-1 printable range (skip DEL=0x7F and 0xAD soft hyphen).
    for b in 0xA1..=0xAC {
        byte_to_cp[b as usize] = b as u32;
        assigned[b as usize] = true;
    }
    for b in 0xAE..=0xFF {
        byte_to_cp[b as usize] = b as u32;
        assigned[b as usize] = true;
    }

    let mut n = 0u32;
    for b in 0..256 {
        if !assigned[b] {
            byte_to_cp[b] = 256 + n;
            n += 1;
        }
    }

    (0..256)
        .map(|b| {
            char::from_u32(byte_to_cp[b])
                .unwrap_or('\u{FFFD}')
                .to_string()
        })
        .collect()
}

/// Encode a string's bytes to BPE-unicode space (GPT-2 style).
fn bytes_to_bpe_string(s: &str) -> String {
    let table = byte_to_unicode_table();
    let mut out = String::with_capacity(s.len() * 2);
    for &byte in s.as_bytes() {
        out.push_str(&table[byte as usize]);
    }
    out
}

/// Split a UTF-8 string into per-character strings.
fn split_utf8_chars(s: &str) -> Vec<String> {
    s.chars().map(|c| c.to_string()).collect()
}

/// Greedy BPE merge: repeatedly merge the pair with the lowest rank until
/// no more merges are possible. `word_bpe` is the byte-mapped string.
fn bpe_encode_word(word_bpe: &str, bpe_ranks: &HashMap<String, i32>) -> Vec<String> {
    let mut symbols = split_utf8_chars(word_bpe);
    if symbols.len() <= 1 {
        return symbols;
    }

    loop {
        let mut best_rank = i32::MAX;
        let mut best_pos: Option<usize> = None;
        for i in 0..(symbols.len() - 1) {
            let key = format!("{} {}", symbols[i], symbols[i + 1]);
            if let Some(&r) = bpe_ranks.get(&key) {
                if r < best_rank {
                    best_rank = r;
                    best_pos = Some(i);
                }
            }
        }

        let pos = match best_pos {
            Some(p) => p,
            None => break,
        };

        let merged = format!("{}{}", symbols[pos], symbols[pos + 1]);
        let mut new_symbols = Vec::with_capacity(symbols.len() - 1);
        for (i, s) in symbols.iter().enumerate() {
            if i == pos {
                new_symbols.push(merged.clone());
            } else if i != pos + 1 {
                new_symbols.push(s.clone());
            }
        }
        symbols = new_symbols;
        if symbols.len() == 1 {
            break;
        }
    }

    symbols
}

/// Strip leading/trailing ASCII punctuation (non-alphanumeric, < 0x80).
/// Matches `strip_word_punctuation` in forced_aligner.cpp.
fn strip_word_punctuation(word: &str) -> String {
    let is_punct = |c: char| -> bool {
        let v = c as u32;
        v < 0x80 && !c.is_ascii_alphanumeric()
    };
    word.trim_matches(is_punct).to_string()
}

/// Tokenize `text` into BPE token IDs with two `timestamp_token_id` markers
/// appended per word. Returns `(words, tokens)` where `words` preserves the
/// original surface form (with punctuation) and `tokens` is the flat ID
/// sequence including the timestamp markers.
pub fn tokenize_with_timestamps(
    model: &ForcedAlignerModel,
    text: &str,
    language: &str,
) -> (Vec<String>, Vec<i32>) {
    let _ = language; // Korean dict-based splitting not yet wired up.
    let timestamp_id = model.hparams().timestamp_token_id;

    // Whitespace word split (matches the C++ non-Korean branch).
    let raw_words: Vec<String> = text.split_whitespace().map(|s| s.to_string()).collect();

    let mut words = Vec::with_capacity(raw_words.len());
    let mut tokens = Vec::new();
    let mut first_word = true;

    for raw in raw_words {
        let clean = strip_word_punctuation(&raw);
        if clean.is_empty() {
            // Pure-punctuation token — skip entirely so word/timestamp-pair
            // counts stay in sync (matches C++ behavior).
            continue;
        }
        words.push(raw);

        // Non-first words carry a leading space in the Qwen vocab.
        let to_encode = if first_word {
            clean.clone()
        } else {
            format!(" {}", clean)
        };
        first_word = false;

        let bpe_str = bytes_to_bpe_string(&to_encode);
        let subwords = bpe_encode_word(&bpe_str, &model.bpe_ranks);

        for sw in subwords {
            if let Some(&id) = model.token_to_id.get(&sw) {
                tokens.push(id);
            } else {
                log::warn!("[FA] BPE tokenizer: unknown subword token '{}'", sw);
            }
        }

        tokens.push(timestamp_id);
        tokens.push(timestamp_id);
    }

    (words, tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_byte_to_unicode_printable() {
        let t = byte_to_unicode_table();
        // Printable ASCII bytes map to themselves.
        for b in 0x21..=0x7E {
            assert_eq!(t[b as usize], (b as u8 as char).to_string());
        }
    }

    #[test]
    fn test_bytes_to_bpe_string_space() {
        // Space (0x20) is non-printable in the GPT-2 table → maps to 'Ġ'.
        let s = bytes_to_bpe_string(" hello");
        assert_eq!(s, "Ġhello");
    }

    #[test]
    fn test_strip_punctuation() {
        assert_eq!(strip_word_punctuation(",hello!"), "hello");
        assert_eq!(strip_word_punctuation("..."), "");
        assert_eq!(strip_word_punctuation("你好"), "你好"); // CJK preserved
    }

    #[test]
    fn test_bpe_no_merges() {
        let ranks = HashMap::new();
        let out = bpe_encode_word("abc", &ranks);
        assert_eq!(out, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn test_bpe_one_merge() {
        let mut ranks = HashMap::new();
        ranks.insert("a b".to_string(), 0);
        let out = bpe_encode_word("ab", &ranks);
        assert_eq!(out, vec!["ab".to_string()]);
    }
}
