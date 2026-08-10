use once_cell::sync::Lazy;
use salvo::http::header::{HeaderValue, CONTENT_TYPE};
use salvo::prelude::*;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use zip::ZipArchive;

pub struct ZipAssets {
    files: HashMap<String, (Vec<u8>, String)>,
    default_file: String,
}

impl ZipAssets {
    pub fn load<P: AsRef<Path>>(zip_path: P, default_file: &str) -> Result<Self, String> {
        let zip_path = zip_path.as_ref();

        let file = std::fs::File::open(zip_path)
            .map_err(|e| format!("Failed to open zip file {:?}: {}", zip_path, e))?;

        let mut archive = ZipArchive::new(file)
            .map_err(|e| format!("Failed to read zip archive {:?}: {}", zip_path, e))?;

        let mut files = HashMap::new();

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;

            if entry.is_dir() {
                continue;
            }

            let name = entry.name().to_string();
            let normalized_path = normalize_path(&name);

            let mut content = Vec::new();
            entry
                .read_to_end(&mut content)
                .map_err(|e| format!("Failed to read file {}: {}", name, e))?;

            let mime = guess_mime_type(&normalized_path);

            files.insert(normalized_path, (content, mime));
        }

        log::info!(
            "[zip_serve] Loaded {} files from {:?}",
            files.len(),
            zip_path
        );

        Ok(Self {
            files,
            default_file: default_file.to_string(),
        })
    }

    pub fn get(&self, path: &str) -> Option<(&[u8], &str)> {
        let normalized = normalize_path(path);

        if let Some((content, mime)) = self.files.get(&normalized) {
            return Some((content.as_slice(), mime.as_str()));
        }

        if normalized.is_empty() || normalized.ends_with('/') {
            let default_path = if normalized.is_empty() {
                self.default_file.clone()
            } else {
                format!("{}{}", normalized, self.default_file)
            };

            if let Some((content, mime)) = self.files.get(&default_path) {
                return Some((content.as_slice(), mime.as_str()));
            }
        }

        let with_index = format!("{}/{}", normalized.trim_end_matches('/'), self.default_file);
        if let Some((content, mime)) = self.files.get(&with_index) {
            return Some((content.as_slice(), mime.as_str()));
        }

        None
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }
}

fn normalize_path(path: &str) -> String {
    path.trim_start_matches('/')
        .trim_start_matches('\\')
        .replace('\\', "/")
}

fn guess_mime_type(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "xml" => "application/xml",
        "txt" => "text/plain; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
    .to_string()
}

pub static MAIN_APP_ASSETS: Lazy<Option<Arc<ZipAssets>>> = Lazy::new(|| {
    let candidates = [
        "../../../dist/main.zip",
        "../dist/main.zip",
        "../../dist/main.zip",
        "dist/main.zip",
    ];
    for path_str in candidates {
        let zip_path = Path::new(path_str);
        if zip_path.exists() {
            match ZipAssets::load(zip_path, "index.html") {
                Ok(assets) => {
                    log::info!("[zip_serve] Main app assets loaded from ZIP: {}", path_str);
                    return Some(Arc::new(assets));
                }
                Err(e) => {
                    log::error!(
                        "[zip_serve] Failed to load main.zip from {}: {}",
                        path_str,
                        e
                    );
                }
            }
        }
    }
    log::info!("[zip_serve] main.zip not found, will use directory serving");
    None
});

pub static UNDERLAY_ASSETS: Lazy<Option<Arc<ZipAssets>>> = Lazy::new(|| {
    let candidates = [
        "../../../dist/underlay.zip",
        "../dist/underlay.zip",
        "../../dist/underlay.zip",
        "dist/underlay.zip",
    ];
    for path_str in candidates {
        let zip_path = Path::new(path_str);
        if zip_path.exists() {
            match ZipAssets::load(zip_path, "index.html") {
                Ok(assets) => {
                    log::info!("[zip_serve] Underlay assets loaded from ZIP: {}", path_str);
                    return Some(Arc::new(assets));
                }
                Err(e) => {
                    log::error!(
                        "[zip_serve] Failed to load underlay.zip from {}: {}",
                        path_str,
                        e
                    );
                }
            }
        }
    }
    log::info!("[zip_serve] underlay.zip not found, will use directory serving");
    None
});

#[handler]
pub async fn serve_main_app(req: &mut Request, res: &mut Response) {
    let path = req.param::<String>("path").unwrap_or_default();
    serve_from_zip_or_fallback(
        &MAIN_APP_ASSETS,
        &[
            "../../../dist/main",
            "../../dist/main",
            "../dist/main",
            "dist/main",
        ],
        &path,
        req,
        res,
    )
    .await
}

#[handler]
pub async fn serve_underlay(req: &mut Request, res: &mut Response) {
    let path = req.param::<String>("path").unwrap_or_default();
    serve_from_zip_or_fallback(
        &UNDERLAY_ASSETS,
        &[
            "../../../dist/underlay",
            "../../dist/underlay",
            "../dist/underlay",
            "dist/underlay",
        ],
        &path,
        req,
        res,
    )
    .await
}

async fn serve_from_zip_or_fallback(
    assets: &Option<Arc<ZipAssets>>,
    fallback_dirs: &[&str],
    path: &str,
    req: &Request,
    res: &mut Response,
) {
    if path.contains("..") {
        res.status_code(StatusCode::FORBIDDEN);
        return;
    }

    for dir in fallback_dirs {
        let fallback_path = Path::new(dir);
        if fallback_path.exists() {
            let target = fallback_path.join(path);

            if target.exists() && target.is_file() {
                let builder = salvo::fs::NamedFile::builder(&target);
                if let Ok(named_file) = builder.build().await {
                    named_file.send(req.headers(), res).await;
                    return;
                }
            }

            if target.exists() && target.is_dir() {
                let index_path = target.join("index.html");
                if index_path.exists() && index_path.is_file() {
                    let builder = salvo::fs::NamedFile::builder(&index_path);
                    if let Ok(named_file) = builder.build().await {
                        named_file.send(req.headers(), res).await;
                        return;
                    }
                }
            }
        }
    }

    if let Some(zip_assets) = assets {
        if let Some((content, mime)) = zip_assets.get(path) {
            log::debug!(
                "[zip_serve] found in ZIP: {} ({} bytes)",
                path,
                content.len()
            );
            res.headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_str(mime).unwrap());
            res.write_body(content.to_vec()).ok();
            return;
        }
    }

    let has_extension = Path::new(path)
        .extension()
        .map(|e| !e.is_empty())
        .unwrap_or(false);

    if !has_extension {
        for dir in fallback_dirs {
            let fallback_path = Path::new(dir);
            if fallback_path.exists() {
                let index_path = fallback_path.join("index.html");
                if index_path.exists() && index_path.is_file() {
                    let builder = salvo::fs::NamedFile::builder(&index_path);
                    if let Ok(named_file) = builder.build().await {
                        named_file.send(req.headers(), res).await;
                        return;
                    }
                }
            }
        }

        if let Some(zip_assets) = assets {
            if let Some((content, mime)) = zip_assets.get("") {
                res.headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_str(mime).unwrap());
                res.write_body(content.to_vec()).ok();
                return;
            }
        }
    }

    res.status_code(StatusCode::NOT_FOUND);
}
