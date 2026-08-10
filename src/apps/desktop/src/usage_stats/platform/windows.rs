//! Windows foreground application detector.
//!
//! Uses `GetForegroundWindow` + `GetWindowThreadProcessId` + `GetWindowTextW`
//! (migrated from `computer_use/desktop_host.rs`) for window/PID/title, and
//! `sysinfo` to resolve process name + exe path from the PID.
//!
//! Friendly application names are resolved from the executable's version
//! resource (`FileDescription` / `ProductName` / `CompanyName`) via
//! `GetFileVersionInfoW` + `VerQueryValueW`, mirroring Patina's
//! `engine/tracking/metadata.rs`. Results are cached per `exe_path` so the
//! version resource is read at most once per executable. Falls back to a
//! cleaned-up form of the raw exe name (e.g. `ai00-x-desktop.exe` →
//! `Ai00-x-desktop`) when the resource is missing.
//!
//! Safety: Win32 calls are `unsafe` and executed on a blocking thread — the
//! caller (`collector.rs`) wraps `detect_foreground` in `spawn_blocking`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::{Mutex, OnceLock};

// Sub-modules: RAII GDI guards and icon extraction (Windows-only).
mod handles;
pub mod icon;

use sysinfo::{Pid, System};
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};

use super::{ForegroundApp, ForegroundDetector};

/// Version-resource string keys tried in order when resolving a friendly
/// display name. `FileDescription` is the most user-friendly (e.g.
/// "AI00-X"); `ProductName` and `CompanyName` are fallbacks.
const VERSION_INFO_NAME_KEYS: [&str; 3] = ["FileDescription", "ProductName", "CompanyName"];

/// Windows foreground detector. Holds a `sysinfo` `System` handle that is
/// refreshed on every call so process info stays current.
pub struct WindowsDetector {
    sys: Mutex<System>,
}

impl WindowsDetector {
    pub fn new() -> Self {
        Self {
            sys: Mutex::new(System::new()),
        }
    }
}

impl Default for WindowsDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl ForegroundDetector for WindowsDetector {
    fn detect_foreground(&self) -> Option<ForegroundApp> {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
        };

        // SAFETY: Win32 UI queries are thread-safe for read-only access to
        // foreground/window state. No window mutations are performed here.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return None;
            }

            // Resolve PID.
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }

            // Read window title (UTF-16, up to 512 chars).
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut buf) as usize;
            let title = if n > 0 {
                let s = String::from_utf16_lossy(&buf[..n.min(512)]);
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            } else {
                None
            };

            // Resolve process name + exe path via sysinfo.
            let (process_name, exe_path) = {
                let mut sys = self.sys.lock().ok()?;
                sys.refresh_processes(
                    sysinfo::ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
                    true,
                );
                let proc_name;
                let exe: Option<String>;
                match sys.process(Pid::from_u32(pid)) {
                    Some(p) => {
                        // Raw exe name (e.g. "ai00-x-desktop.exe") — used as a
                        // fallback identity and as input to display-name resolution.
                        proc_name = p.name().to_string_lossy().to_string();
                        exe = p.exe().map(|p| p.to_string_lossy().to_string());
                    }
                    None => {
                        // Fallback: use window title as name if sysinfo missed it.
                        proc_name = title.clone().unwrap_or_else(|| "unknown".to_string());
                        exe = None;
                    }
                }
                (proc_name, exe)
            };

            // Idle time via GetLastInputInfo (AFK detection).
            let idle_secs = idle_seconds();

            // Resolve a friendly display name from the exe's version resource
            // (FileDescription / ProductName), falling back to a cleaned-up
            // form of the raw exe name. Cached per exe_path.
            let friendly_name = resolve_display_name(&process_name, exe_path.as_deref());

            Some(ForegroundApp {
                process_name: friendly_name,
                window_title: title,
                process_id: Some(pid),
                bundle_id: None, // Not applicable on Windows.
                exe_path,
                idle_secs,
            })
        }
    }
}

// ── Friendly display-name resolution ──────────────────────────────────────
//
// Mirrors Patina's `engine/tracking/metadata.rs`. Reads the Win32 version
// resource (VS_VERSIONINFO) embedded in the .exe, extracts the first non-empty
// value among `FileDescription`, `ProductName`, `CompanyName` across all
// available translations, and returns it. Falls back to a cleaned-up exe name
// (strip `.exe`, split on `_-.`, capitalise first letter) when the resource
// is missing or unreadable. Results are cached per `exe_path`.

