//! Extract an application icon from an `.exe` and encode it as a base64 PNG
//! data URL, mirroring Patina's `platform/windows/icon.rs`.
//!
//! Pipeline: `ExtractIconExW` (pull `HICON` from the exe's embedded icon
//! resource) → `GetIconInfo` + `GetDIBits` (rasterise to 32-bit BGRA) →
//! `image` PNG encode → `base64`. Results are cached in-process keyed by
//! lowercased `exe_path`; the icon resource never changes while a process
//! runs, so caching avoids re-extracting on every 5-second poll.
//!
//! The output format is `data:image/png;base64,...` so the frontend can use
//! it directly as an `<img src>`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Cursor;
use std::os::windows::ffi::OsStrExt;
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{ImageBuffer, Rgba};
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, GetDC, GetDIBits, GetObjectA, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS,
};
use windows::Win32::UI::Shell::ExtractIconExW;
use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, HICON};

use super::handles::{MemoryDcGuard, OwnedBitmap, OwnedIcon, ScreenDcGuard};

/// Maximum number of cached icon results (LRU-ish eviction by oldest).
const ICON_CACHE_MAX_ENTRIES: usize = 128;

/// Extract the icon embedded in the executable at `exe_path` and return it as
/// a `data:image/png;base64,...` string. Returns `None` when the exe has no
/// icon resource or any Win32/GDI step fails. Cached per `exe_path`.
pub fn get_icon_base64(exe_path: &str) -> Option<String> {
    let cache_key = exe_path.trim().to_ascii_lowercase();
    if cache_key.is_empty() {
        return None;
    }

    if let Some(cached) = read_cache(&cache_key) {
        return cached;
    }

    let result = get_icon_base64_uncached(exe_path);
    write_cache(cache_key, result.clone());
    result
}

/// Uncached extraction: `ExtractIconExW` → `hicon_to_base64`.
fn get_icon_base64_uncached(exe_path: &str) -> Option<String> {
    let path_wide: Vec<u16> = OsStr::new(exe_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: `ExtractIconExW` reads the icon resource from the file at the
    // given path; the path is a valid null-terminated UTF-16 string. The
    // returned HICONs are owned by us and freed via `OwnedIcon` guards.
    unsafe {
        let mut icon_large = HICON::default();
        let mut icon_small = HICON::default();
        let extracted = ExtractIconExW(
            PCWSTR(path_wide.as_ptr()),
            0,
            Some(&mut icon_large),
            Some(&mut icon_small),
            1,
        );
        // ExtractIconExW returns the number of icons extracted; 0 or
        // u32::MAX (-1 cast) means failure / no icon.
        if extracted == 0 || extracted == u32::MAX {
            return None;
        }

        let icon_large = OwnedIcon::new(icon_large);
        let icon_small = OwnedIcon::new(icon_small);

        // Prefer the large icon (higher resolution); fall back to small.
        let hicon = if let Some(large) = icon_large.as_ref() {
            large.raw()
        } else if let Some(small) = icon_small.as_ref() {
            small.raw()
        } else {
            return None;
        };

        hicon_to_base64(hicon)
    }
}

/// Rasterise an `HICON` to 32-bit BGRA pixels, swap to RGBA, PNG-encode, and
/// base64-wrap. Returns `None` at any failing GDI step.
///
/// SAFETY: the caller must ensure `hicon` is a valid icon handle. All GDI
/// handles acquired here (`GetIconInfo` bitmaps, DCs) are wrapped in RAII
/// guards that release them on drop.
unsafe fn hicon_to_base64(hicon: HICON) -> Option<String> {
    let mut icon_info = std::mem::zeroed();
    if GetIconInfo(hicon, &mut icon_info).is_err() {
        return None;
    }

    // Wrap bitmaps so they are always freed (even on early return).
    let color_bitmap = OwnedBitmap::new(icon_info.hbmColor)?;
    // The mask bitmap may be NULL for 32-bit icons; wrap it best-effort so it
    // is freed if present. Bound to `_mask` (not bare `_`) so Drop runs.
    let _mask_bitmap = OwnedBitmap::new(icon_info.hbmMask);

    // Read bitmap dimensions. `GetObjectA` fills a `BITMAP` struct; the "A"
    // variant is used because `BITMAP` has no string fields (identical to W).
    let mut bm: BITMAP = std::mem::zeroed();
    let got = GetObjectA(
        color_bitmap.raw().into(),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut BITMAP as *mut _),
    );
    if got == 0 {
        return None;
    }

    let width = bm.bmWidth as u32;
    // bmHeight can be negative for top-down DIBs; take absolute value.
    let height = bm.bmHeight.unsigned_abs();
    if width == 0 || height == 0 {
        return None;
    }

    // Acquire a screen DC and a compatible memory DC for GetDIBits.
    let hdc = ScreenDcGuard::new(None, GetDC(None))?;
    let mem_dc = MemoryDcGuard::new(CreateCompatibleDC(Some(hdc.raw())))?;

    // Request 32-bit BGRA pixels, top-down (negative biHeight).
    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..std::mem::zeroed()
        },
        ..std::mem::zeroed()
    };

    let mut pixels: Vec<u8> = vec![0u8; (width as usize) * (height as usize) * 4];
    let lines = GetDIBits(
        mem_dc.raw(),
        color_bitmap.raw(),
        0,
        height,
        Some(pixels.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    if lines == 0 {
        return None;
    }

    // GetDIBits yields BGRA; swap to RGBA for the `image` crate (Rgba<u8>).
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }

    let img = ImageBuffer::<Rgba<u8>, _>::from_raw(width, height, pixels)?;
    let mut png_bytes = Cursor::new(Vec::new());
    img.write_to(&mut png_bytes, image::ImageFormat::Png).ok()?;
    let b64 = STANDARD.encode(png_bytes.into_inner());
    Some(format!("data:image/png;base64,{}", b64))
}

