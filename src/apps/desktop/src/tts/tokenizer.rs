use std::path::Path;
use tokenizers::Tokenizer as HfTokenizer;

pub struct Tokenizer {
    inner: HfTokenizer,
}

impl Tokenizer {
    pub fn load(model_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let path = model_dir.join("tokenizer").join("tokenizer.json");
        println!("Loading tokenizer from: {}", path.display());
        let inner =
            HfTokenizer::from_file(path).map_err(|e| format!("Failed to load tokenizer: {}", e))?;
        Ok(Self { inner })
    }

    pub fn encode(&self, text: &str) -> Vec<u32> {
        match self.inner.encode(text, false) {
            Ok(encoding) => encoding.get_ids().to_vec(),
            Err(e) => {
                eprintln!("Error encoding text '{}': {}", text, e);
                Vec::new()
            }
        }
    }

    pub fn decode(&self, ids: &[u32]) -> String {
        match self.inner.decode(ids, false) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Error decoding ids: {}", e);
                String::new()
            }
        }
    }
}
