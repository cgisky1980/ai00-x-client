//! 分享下载器 + 解密器（Phase E.2）
//!
//! 下载分享的 `.a00m` 文件（A00M 加密容器）并解密为单个 `audio.flac` 文件。
//! 播放器直接播放解密后的完整 FLAC。
//!
//! # 流程
//!
//! 1. [`ShareClient::get_meta`] 获取元数据
//! 2. 缓存命中检查：若 `{cache_dir}/{share_id}.flac` 已存在则直接返回
//! 3. [`ShareClient::download_to_file`] 下载完整 `.a00m` 文件到 `{cache_dir}/{share_id}.a00m`
//! 4. `spawn_blocking`：
//!    - [`acestep::package_container::decrypt_container`] 用 master password 解密 A00M 容器为 ZIP 字节
//!    - 从 ZIP 中提取 `audio.flac` 条目字节
//!    - 写入 `{cache_dir}/{share_id}.flac`
//! 5. 返回 [`DownloadedShare`]（`audio_path` = `.flac` 路径，`meta` = 元数据）
//!
//! # 密码来源
//!
//! 使用 [`acestep::passwords::current_password`] 编译期内嵌 master password，
//! 与本地归档加密保持一致。**不接受用户输入密码**（所有本地 .a00m 归档都用
//! master password 加密，分享时直接上传原加密文件）。

use std::io::{Cursor, Read};
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use super::{ShareClient, ShareMeta};

/// 下载并解密后的分享
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedShare {
    /// 解密后提取的 audio.flac 路径
    pub audio_path: String,
    /// 解密后提取的歌词文件路径（.lrc，可能为空表示无歌词）
    pub lyrics_path: Option<String>,
    /// 分享元数据（从服务端获取）
    pub meta: ShareMeta,
}

/// 分享下载器
pub struct ShareDownloader {
    client: ShareClient,
    cache_dir: PathBuf,
}