// ── In-process result cache ──────────────────────────────────────────────
//
// The icon resource embedded in an exe never changes while it runs, so a
// single extraction per exe_path is enough. The cache stores both positive
// (Some) and negative (None) results to avoid re-trying exes that have no
// icon. Bounded by ICON_CACHE_MAX_ENTRIES with oldest-entry eviction.

/// One cache entry: a timestamped `Option<String>` result.
struct CacheEntry {
    cached_at_ms: u64,
    value: Option<String>,
}

/// Return the process-local icon cache.
fn icon_cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Read a cached result. Returns `None` when absent (caller will re-extract).
/// Both positive and negative results are kept for the process lifetime —
/// the icon resource embedded in an exe never changes while it runs.
fn read_cache(key: &str) -> Option<Option<String>> {
    let cache = icon_cache().lock().ok()?;
    let entry = cache.get(key)?;
    Some(entry.value.clone())
}

/// Write a result, evicting the oldest entry when at capacity.
fn write_cache(key: String, value: Option<String>) {
    if let Ok(mut cache) = icon_cache().lock() {
        if cache.len() >= ICON_CACHE_MAX_ENTRIES && !cache.contains_key(&key) {
            if let Some(oldest_key) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.cached_at_ms)
                .map(|(k, _)| k.clone())
            {
                cache.remove(&oldest_key);
            }
        }
        cache.insert(
            key,
            CacheEntry {
                cached_at_ms: now_ms(),
                value,
            },
        );
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::get_icon_base64;

    #[test]
    fn empty_path_returns_none() {
        assert!(get_icon_base64("").is_none());
        assert!(get_icon_base64("   ").is_none());
    }

    #[test]
    fn nonexistent_path_returns_none() {
        // A path that does not exist should yield no icon (ExtractIconExW
        // returns 0). Cached as None.
        assert!(get_icon_base64("Z:\\nonexistent\\no-such-app.exe").is_none());
    }
}
