use once_cell::sync::Lazy;
use salvo::http::header::{HeaderValue, CACHE_CONTROL, CONTENT_TYPE};
use salvo::prelude::*;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use zip::ZipArchive;

/// Vite 构建产物（assets/<hash>.js|css）文件名含内容 hash，永不变化 → 长缓存。
/// index.html / SPA fallback 必须每次重新拉取，否则 WebView 的 HTTP 缓存会
/// 保留旧 index.html，引用的旧 hash 资源在新 zip 中不存在（404 白屏）。
fn apply_cache_headers(res: &mut Response, path: &str) {
    let immutable_asset = path.starts_with("assets/") && Path::new(path).extension().is_some();
    let value = if immutable_asset {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    if let Ok(v) = HeaderValue::from_str(value) {
        res.headers_mut().insert(CACHE_CONTROL, v);
    }
}

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

/// 收集去重后的候选路径（按插入顺序）。
fn dedup_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for p in paths {
        let key = p.to_string_lossy().to_string();
        if seen.insert(key) {
            out.push(p);
        }
    }
    out
}

/// dist 根目录候选：优先基于 exe 所在目录（exe 在 `<repo>/target/<profile>`，dist 在 `<repo>/dist`），
/// 再兜底基于当前工作目录（兼容 tauri dev 把 CWD 设为 src/apps/desktop 等布局）。
/// 注意：用 explorer 等直接启动时 CWD 可能是系统目录，因此 exe 相对路径必须优先。
fn dist_root_candidates() -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            list.push(dir.join("../../dist")); // <repo>/dist（release 布局）
            list.push(dir.join("../dist")); // <repo>/target/dist（少见布局）
            list.push(dir.join("dist")); // <exe>/dist（资源同目录兜底）
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        list.push(cwd.join("../../../dist"));
        list.push(cwd.join("../../dist"));
        list.push(cwd.join("../dist"));
        list.push(cwd.join("dist"));
    }
    dedup_paths(list)
}

/// ZIP 文件候选路径：先看 exe 旁的安装布局（bundle.resources 会把 zip 放资源目录），
/// 再查 dist 根目录布局。
fn zip_candidates(name: &str) -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            list.push(dir.join(name)); // 安装布局：<exe>/loader.zip
            list.push(dir.join("../resources").join(name)); // macOS 布局
        }
    }
    list.extend(dist_root_candidates().into_iter().map(|d| d.join(name)));
    dedup_paths(list)
}

/// 目录服务候选路径（dist 根目录 + 相对子路径）。
pub(crate) fn dir_candidates(rel: &str) -> Vec<PathBuf> {
    dedup_paths(dist_root_candidates().into_iter().map(|d| d.join(rel)))
}

/// 尝试从候选 ZIP 加载资源，成功返回 Some，全部失败返回 None。
fn load_zip_assets(name: &str, default_file: &str) -> Option<Arc<ZipAssets>> {
    for zip_path in zip_candidates(name) {
        if zip_path.exists() {
            match ZipAssets::load(&zip_path, default_file) {
                Ok(assets) => {
                    log::info!(
                        "[zip_serve] {} loaded from ZIP: {}",
                        name,
                        zip_path.display()
                    );
                    return Some(Arc::new(assets));
                }
                Err(e) => {
                    log::error!(
                        "[zip_serve] Failed to load {} from {}: {}",
                        name,
                        zip_path.display(),
                        e
                    );
                }
            }
        }
    }
    log::info!("[zip_serve] {} not found, will use directory serving", name);
    None
}

pub static MAIN_APP_ASSETS: Lazy<Option<Arc<ZipAssets>>> =
    Lazy::new(|| load_zip_assets("main.zip", "index.html"));

pub static UNDERLAY_ASSETS: Lazy<Option<Arc<ZipAssets>>> =
    Lazy::new(|| load_zip_assets("underlay.zip", "index.html"));

/// Loader 前端资源（统一走 zip 打包，dev/正式环境一致；目录服务仅作兜底）
pub static LOADER_ASSETS: Lazy<Option<Arc<ZipAssets>>> =
    Lazy::new(|| load_zip_assets("loader.zip", "index.html"));

/// 为指定资源生成目录候选向量（惰性求值，每次调用重新计算，因为 CWD/exe 可能在运行时变化）。
/// 但实际使用中 Lazy 初始化后这些路径其实不会变，这里用函数只是方便调用。
fn loader_dir_candidates() -> Vec<PathBuf> {
    dir_candidates("loader")
}

fn main_dir_candidates() -> Vec<PathBuf> {
    dir_candidates("main")
}

fn underlay_dir_candidates() -> Vec<PathBuf> {
    dir_candidates("underlay")
}

#[handler]
pub async fn serve_main_app(req: &mut Request, res: &mut Response) {
    let path = req.param::<String>("path").unwrap_or_default();
    serve_from_zip_or_fallback(&MAIN_APP_ASSETS, &main_dir_candidates(), &path, req, res).await
}

#[handler]
pub async fn serve_underlay(req: &mut Request, res: &mut Response) {
    let path = req.param::<String>("path").unwrap_or_default();
    serve_from_zip_or_fallback(
        &UNDERLAY_ASSETS,
        &underlay_dir_candidates(),
        &path,
        req,
        res,
    )
    .await
}

/// 服务 loader 前端（根路由 `{*path}`：index.html / data/* / assets/* 等）
#[handler]
pub async fn serve_loader(req: &mut Request, res: &mut Response) {
    let path = req.param::<String>("path").unwrap_or_default();
    serve_from_zip_or_fallback(&LOADER_ASSETS, &loader_dir_candidates(), &path, req, res).await
}

/// 服务 loader 的构建资源（对应 `assets/{*path}`，加 immutable 缓存头）
#[handler]
pub async fn serve_loader_assets(req: &mut Request, res: &mut Response) {
    let path = req.param::<String>("path").unwrap_or_default();
    let asset_path = format!("assets/{}", path);
    serve_from_zip_or_fallback(
        &LOADER_ASSETS,
        &loader_dir_candidates(),
        &asset_path,
        req,
        res,
    )
    .await
}

async fn serve_from_zip_or_fallback(
    assets: &Option<Arc<ZipAssets>>,
    fallback_dirs: &[PathBuf],
    path: &str,
    req: &Request,
    res: &mut Response,
) {
    if path.contains("..") {
        res.status_code(StatusCode::FORBIDDEN);
        return;
    }

    for fallback_path in fallback_dirs {
        if fallback_path.exists() {
            let target = fallback_path.join(path);

            if target.exists() && target.is_file() {
                let builder = salvo::fs::NamedFile::builder(&target);
                if let Ok(named_file) = builder.build().await {
                    named_file.send(req.headers(), res).await;
                    apply_cache_headers(res, path);
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
            apply_cache_headers(res, path);
            res.write_body(content.to_vec()).ok();
            return;
        }
    }

    let has_extension = Path::new(path)
        .extension()
        .map(|e| !e.is_empty())
        .unwrap_or(false);

    if !has_extension {
        for fallback_path in fallback_dirs {
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
                apply_cache_headers(res, "");
                res.write_body(content.to_vec()).ok();
                return;
            }
        }
    }

    res.status_code(StatusCode::NOT_FOUND);
}