impl ShareDownloader {
    /// 创建新下载器，文件将缓存到 `cache_dir`。
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            client: ShareClient::new(),
            cache_dir,
        }
    }

    /// 使用指定的 `ShareClient` 创建下载器（便于测试注入）。
    pub fn with_client(client: ShareClient, cache_dir: PathBuf) -> Self {
        Self { client, cache_dir }
    }

    /// 下载并解密分享歌曲到临时文件。
    ///
    /// 流程见模块级文档。`share_id` 用于生成缓存文件名（自动 sanitize）。
    ///
    /// # 缓存复用
    ///
    /// 若 `{cache_dir}/{share_id}.flac` 已存在且非空，跳过下载和解密直接返回
    /// （用于重复播放场景）。调用方可通过删除缓存文件强制重新下载。
    ///
    /// # Errors
    ///
    /// - 服务器返回 404/410/401 等 HTTP 错误
    /// - `.a00m` 文件不是有效的 A00M 加密容器
    /// - 解密失败（密码错误或文件损坏）
    /// - ZIP 中找不到 `audio.flac` 条目
    pub async fn download_and_decrypt(&self, share_id: &str) -> Result<DownloadedShare> {
        // 1. 获取元数据
        let meta = self.client.get_meta(share_id).await?;

        // 2. 确保缓存目录存在
        tokio::fs::create_dir_all(&self.cache_dir)
            .await
            .with_context(|| format!("create cache dir: {}", self.cache_dir.display()))?;

        let safe_id = sanitize_share_id(share_id);
        let a00m_path = self.cache_dir.join(format!("{safe_id}.a00m"));
        let flac_path = self.cache_dir.join(format!("{safe_id}.flac"));
        let lrc_path = self.cache_dir.join(format!("{safe_id}.lrc"));

        // 3. 缓存复用：若 flac 已存在且非空，跳过下载（歌词文件与音频一起缓存）。
        //
        //    注意：缓存可能来自「旧归档提取」（当时歌曲还没有歌词），此时 .flac
        //    命中但 .lrc 缺失。若命中缓存的 .a00m 仍存在，则用它对缓存重新解密
        //    一次，把最新歌词补写出来，避免旧缓存导致歌词永远无法显示。只有确实
        //    存在(且非空)的 .lrc 才返回 Some(lrc_path)，不再无条件猜测有歌词。
        let has_flac = match tokio::fs::metadata(&flac_path).await {
            Ok(m) => m.len() > 0,
            Err(_) => false,
        };
        if has_flac {
            let mut lrc_exists = matches!(
                tokio::fs::metadata(&lrc_path).await,
                Ok(m) if m.len() > 0
            );

            // .flac 命中旧缓存但缺少 .lrc → 用缓存中的 .a00m 重新解密补充歌词
            if !lrc_exists && tokio::fs::metadata(&a00m_path).await.is_ok() {
                log::info!(
                    "[share] flac cache hit but lrc missing; re-extracting from cached a00m: share_id={}",
                    share_id
                );
                let a00m_clone = a00m_path.clone();
                let flac_clone = flac_path.clone();
                let lrc_clone = lrc_path.clone();
                if let Ok(Ok((_, lyrics_opt))) = tokio::task::spawn_blocking(move || {
                    decrypt_archive_blocking(&a00m_clone, &flac_clone, &lrc_clone)
                })
                .await
                {
                    log::info!(
                        "[share] re-extract from cached a00m: share_id={}, has_lyrics={}",
                        share_id,
                        lyrics_opt.is_some()
                    );
                    if lyrics_opt.is_none() {
                        let _ = tokio::fs::remove_file(&lrc_path).await;
                    }
                }
                lrc_exists = matches!(
                    tokio::fs::metadata(&lrc_path).await,
                    Ok(m) if m.len() > 0
                );
            }

            log::info!(
                "[share] cache hit: share_id={}, audio={}, lrc={}",
                share_id,
                flac_path.display(),
                if lrc_exists { "yes" } else { "no" }
            );
            let lyrics_path = if lrc_exists {
                Some(lrc_path.to_string_lossy().to_string())
            } else {
                None
            };
            return Ok(DownloadedShare {
                audio_path: flac_path.to_string_lossy().to_string(),
                lyrics_path,
                meta,
            });
        }

        // 4. 下载完整 .a00m 文件（失败时清理可能部分写入的文件，避免下次 cache 复用损坏文件）
        let downloaded_bytes = match self
            .client
            .download_to_file(share_id, &a00m_path)
            .await
            .context("download .a00m file from server")
        {
            Ok(n) => n,
            Err(e) => {
                let _ = tokio::fs::remove_file(&a00m_path).await;
                return Err(e);
            }
        };
        log::info!(
            "[share] downloaded: share_id={}, path={}, size={}B",
            share_id,
            a00m_path.display(),
            downloaded_bytes
        );

        // 5. spawn_blocking：解密 A00M 容器 → ZIP 字节 → 提取 audio.flac (+lyrics.lrc) → 写盘
        //    解密失败时清理 .a00m 文件，避免下次 cache 复用损坏文件 + 浪费 CPU 重复解密
        let a00m_path_clone = a00m_path.clone();
        let flac_path_clone = flac_path.clone();
        let lrc_path_clone = lrc_path.clone();
        let decrypt_result = tokio::task::spawn_blocking(move || {
            decrypt_archive_blocking(&a00m_path_clone, &flac_path_clone, &lrc_path_clone)
        })
        .await;

        let (audio_size_bytes, lyrics_opt) = match decrypt_result {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                let _ = tokio::fs::remove_file(&a00m_path).await;
                return Err(e);
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&a00m_path).await;
                return Err(anyhow::anyhow!("decrypt task panicked: {e}"));
            }
        };

        log::info!(
            "[share] decrypted: share_id={}, audio={}, size={}B",
            share_id,
            flac_path.display(),
            audio_size_bytes
        );

        let lyrics_path = if lyrics_opt.is_some() {
            Some(lrc_path.to_string_lossy().to_string())
        } else {
            // 无歌词时清掉可能的残留缓存文件（若有），避免复用
            let _ = tokio::fs::remove_file(&lrc_path).await;
            None
        };

        Ok(DownloadedShare {
            audio_path: flac_path.to_string_lossy().to_string(),
            lyrics_path,
            meta,
        })
    }

    /// 从本地已存在的 `.a00m` 加密容器解密，提取 audio.flac + lyrics.lrc 到本
    /// share 的缓存目录（复用与 [`download_and_decrypt`] 相同的解密封装逻辑）。
    ///
    /// 用于 P2P 下载完成后的离线解密：P2P 已把完整加密 `.a00m` 下载并留档做种，
    /// 无需重复走 HTTP 下载，直接用本地文件解密提取歌词。
    ///
    /// # 返回
    ///
    /// `(audio_path, lyrics_path)`：音频与歌词文件的绝对路径；无歌词时
    /// `lyrics_path` 为 `None`。
    ///
    /// # Errors
    ///
    /// - `.a00m` 文件不是有效的 A00M 加密容器
    /// - 解密失败（密码错误或文件损坏）
    /// - ZIP 中找不到 `audio.flac` 条目
    pub async fn extract_from_local(
        &self,
        a00m_path: &std::path::Path,
        share_id: &str,
    ) -> Result<(String, Option<String>)> {
        // 确保缓存目录存在
        tokio::fs::create_dir_all(&self.cache_dir)
            .await
            .with_context(|| format!("create cache dir: {}", self.cache_dir.display()))?;

        let safe_id = sanitize_share_id(share_id);
        let flac_path = self.cache_dir.join(format!("{safe_id}.flac"));
        let lrc_path = self.cache_dir.join(format!("{safe_id}.lrc"));

        let a00m_clone = a00m_path.to_path_buf();
        let flac_clone = flac_path.clone();
        let lrc_clone = lrc_path.clone();
        let decrypt_result = tokio::task::spawn_blocking(move || {
            decrypt_archive_blocking(&a00m_clone, &flac_clone, &lrc_clone)
        })
        .await;

        let (size, lyrics_opt) = match decrypt_result {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(e),
            Err(e) => {
                return Err(anyhow::anyhow!("decrypt task panicked: {e}"));
            }
        };
        log::info!(
            "[share] extracted from local a00m: share_id={}, audio={}, size={}B",
            share_id,
            flac_path.display(),
            size
        );

        let lyrics_path = if lyrics_opt.is_some() {
            Some(lrc_path.to_string_lossy().to_string())
        } else {
            let _ = tokio::fs::remove_file(&lrc_path).await;
            None
        };

        Ok((flac_path.to_string_lossy().to_string(), lyrics_path))
    }

    /// 清理指定 share_id 的缓存文件。
    pub async fn clear_cache(&self, share_id: &str) -> Result<()> {
        let safe_id = sanitize_share_id(share_id);
        let a00m_path = self.cache_dir.join(format!("{safe_id}.a00m"));
        let flac_path = self.cache_dir.join(format!("{safe_id}.flac"));
        let lrc_path = self.cache_dir.join(format!("{safe_id}.lrc"));
        let _ = tokio::fs::remove_file(&a00m_path).await;
        let _ = tokio::fs::remove_file(&flac_path).await;
        let _ = tokio::fs::remove_file(&lrc_path).await;
        Ok(())
    }
}

