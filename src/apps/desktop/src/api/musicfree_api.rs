//! 在线音源媒体下载 —— musicdl sidecar 搜索结果的音频落盘。
//!
//! musicdl（Python sidecar，见 music_source_manager.rs）搜索返回的音频
//! 直链由本模块下载到 `{songs_dir}/.cache/musicfree/`，交由 Rust
//! AudioMixer 播放（AudioMixer 只接受本地文件路径，symphonia "all"
//! 特性覆盖 mp3/flac/m4a/aac 等常见格式）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

/// 浏览器 UA —— 多数平台 CDN 校验 User-Agent。
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 把字符串请求头表转换为 reqwest HeaderMap（值需合法 UTF-8）。
///
/// `Accept-Encoding` 被丢弃：reqwest 未启用 gzip/brotli 特性，无法解压，
/// 主动声明压缩会拿到乱码 body。
fn build_header_map(
    headers: &HashMap<String, String>,
) -> Result<reqwest::header::HeaderMap, String> {
    let mut map = reqwest::header::HeaderMap::new();
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("accept-encoding") {
            continue;
        }
        let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
            .map_err(|e| format!("invalid header name '{k}': {e}"))?;
        let value = reqwest::header::HeaderValue::from_str(v)
            .map_err(|e| format!("invalid header value for '{k}': {e}"))?;
        map.insert(name, value);
    }
    Ok(map)
}

/// 复用的 reqwest 客户端（连接池 + 跟随重定向）。
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(BROWSER_UA)
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build online media http client")
    })
}

// ----------------------------------------------------------------------------
// 命令 1: musicfree_download_media（媒体下载落盘）
// ----------------------------------------------------------------------------

/// Content-Type → 扩展名（URL 无可辨识扩展名时的兜底）。
fn ext_from_content_type(ct: &str) -> Option<&'static str> {
    let base = ct.split(';').next()?.trim().to_ascii_lowercase();
    match base.as_str() {
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        "audio/flac" | "audio/x-flac" => Some("flac"),
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => Some("m4a"),
        "audio/aac" | "audio/x-aac" => Some("aac"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/ogg" => Some("ogg"),
        _ => None,
    }
}

/// 从 URL 路径段提取音频扩展名（忽略 query/fragment）。
fn ext_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let last = path.rsplit('/').next()?;
    let ext = last.rsplit('.').next()?;
    if ext == last || ext.len() > 5 {
        return None; // 无扩展名
    }
    let ext = ext.to_ascii_lowercase();
    const KNOWN: [&str; 8] = ["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "wma"];
    if KNOWN.contains(&ext.as_str()) {
        Some(ext)
    } else {
        None
    }
}

/// 下载媒体文件并返回绝对路径。
///
/// `persist=false`（默认）：`{songs_dir}/.cache/musicfree/{key}.{ext}`，
///   临时缓存，`musicfree_clear_cache` 会清理。
/// `persist=true`：`{songs_dir}/favorites/{key}.{ext}`，收藏音乐持久
///   落盘（收藏「包括音乐」本身），清缓存不影响。
///
/// **复用**：目标文件已存在且非空时直接返回（重播免下载）。
/// `key` 由前端构造并做安全过滤。
#[tauri::command]
pub async fn musicfree_download_media(
    url: String,
    key: String,
    headers: Option<HashMap<String, String>>,
    persist: Option<bool>,
) -> Result<String, String> {
    // 1. key 白名单过滤（防止路径穿越）
    let safe_key: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe_key.is_empty() {
        return Err("empty cache key".to_string());
    }

    // 2. 目录：临时缓存 or 收藏持久目录
    let pm = ai00_x_core::infrastructure::get_path_manager_arc();
    let cache_dir: PathBuf = if persist.unwrap_or(false) {
        pm.songs_dir().join("favorites")
    } else {
        pm.songs_dir().join(".cache").join("musicfree")
    };
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("failed to create cache dir: {e}"))?;

    // 3. 已有缓存（任意扩展名匹配该 key）则直接复用
    if let Ok(entries) = std::fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{safe_key}."))
                && entry.metadata().map(|m| m.len() > 0).unwrap_or(false)
            {
                return Ok(entry.path().to_string_lossy().to_string());
            }
        }
    }

    // 4. 下载（下载超时放宽到 120s）
    let mut req = http_client()
        .request(reqwest::Method::GET, &url)
        .timeout(Duration::from_secs(120));
    if let Some(headers) = &headers {
        req = req.headers(build_header_map(headers)?);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: http {}", resp.status().as_u16()));
    }

    // 5. 确定扩展名：URL → Content-Type → 默认 mp3
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let ext = ext_from_url(&url)
        .or_else(|| ext_from_content_type(&content_type).map(|s| s.to_string()))
        .unwrap_or_else(|| "mp3".to_string());

    let final_path = cache_dir.join(format!("{safe_key}.{ext}"));
    let tmp_path = cache_dir.join(format!("{safe_key}.{ext}.tmp"));

    // 6. 落盘（先写临时文件再原子重命名）
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("failed to read media body: {e}"))?;
    if bytes.is_empty() {
        return Err("downloaded media is empty".to_string());
    }
    std::fs::write(&tmp_path, &bytes).map_err(|e| format!("failed to write media file: {e}"))?;
    std::fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("failed to finalize media file: {e}"))?;

    Ok(final_path.to_string_lossy().to_string())
}

// ----------------------------------------------------------------------------
// 命令 2: musicfree_clear_cache（清理在线音源缓存）
// ----------------------------------------------------------------------------

/// 清空 `{songs_dir}/.cache/musicfree/` 下所有已下载媒体，返回释放的字节数。
#[tauri::command]
pub async fn musicfree_clear_cache() -> Result<u64, String> {
    let pm = ai00_x_core::infrastructure::get_path_manager_arc();
    let cache_dir = pm.songs_dir().join(".cache").join("musicfree");
    if !cache_dir.exists() {
        return Ok(0);
    }
    let mut freed: u64 = 0;
    let entries = std::fs::read_dir(&cache_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            freed += meta.len();
        }
        let _ = std::fs::remove_file(entry.path());
    }
    Ok(freed)
}
