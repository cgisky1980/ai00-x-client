//! Underlay API - Desktop item enumeration and desktop icon visibility control

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopItem {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub icon_base64: Option<String>,
}

/// Get desktop items (files and folders on the desktop)
#[tauri::command]
pub fn get_desktop_items() -> Vec<DesktopItem> {
    let mut items = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Some(user_desktop) = get_desktop_dir() {
            collect_items_from_dir(&user_desktop, &mut items);
        }
        if let Some(public_desktop) = get_public_desktop_dir() {
            collect_items_from_dir(&public_desktop, &mut items);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // macOS/Linux: use ~/Desktop
        if let Some(desktop) = dirs::desktop_dir() {
            collect_items_from_dir(&desktop.to_string_lossy(), &mut items);
        }
    }

    items
}

/// Monitor info for multi-monitor support
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub is_primary: bool,
}

/// Get monitor layout information for multi-monitor background support
#[tauri::command]
pub fn get_monitors() -> Vec<MonitorInfo> {
    #[cfg(target_os = "windows")]
    {
        let monitors = unsafe { crate::underlay::list_monitors() };
        monitors
            .into_iter()
            .enumerate()
            .map(|(i, (l, t, r, b, primary))| MonitorInfo {
                id: i as u32,
                x: l,
                y: t,
                width: r - l,
                height: b - t,
                is_primary: primary,
            })
            .collect()
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Fallback: use a single monitor covering the full window
        // TODO: implement platform-specific monitor enumeration
        vec![MonitorInfo {
            id: 0,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            is_primary: true,
        }]
    }
}

/// Set desktop icons visibility (Windows only)
#[tauri::command]
pub fn set_desktop_icons_visible(visible: bool) {
    crate::desktop::set_desktop_icons_visible(visible);
}

// ---------------------------------------------------------------------------
// Platform-specific helpers
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn get_desktop_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .ok()
        .map(|p| format!("{}\\Desktop", p))
}

#[cfg(target_os = "windows")]
fn get_public_desktop_dir() -> Option<String> {
    std::env::var("PUBLIC")
        .ok()
        .map(|p| format!("{}\\Desktop", p))
}

fn collect_items_from_dir(dir_path: &str, items: &mut Vec<DesktopItem>) {
    let path = std::path::Path::new(dir_path);
    if !path.exists() || !path.is_dir() {
        return;
    }

    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip desktop.ini and hidden files
            if name == "desktop.ini" || name.starts_with('.') {
                continue;
            }

            let file_path = entry.path();
            let is_dir = file_path.is_dir();

            items.push(DesktopItem {
                path: file_path.to_string_lossy().to_string(),
                name,
                is_dir,
                icon_base64: None, // TODO: extract icon via IShellItemImageFactory
            });
        }
    }
}
