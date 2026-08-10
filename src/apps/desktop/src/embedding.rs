use model2vec_rs::model::StaticModel;
use once_cell::sync::OnceCell;
use std::path::PathBuf;
use std::sync::Mutex;

pub const EMBEDDING_MODEL_NAME: &str = "embeddinggemma-model2vec-256d";
pub const EMBEDDING_DIMENSION: usize = 256;

static EMBEDDING_SERVICE: OnceCell<Mutex<EmbeddingService>> = OnceCell::new();

#[derive(Debug)]
pub struct EmbeddingError(pub String);

impl std::fmt::Display for EmbeddingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for EmbeddingError {}

impl From<String> for EmbeddingError {
    fn from(s: String) -> Self {
        EmbeddingError(s)
    }
}

pub struct EmbeddingService {
    model: StaticModel,
    model_path: PathBuf,
}

impl EmbeddingService {
    pub fn new(model_path: PathBuf) -> Result<Self, EmbeddingError> {
        let model = Self::load_model(&model_path)?;
        Ok(Self { model, model_path })
    }

    fn load_model(model_path: &PathBuf) -> Result<StaticModel, EmbeddingError> {
        if !model_path.exists() {
            return Err(EmbeddingError(format!(
                "Embedding model not found at {:?}",
                model_path
            )));
        }

        log::info!("[Embedding] Loading model from: {:?}", model_path);

        StaticModel::from_pretrained(
            model_path.to_string_lossy().to_string(),
            None,
            Some(true),
            None,
        )
        .map_err(|e| EmbeddingError(format!("Failed to load model: {}", e)))
    }

    pub fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let embeddings = self.model.encode(&[text.to_string()]);
        embeddings
            .into_iter()
            .next()
            .ok_or_else(|| EmbeddingError("Failed to encode text".to_string()))
    }

    pub fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        Ok(self.model.encode(texts))
    }

    pub fn model_path(&self) -> &PathBuf {
        &self.model_path
    }
}

pub fn get_embedding_dir() -> PathBuf {
    crate::runtime::get_models_dir().join("embedding")
}

pub fn get_embedding_model_path() -> PathBuf {
    get_embedding_dir().join(EMBEDDING_MODEL_NAME)
}

pub fn is_embedding_model_available() -> bool {
    get_embedding_model_path().exists()
}

struct Model2VecEmbeddingProvider;

impl ai00_x_core::agent::tools::implementations::skills::embedding_provider::EmbeddingProvider
    for Model2VecEmbeddingProvider
{
    fn embed_text(&self, text: &str) -> Result<Vec<f32>, String> {
        get_embedding_service()
            .map_err(|e| e.0)?
            .lock()
            .map_err(|e| format!("lock: {}", e))?
            .embed(text)
            .map_err(|e| e.0)
    }

    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        get_embedding_service()
            .map_err(|e| e.0)?
            .lock()
            .map_err(|e| format!("lock: {}", e))?
            .embed_batch(texts)
            .map_err(|e| e.0)
    }

    fn dimension(&self) -> usize {
        EMBEDDING_DIMENSION
    }
}

pub fn init_embedding_provider() {
    ai00_x_core::agent::tools::implementations::skills::embedding_provider::set_embedding_provider(
        std::sync::Arc::new(Model2VecEmbeddingProvider),
    );
}

pub fn init_embedding_service() -> Result<(), EmbeddingError> {
    let model_path = get_embedding_model_path();
    log::info!("[Embedding] Model path: {:?}", model_path);

    if !model_path.exists() {
        log::warn!(
            "[Embedding] Model not found at {:?}, skipping initialization",
            model_path
        );
        return Err(EmbeddingError(format!(
            "Embedding model not found at {:?}",
            model_path
        )));
    }

    let service = EmbeddingService::new(model_path)?;
    EMBEDDING_SERVICE
        .set(Mutex::new(service))
        .map_err(|_| EmbeddingError("Embedding service already initialized".to_string()))?;

    log::info!("[Embedding] Service initialized successfully");
    Ok(())
}

pub fn get_embedding_service() -> Result<&'static Mutex<EmbeddingService>, EmbeddingError> {
    EMBEDDING_SERVICE
        .get()
        .ok_or_else(|| EmbeddingError("Embedding service not initialized".to_string()))
}

pub fn embed_text(text: &str) -> Result<Vec<f32>, EmbeddingError> {
    let service = get_embedding_service()?;
    let service = service
        .lock()
        .map_err(|e| EmbeddingError(format!("Lock error: {}", e)))?;
    service.embed(text)
}

pub fn embed_texts(texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
    let service = get_embedding_service()?;
    let service = service
        .lock()
        .map_err(|e| EmbeddingError(format!("Lock error: {}", e)))?;
    service.embed_batch(texts)
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}
