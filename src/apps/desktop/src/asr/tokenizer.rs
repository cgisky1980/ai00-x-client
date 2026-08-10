use std::collections::HashMap;
use std::path::Path;

pub struct Tokenizer {
    #[allow(dead_code)]
    vocab: HashMap<String, i32>,
    id_to_token: HashMap<i32, String>,
    #[allow(dead_code)]
    added_tokens: HashMap<i32, String>,
}

impl Tokenizer {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let content = std::fs::read_to_string(path)?;
        let json: serde_json::Value = serde_json::from_str(&content)?;

        let mut vocab: HashMap<String, i32> = HashMap::new();
        let mut id_to_token: HashMap<i32, String> = HashMap::new();
        let mut added_tokens: HashMap<i32, String> = HashMap::new();

        if let Some(model) = json.get("model") {
            if let Some(v) = model.get("vocab") {
                if let Some(obj) = v.as_object() {
                    for (token, id_val) in obj {
                        if let Some(id) = id_val.as_i64() {
                            vocab.insert(token.clone(), id as i32);
                            id_to_token.insert(id as i32, token.clone());
                        }
                    }
                }
            }
        }

        if let Some(added) = json.get("added_tokens") {
            if let Some(arr) = added.as_array() {
                for item in arr {
                    if let (Some(id), Some(content)) = (item.get("id"), item.get("content")) {
                        if let (Some(id_val), Some(content_val)) = (id.as_i64(), content.as_str()) {
                            added_tokens.insert(id_val as i32, content_val.to_string());
                            id_to_token.insert(id_val as i32, content_val.to_string());
                        }
                    }
                }
            }
        }

        println!(
            "[Tokenizer] Loaded {} vocab tokens, {} added tokens",
            vocab.len(),
            added_tokens.len()
        );

        Ok(Self {
            vocab,
            id_to_token,
            added_tokens,
        })
    }

    pub fn decode(&self, tokens: &[i32]) -> String {
        let mut result = String::new();

        for &token_id in tokens {
            if let Some(token) = self.id_to_token.get(&token_id) {
                let decoded = self.decode_token(token);
                result.push_str(&decoded);
            } else {
                result.push_str(&format!("[{}]", token_id));
            }
        }

        result
    }

    fn decode_token(&self, token: &str) -> String {
        if token.starts_with("<|") && token.ends_with("|>") {
            return String::new();
        }

        if token.is_empty() {
            return String::new();
        }

        let mut result = String::new();

        for c in token.chars() {
            if c == 'Ġ' {
                if !result.is_empty() {
                    result.push(' ');
                }
            } else if c == 'Ċ' {
                result.push('\n');
            } else {
                result.push(c);
            }
        }

        result
    }

    pub fn token_to_string(&self, token_id: i32) -> Option<String> {
        self.id_to_token
            .get(&token_id)
            .map(|s| self.decode_token(s))
    }
}