/// 清理 share_id 用于文件名。
///
/// UUID v4 本身只含十六进制 + 连字符，但保守起见替换所有非字母数字字符为 `_`。
fn sanitize_share_id(share_id: &str) -> String {
    share_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 阻塞解密：.a00m 加密容器 → ZIP 字节 → 提取 audio.flac + lyrics.lrc → 写盘。
///
/// 同时供 [`ShareDownloader::download_and_decrypt`]（HTTP 路径）与
/// [`ShareDownloader::extract_from_local`]（P2P 路径）复用，保证两处行为一致。
///
/// # 返回
///
/// `(audio_size_bytes, lyrics_text)`：音频字节数与歌词文本（可空，已过滤空白）。
///
/// # Errors
///
/// - 解密失败（密码错误或文件损坏）
/// - ZIP 中找不到 `audio.flac` 条目
fn decrypt_archive_blocking(
    a00m_path: &std::path::Path,
    flac_path: &std::path::Path,
    lrc_path: &std::path::Path,
) -> Result<(u64, Option<String>)> {
    // 5a. 获取编译期内嵌 master password
    let password = acestep::passwords::current_password();
    let password_str = std::str::from_utf8(password)
        .map_err(|e| anyhow::anyhow!("master password is not valid UTF-8: {e}"))?;

    // 5b. 解密 A00M 容器为 ZIP 字节
    let zip_bytes = acestep::package_container::decrypt_container(a00m_path, password_str)
        .context("decrypt A00M container")?;

    // 5c. 从 ZIP 中提取 audio.flac
    let cursor = Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(cursor).context("read decrypted ZIP archive")?;
    let size = {
        let mut audio_entry = archive
            .by_name("audio.flac")
            .map_err(|e| anyhow::anyhow!("find audio.flac in ZIP: {e}"))?;
        let mut audio_bytes = Vec::new();
        audio_entry
            .read_to_end(&mut audio_bytes)
            .context("read audio.flac from ZIP")?;
        let size = audio_bytes.len() as u64;

        // 5d. 写入 .flac 文件
        std::fs::write(flac_path, &audio_bytes)
            .with_context(|| format!("write audio.flac: {}", flac_path.display()))?;
        size
    };

    // 5e. 提取 lyrics.lrc（可选条目，缺失不报错）
    let lyrics_opt = archive
        .by_name("lyrics.lrc")
        .ok()
        .map(|mut entry| {
            let mut text = String::new();
            entry.read_to_string(&mut text)?;
            Ok::<_, std::io::Error>(text)
        })
        .transpose()?;
    let lyrics = lyrics_opt.filter(|t| !t.trim().is_empty());
    if let Some(lrc_text) = &lyrics {
        if let Err(e) = std::fs::write(lrc_path, lrc_text.as_bytes()) {
            log::warn!("[share] write lyrics.lrc failed: {e}");
        } else {
            log::info!("[share] extracted lyrics");
        }
    }

    Ok((size, lyrics))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_uuid_intact() {
        let uuid = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(sanitize_share_id(uuid), uuid);
    }

    #[test]
    fn sanitize_replaces_special_chars() {
        assert_eq!(sanitize_share_id("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_share_id("a..b"), "a__b");
    }

    #[test]
    fn sanitize_keeps_alphanumeric_and_dash() {
        assert_eq!(sanitize_share_id("ABC123-xyz"), "ABC123-xyz");
    }
}