/// Return a process-local cache mapping `exe_path` (lowercased) → friendly
/// display name. A process's version resource never changes while it runs,
/// so caching avoids re-reading the exe on every 5-second poll.
fn display_name_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a friendly display name for an executable.
///
/// Tries (in order): cached value → exe version resource `FileDescription` /
/// `ProductName` / `CompanyName` → cleaned-up exe name (`.exe` stripped,
/// separators turned to spaces, first letter capitalised).
///
/// `exe_name` is the raw process name from `sysinfo` (e.g.
/// "ai00-x-desktop.exe"); `exe_path` is the absolute path used both as the
/// cache key and as input to `GetFileVersionInfoW`.
pub fn resolve_display_name(exe_name: &str, exe_path: Option<&str>) -> String {
    // Cache key: prefer the absolute exe path; fall back to the raw exe name.
    let cache_key = exe_path.unwrap_or(exe_name).trim().to_ascii_lowercase();
    if cache_key.is_empty() {
        return fallback_app_name(exe_name);
    }
    if let Some(name) = display_name_cache()
        .lock()
        .ok()
        .and_then(|c| c.get(&cache_key).cloned())
    {
        return name;
    }

    let resolved = exe_path
        .and_then(resolve_process_display_name)
        .map(|raw| raw.trim().trim_end_matches(".exe").trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback_app_name(exe_name));

    if let Ok(mut cache) = display_name_cache().lock() {
        cache.insert(cache_key, resolved.clone());
    }
    resolved
}

/// Read the version resource of the executable at `process_path` and return
/// the first non-empty value among [`FileDescription`, `ProductName`,
/// `CompanyName`] across all translations declared in `VarFileInfo\Translation`.
///
/// Returns `None` when the file has no version resource, the path is empty,
/// or any Win32 call fails (treated as "no friendly name available").
fn resolve_process_display_name(process_path: &str) -> Option<String> {
    if process_path.trim().is_empty() {
        return None;
    }

    let path_wide: Vec<u16> = OsStr::new(process_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut handle: u32 = 0;
    // SAFETY: `GetFileVersionInfoSizeW` is a read-only query on the file's
    // version resource; the path is a valid null-terminated UTF-16 string.
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(path_wide.as_ptr()), Some(&mut handle)) };
    if size == 0 {
        return None;
    }

    let mut version_data = vec![0u8; size as usize];
    // SAFETY: `GetFileVersionInfoW` fills the caller-provided buffer; the
    // buffer length matches the size returned by `GetFileVersionInfoSizeW`.
    unsafe {
        GetFileVersionInfoW(
            PCWSTR(path_wide.as_ptr()),
            None,
            size,
            version_data.as_mut_ptr().cast(),
        )
        .ok()?;
    }

    for (language, code_page) in iter_version_translations(&version_data) {
        for key in VERSION_INFO_NAME_KEYS {
            if let Some(value) = query_version_string(&version_data, language, code_page, key) {
                if !value.trim().is_empty() {
                    return Some(value);
                }
            }
        }
    }

    None
}

/// `(language, code_page)` pair as laid out by the version resource's
/// `VarFileInfo\Translation` block. `#[repr(C)]` is required because the
/// block is reinterpreted from raw bytes returned by `VerQueryValueW`.
#[repr(C)]
#[derive(Clone, Copy)]
struct LangAndCodePage {
    language: u16,
    code_page: u16,
}

/// Enumerate the translations declared in `VarFileInfo\Translation`.
///
/// Falls back to common English (0x0409/0x04B0) and Simplified Chinese
/// (0x0804/0x04B0) pairs when the block is absent — most exes ship at least
/// one of these, so this maximises the chance of finding a `FileDescription`.
fn iter_version_translations(version_data: &[u8]) -> Vec<(u16, u16)> {
    let mut translations = Vec::new();
    let translation_key: Vec<u16> = "\\VarFileInfo\\Translation"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut buffer_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut buffer_len: u32 = 0;

    // SAFETY: `VerQueryValueW` returns a pointer into the version-data buffer
    // (no allocation); the caller must not free it. The translation key is a
    // valid null-terminated UTF-16 string.
    let found_translation = unsafe {
        VerQueryValueW(
            version_data.as_ptr().cast(),
            PCWSTR(translation_key.as_ptr()),
            &mut buffer_ptr,
            &mut buffer_len,
        )
        .as_bool()
    };

    if found_translation
        && !buffer_ptr.is_null()
        && buffer_len >= std::mem::size_of::<LangAndCodePage>() as u32
    {
        let count = buffer_len as usize / std::mem::size_of::<LangAndCodePage>();
        // SAFETY: `buffer_ptr` points to an array of `LangAndCodePage` laid
        // out by the version resource; `count` is derived from the byte length
        // returned by `VerQueryValueW`, so the slice is in-bounds.
        let table =
            unsafe { std::slice::from_raw_parts(buffer_ptr as *const LangAndCodePage, count) };

        for entry in table {
            let pair = (entry.language, entry.code_page);
            if !translations.contains(&pair) {
                translations.push(pair);
            }
        }
    }

    // Append common fallbacks so we still try them even if the Translation
    // block is missing or incomplete.
    for fallback in [(0x0804u16, 0x04B0u16), (0x0409u16, 0x04B0u16)] {
        if !translations.contains(&fallback) {
            translations.push(fallback);
        }
    }

    translations
}

