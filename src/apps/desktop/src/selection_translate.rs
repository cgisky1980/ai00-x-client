//! Selection translate: global text-selection capture + local RWKV translation.
//!
//! A poll thread (device_query, same pattern as overlay.rs) watches for
//! ① mouse drag-selection (left down → move > threshold → up) and ② the
//! global Alt+T hotkey. On trigger it simulates Ctrl+C via enigo, reads the
//! clipboard text (saving/restoring the user's previous clipboard), and emits
//! `translate-selection-detected` / `translate-hotkey` events with the screen
//! coordinates so the overlay window can show a popup near the cursor.
//! The `translate_text` command runs a single local RWKV inference pass.

use crate::api::app_state::AppState;
use ai00_x_core::infrastructure::ai::AIClientFactory;
use ai00_x_core::util::types::message::Message as AIMessage;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::State;

/// Min mouse displacement (px) to count as a drag-selection.
const DRAG_THRESHOLD_PX: i32 = 6;
/// Poll interval for the monitor thread.
const POLL_INTERVAL_MS: u64 = 30;
/// Cooldown after a capture to avoid repeat triggers.
const CAPTURE_COOLDOWN_MS: u64 = 1000;
/// Max source text length accepted.
const MAX_SOURCE_LEN: usize = 4000;

static TRANSLATE_ENABLED: AtomicBool = AtomicBool::new(false);
static THREAD_STARTED: AtomicBool = AtomicBool::new(false);
static CAPTURING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
pub struct SelectionCaptureEvent {
    pub text: String,
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Deserialize)]
pub struct TranslateTextRequest {
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct TranslateTextResponse {
    pub translated: String,
    #[serde(rename = "fromLang")]
    pub from_lang: String,
    #[serde(rename = "toLang")]
    pub to_lang: String,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// Clipboard text via tauri-plugin-clipboard-manager (sync Rust-side API)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
const WM_COPY: u32 = 0x0301;

/// Focus info of the foreground thread's input queue (subset of Win32
/// GUITHREADINFO; field order must match the native layout).
#[cfg(target_os = "windows")]
#[repr(C)]
struct GuiThreadInfo {
    cb_size: u32,
    flags: u32,
    hwnd_active_offscreen: windows::Win32::Foundation::HWND,
    hwnd_caret: windows::Win32::Foundation::HWND,
    rc_caret: windows::Win32::Foundation::RECT,
    hwnd_menu_owner: windows::Win32::Foundation::HWND,
    hwnd_move_size: windows::Win32::Foundation::HWND,
    hwnd_caret_blink: windows::Win32::Foundation::HWND,
    rc_caret_blink: windows::Win32::Foundation::RECT,
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> windows::Win32::Foundation::HWND;
    fn GetWindowThreadProcessId(hwnd: windows::Win32::Foundation::HWND, pid: *mut u32) -> u32;
    fn GetGUIThreadInfo(id_thread: u32, info: *mut GuiThreadInfo) -> i32;
    fn SendMessageW(
        hwnd: windows::Win32::Foundation::HWND,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize;
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcessId() -> u32;
}

fn clipboard_read_text(app: &tauri::AppHandle) -> Option<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().ok()
}

fn clipboard_write_text(app: &tauri::AppHandle, text: &str) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let _ = app.clipboard().write_text(text);
}

/// True when the foreground window belongs to this process (skip capturing
/// from our own UI to avoid feeding app-internal selections/shortcuts back).
#[cfg(target_os = "windows")]
fn foreground_is_self() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return false;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(fg, &mut pid);
        pid != 0 && pid == GetCurrentProcessId()
    }
}

#[cfg(not(target_os = "windows"))]
fn foreground_is_self() -> bool {
    false
}

// ---------------------------------------------------------------------------
// Selection capture
// ---------------------------------------------------------------------------

fn normalize_captured_text(text: String) -> Option<String> {
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > MAX_SOURCE_LEN {
        return None;
    }
    Some(text)
}

/// Preferred path: read the current selection straight from the focused
/// element via UI Automation TextPattern — no clipboard, no key injection.
#[cfg(target_os = "windows")]
fn capture_via_uia() -> Option<String> {
    let automation = uiautomation::UIAutomation::new().ok()?;
    let focused = automation.get_focused_element().ok()?;
    let text_pattern: uiautomation::patterns::UITextPattern = focused.get_pattern().ok()?;
    let ranges = text_pattern.get_selection().ok()?;
    let range = ranges.into_iter().next()?;
    let text = range.get_text(-1).ok()?;
    normalize_captured_text(text)
}

