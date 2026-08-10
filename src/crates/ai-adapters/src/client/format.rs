use anyhow::{anyhow, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApiFormat {
    Ai00S,
    OpenAIChat,
    OpenAIResponses,
    Anthropic,
    Gemini,
    Rwkv,
}

impl ApiFormat {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        let normalized = value.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "ai00s" => Ok(Self::Ai00S),
            "openai" | "xfyun" => Ok(Self::OpenAIChat),
            "response" | "responses" => Ok(Self::OpenAIResponses),
            "anthropic" => Ok(Self::Anthropic),
            "gemini" | "google" => Ok(Self::Gemini),
            "rwkv" => Ok(Self::Rwkv),
            _ => Err(anyhow!("Unknown API format: {}", value)),
        }
    }
}