/// Query one string value (`FileDescription` / `ProductName` / ...) for a
/// specific `(language, code_page)` translation from the version resource.
fn query_version_string(
    version_data: &[u8],
    language: u16,
    code_page: u16,
    key: &str,
) -> Option<String> {
    let query_path = format!(
        "\\StringFileInfo\\{:04X}{:04X}\\{}",
        language, code_page, key
    );
    let query_wide: Vec<u16> = query_path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut value_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut value_len: u32 = 0;

    // SAFETY: same as `iter_version_translations` — `VerQueryValueW` returns a
    // pointer into the version-data buffer; the query path is a valid
    // null-terminated UTF-16 string.
    let found = unsafe {
        VerQueryValueW(
            version_data.as_ptr().cast(),
            PCWSTR(query_wide.as_ptr()),
            &mut value_ptr,
            &mut value_len,
        )
        .as_bool()
    };

    if !found || value_ptr.is_null() || value_len == 0 {
        return None;
    }

    // SAFETY: `value_ptr` points to a UTF-16 string of length `value_len`
    // (in wchars, excluding the terminator) within the version-data buffer.
    let raw_slice =
        unsafe { std::slice::from_raw_parts(value_ptr as *const u16, value_len as usize) };
    let value = String::from_utf16_lossy(raw_slice);
    let trimmed = value.trim_matches('\0').trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Build a best-effort friendly name from a raw exe file name when no version
/// resource is available.
///
/// Strips the `.exe` suffix, converts `_`/`-`/`.` separators to spaces, and
/// capitalises the first letter. e.g. `my_app.exe` → "My app",
/// `code.exe` → "Code".
fn fallback_app_name(exe_name: &str) -> String {
    let raw = exe_name
        .trim()
        .trim_matches('"')
        .trim_end_matches(".exe")
        .trim();
    if raw.is_empty() {
        return String::new();
    }

    let mut normalized = String::with_capacity(raw.len());
    let mut prev_separator = false;
    for ch in raw.chars() {
        let is_separator = matches!(ch, '_' | '-' | '.');
        if is_separator {
            if !normalized.is_empty() && !prev_separator {
                normalized.push(' ');
            }
            prev_separator = true;
            continue;
        }
        normalized.push(ch);
        prev_separator = false;
    }

    let normalized = normalized.trim();
    if normalized.is_empty() {
        return String::new();
    }

    let mut chars = normalized.chars();
    match chars.next() {
        Some(first) => {
            let mut result = first.to_uppercase().collect::<String>();
            result.push_str(chars.as_str());
            result
        }
        None => String::new(),
    }
}

/// Return seconds since the last user input (mouse/keyboard), or `None` on
/// failure. Uses `GetLastInputInfo` + `GetTickCount` (Win32 tick-count based,
/// subject to 49.7-day wraparound — acceptable for AFK threshold purposes).
///
/// SAFETY: `GetLastInputInfo` writes into a caller-provided struct;
/// `GetTickCount` is a pure query. Both are thread-safe.
fn idle_seconds() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    unsafe {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut lii).as_bool() {
            let now = GetTickCount();
            // saturating_sub handles tick-count wraparound (rare; happens once
            // every 49.7 days of uptime) by clamping to 0.
            let idle_ms = now.saturating_sub(lii.dwTime);
            Some((idle_ms / 1000) as u64)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fallback_app_name;

    #[test]
    fn fallback_strips_exe_and_capitalises() {
        assert_eq!(fallback_app_name("code.exe"), "Code");
        assert_eq!(fallback_app_name("my_app.exe"), "My app");
        assert_eq!(fallback_app_name("ai00-x-desktop.exe"), "Ai00 x desktop");
    }

    #[test]
    fn fallback_handles_empty() {
        assert_eq!(fallback_app_name(""), "");
        assert_eq!(fallback_app_name(".exe"), "");
    }
}