/// Fallback: post WM_COPY to the focus/caret window (a message, not a
/// simulated keystroke), then read and restore the clipboard. Returns None
/// when the target app ignored WM_COPY (clipboard unchanged) — stale
/// clipboard content must never be reported as the selection.
#[cfg(target_os = "windows")]
fn capture_via_wm_copy(app: &tauri::AppHandle) -> Option<String> {
    let previous = clipboard_read_text(app);

    let target = unsafe {
        let mut info = GuiThreadInfo {
            cb_size: std::mem::size_of::<GuiThreadInfo>() as u32,
            flags: 0,
            hwnd_active_offscreen: windows::Win32::Foundation::HWND::default(),
            hwnd_caret: windows::Win32::Foundation::HWND::default(),
            rc_caret: windows::Win32::Foundation::RECT::default(),
            hwnd_menu_owner: windows::Win32::Foundation::HWND::default(),
            hwnd_move_size: windows::Win32::Foundation::HWND::default(),
            hwnd_caret_blink: windows::Win32::Foundation::HWND::default(),
            rc_caret_blink: windows::Win32::Foundation::RECT::default(),
        };
        if GetGUIThreadInfo(0, &mut info) != 0 && !info.hwnd_caret.0.is_null() {
            info.hwnd_caret
        } else {
            GetForegroundWindow()
        }
    };
    if target.0.is_null() {
        return None;
    }

    unsafe {
        SendMessageW(target, WM_COPY, 0, 0);
    }

    // Give the target app time to update the clipboard.
    thread::sleep(Duration::from_millis(150));

    let text = clipboard_read_text(app);

    // Restore the user's previous clipboard (only when the copy changed it).
    if let Some(prev) = &previous {
        if text.as_deref() == Some(prev.as_str()) {
            // Clipboard unchanged → the app ignored WM_COPY; report failure.
            log::info!("[translate] WM_COPY left clipboard unchanged, no capture");
            return None;
        }
        thread::sleep(Duration::from_millis(50));
        clipboard_write_text(app, prev);
    } else if text.is_none() {
        // No previous clipboard and nothing new → nothing was copied.
        return None;
    }

    text.and_then(normalize_captured_text)
}

/// UIA first (clipboard-free); WM_COPY message + clipboard restore as the
/// fallback for apps without a TextPattern. No key simulation anywhere.
#[cfg(target_os = "windows")]
fn capture_selection_text(app: &tauri::AppHandle) -> Option<String> {
    if let Some(text) = capture_via_uia() {
        log::info!(
            "[translate] captured via UIA ({} chars)",
            text.chars().count()
        );
        return Some(text);
    }
    log::info!("[translate] UIA selection unavailable, falling back to WM_COPY");
    capture_via_wm_copy(app)
}

#[cfg(not(target_os = "windows"))]
fn capture_selection_text(_app: &tauri::AppHandle) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn spawn_monitor_thread(app_handle: tauri::AppHandle) {
    use device_query::{DeviceQuery, DeviceState};

    if THREAD_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    log::info!("[translate] selection monitor thread starting");
    let handle = app_handle.clone();
    thread::spawn(move || {
        let device_state = DeviceState::new();
        let mut drag_start: Option<(i32, i32)> = None;
        let mut cooldown_until = Instant::now();

        loop {
            if !TRANSLATE_ENABLED.load(Ordering::SeqCst) {
                // Idle while disabled; keep the thread parked for re-enable.
                thread::sleep(Duration::from_millis(200));
                continue;
            }

            let mouse = device_state.get_mouse();
            // device_query button_pressed is 1-based: index 0 is a dummy,
            // index 1 is the left button.
            let left_pressed = mouse.button_pressed.get(1).copied().unwrap_or(false);
            let (mx, my) = mouse.coords;

            // Track drag-selection: left down → moved beyond threshold → up.
            // Shows the extensible selection action bar (translate / copy / …).
            if left_pressed {
                if drag_start.is_none() {
                    drag_start = Some((mx, my));
                }
            } else if let Some((sx, sy)) = drag_start.take() {
                let dist = ((mx - sx).abs()).max((my - sy).abs());
                if dist >= DRAG_THRESHOLD_PX && Instant::now() >= cooldown_until {
                    cooldown_until = Instant::now() + Duration::from_millis(CAPTURE_COOLDOWN_MS);
                    if !foreground_is_self() && !CAPTURING.swap(true, Ordering::SeqCst) {
                        // Let the target app finish its selection state first.
                        thread::sleep(Duration::from_millis(120));
                        log::info!("[translate] drag-selection detected, capturing");
                        if let Some(text) = capture_selection_text(&handle) {
                            log::info!(
                                "[translate] captured {} chars, emitting selection event",
                                text.chars().count()
                            );
                            let _ = handle.emit(
                                "translate-selection-detected",
                                SelectionCaptureEvent { text, x: mx, y: my },
                            );
                        }
                        CAPTURING.store(false, Ordering::SeqCst);
                    }
                }
            }

            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn spawn_monitor_thread(_app_handle: tauri::AppHandle) {
    // Selection capture relies on Win32 clipboard/enigo hooks; only enabled on
    // Windows. `translate_text` remains available on all platforms.
}

// ---------------------------------------------------------------------------
// Translation (local RWKV)
// ---------------------------------------------------------------------------

/// 结构化模板用的短标签（`Chinese: xxx` / `English: xxx`）。
fn language_label(lang: &str) -> &'static str {
    match lang {
        "zh" | "zh-CN" | "zh-TW" => "Chinese",
        "en" | "en-US" => "English",
        "ja" | "ja-JP" => "Japanese",
        "ko" | "ko-KR" => "Korean",
        _ => "Chinese",
    }
}

/// 原文主语言与界面语言一致时的兜底目标语言（默认英语；后续可在设置中
/// 开放修改——读配置键替换此常量即可）。
const NATIVE_FALLBACK_TARGET: &str = "en-US";

/// 界面语言代码 → whatlang 语言枚举（"检测语言 == 界面语言"的比较基准）。
fn ui_lang_to_whatlang(ui_lang: &str) -> Option<whatlang::Lang> {
    let l = ui_lang.to_ascii_lowercase();
    if l.starts_with("zh") {
        Some(whatlang::Lang::Cmn)
    } else if l.starts_with("en") {
        Some(whatlang::Lang::Eng)
    } else if l.starts_with("ja") {
        Some(whatlang::Lang::Jpn)
    } else if l.starts_with("ko") {
        Some(whatlang::Lang::Kor)
    } else {
        None
    }
}

/// 翻译目标语言（whatlang 检测主语言）：原文语言 == 界面语言 → 翻成兜底
/// 目标 [`NATIVE_FALLBACK_TARGET`]；否则（含检测失败/不可判定文本）翻成
/// 界面语言。
fn resolve_target_lang(text: &str, ui_lang: &str) -> String {
    let detected = whatlang::detect(text).map(|info| info.lang());
    if detected.is_some() && detected == ui_lang_to_whatlang(ui_lang) {
        NATIVE_FALLBACK_TARGET.to_string()
    } else {
        ui_lang.to_string()
    }
}

/// 源文本的语言标签（whatlang 检测；检测失败按英文兜底）。
fn detect_source_label(text: &str) -> &'static str {
    match whatlang::detect(text).map(|info| info.lang()) {
        Some(whatlang::Lang::Cmn) => "Chinese",
        Some(whatlang::Lang::Jpn) => "Japanese",
        Some(whatlang::Lang::Kor) => "Korean",
        _ => "English",
    }
}

/// 续写模板（2026-09-11 定稿）：提示词即模板本身，不要说明文——
/// `{源标签}: {原文}\n\n{目标标签}: `，模型在目标标签后续写译文，
/// 适配器 stop（"\n\n" 等）写完即停。走 client_factory 官方聊天模板
/// 是为了拿到正确 stop 序列（裸 pool_infer 只会复读）。
fn translation_template(text: &str, src_label: &str, tgt_label: &str) -> String {
    format!("{src_label}: {text}\n\n{tgt_label}: ")
}

/// Run one local RWKV chat pass via the standard AI client factory (same
/// resolution chain as `ai_complete_once`) so the official chat template and
/// stop sequences are applied — a raw `pool_infer` completion just echoes.
async fn infer_once(prompt: String) -> Result<String, String> {
    let factory = AIClientFactory::get_global()
        .map_err(|e| format!("Failed to get AI client factory: {}", e))?;
    let client = factory
        .get_client_resolved("rwkv-local")
        .await
        .map_err(|e| format!("Failed to resolve rwkv-local client: {}", e))?;

    let messages = vec![AIMessage::user(prompt)];

    let call = client.send_message(messages, None);
    let response = tokio::time::timeout(Duration::from_secs(60), call)
        .await
        .map_err(|_| "Translation timed out".to_string())?
        .map_err(|e| format!("Translation failed: {}", e))?;

    Ok(response.text.trim().to_string())
}

/// Translate text with the local RWKV model. Target language follows the
/// configured UI language (`app.language`), falling back to English when the
/// source already looks like the target language.
#[tauri::command]
pub async fn translate_text(
    state: State<'_, AppState>,
    request: TranslateTextRequest,
) -> Result<TranslateTextResponse, String> {
    let text = request.text.trim().to_string();
    if text.is_empty() {
        return Err("Empty text".to_string());
    }
    if text.chars().count() > MAX_SOURCE_LEN {
        return Err(format!("Text too long: max {} chars", MAX_SOURCE_LEN));
    }

    let ui_lang = state
        .config_service
        .get_config::<String>(Some("app.language"))
        .await
        .unwrap_or_else(|_| "zh-CN".to_string());
    let src_label = detect_source_label(&text);
    let target_lang = resolve_target_lang(&text, &ui_lang);
    let prompt = translation_template(&text, src_label, language_label(&target_lang));

    let started = Instant::now();
    let translated = tokio::time::timeout(Duration::from_secs(60), infer_once(prompt))
        .await
        .map_err(|_| "Translation timed out".to_string())??;

    if translated.is_empty() {
        return Err("Translation returned empty text".to_string());
    }

    Ok(TranslateTextResponse {
        translated,
        from_lang: "auto".to_string(),
        to_lang: target_lang,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Enable/disable the selection monitor (and spawn its thread on first use).
#[tauri::command]
pub fn translate_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    TRANSLATE_ENABLED.store(enabled, Ordering::SeqCst);
    log::info!("[translate] set_enabled({})", enabled);
    if enabled {
        spawn_monitor_thread(app);
    }
    Ok(())
}

/// Default-on at app startup so the feature works without any frontend
/// handshake; the frontend can still toggle it later.
pub fn init_selection_translate(app: tauri::AppHandle) {
    TRANSLATE_ENABLED.store(true, Ordering::SeqCst);
    spawn_monitor_thread(app);
}

/// Query whether the selection monitor is enabled.
#[tauri::command]
pub fn translate_get_enabled() -> Result<bool, String> {
    Ok(TRANSLATE_ENABLED.load(Ordering::SeqCst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_target_swaps_only_when_same_language() {
        // 界面中文 + 中文原文（whatlang 判 Cmn）→ 兜底翻英语
        assert_eq!(
            resolve_target_lang("你好世界，这是一段用来检测语言的中文文本。", "zh-CN"),
            "en-US"
        );
        // 界面中文 + 英文原文 → 翻中文
        assert_eq!(
            resolve_target_lang("hello world, this is a sentence for detection", "zh-CN"),
            "zh-CN"
        );
        // 界面英语 + 英文原文 → 兜底（仍是英语，语义上=同语种）
        assert_eq!(resolve_target_lang("hello world", "en-US"), "en-US");
        // 不可判定文本（纯数字）→ 退化翻界面语言
        assert_eq!(resolve_target_lang("12345 67890", "zh-CN"), "zh-CN");
    }

    #[test]
    fn template_is_pure_continuation_pattern() {
        // 英→中：源标签在前，目标标签收尾供续写，冒号后带空格
        assert_eq!(
            translation_template("hello world", "English", "Chinese"),
            "English: hello world\n\nChinese: "
        );
        // 中→英
        assert_eq!(
            translation_template("你好世界", "Chinese", "English"),
            "Chinese: 你好世界\n\nEnglish: "
        );
    }

    #[test]
    fn detect_source_label_maps_whatlang() {
        assert_eq!(
            detect_source_label("hello world, this is a sentence"),
            "English"
        );
        assert_eq!(
            detect_source_label("你好世界，这是一段中文文本。"),
            "Chinese"
        );
    }
}
