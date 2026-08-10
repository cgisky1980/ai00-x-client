use device_query::{DeviceQuery, DeviceState};
use enigo::{Enigo, Mouse, Settings};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, serde::Serialize)]
pub struct GlobalClickEvent {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, serde::Serialize)]
pub struct UnderlayMouseEvent {
    pub event_type: String,
    pub x: i32,
    pub y: i32,
    pub buttons: u32,
    pub button: u32,
    pub delta_x: i32,
    pub delta_y: i32,
}

pub struct OverlayState {
    pub no_penetrate_regions: Mutex<Vec<Rect>>,
    pub last_penetrate: Mutex<Option<bool>>,
    pub overlay_thread_running: AtomicBool,
    pub regions_initialized: AtomicBool,
    pub underlay_visible: AtomicBool,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            no_penetrate_regions: Mutex::new(Vec::new()),
            last_penetrate: Mutex::new(None),
            overlay_thread_running: AtomicBool::new(false),
            regions_initialized: AtomicBool::new(false),
            underlay_visible: AtomicBool::new(false),
        }
    }
}

pub fn fit_overlay_to_monitor(window: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size();
        let position = monitor.position();
        let _ = window.set_size(tauri::Size::Physical(*size));
        let _ = window.set_position(tauri::Position::Physical(*position));
    }
}

pub fn spawn_overlay_thread(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<OverlayState>();

    if state.overlay_thread_running.swap(true, Ordering::SeqCst) {
        return;
    }

    let app_handle = app_handle.clone();
    thread::spawn(move || {
        let enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(_) => {
                let state = app_handle.state::<OverlayState>();
                state.overlay_thread_running.store(false, Ordering::SeqCst);
                return;
            }
        };

        let device_state = DeviceState::new();
        let mut last_left_pressed = false;

        loop {
            let state = app_handle.state::<OverlayState>();
            if !state.overlay_thread_running.load(Ordering::SeqCst) {
                break;
            }

            let mouse = device_state.get_mouse();
            let left_pressed = mouse.button_pressed.get(1).copied().unwrap_or(false)
                || mouse.button_pressed.first().copied().unwrap_or(false);
            let (mx, my) = mouse.coords;

            if left_pressed && !last_left_pressed {
                let _ = app_handle.emit("global_click", GlobalClickEvent { x: mx, y: my });
            }
            last_left_pressed = left_pressed;

            let (should_penetrate, last_val) = {
                let state = app_handle.state::<OverlayState>();
                let regions = match state.no_penetrate_regions.try_lock() {
                    Ok(r) => r,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(16));
                        continue;
                    }
                };

                let last_val = match state.last_penetrate.try_lock() {
                    Ok(l) => *l,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(16));
                        continue;
                    }
                };

                if !state.regions_initialized.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(16));
                    continue;
                }

                let should_penetrate = if regions.is_empty() {
                    true
                } else {
                    let win = match app_handle.get_webview_window("overlay") {
                        Some(w) => w,
                        None => {
                            thread::sleep(Duration::from_millis(16));
                            continue;
                        }
                    };

                    let pos = match win.inner_position() {
                        Ok(p) => p,
                        Err(_) => {
                            thread::sleep(Duration::from_millis(16));
                            continue;
                        }
                    };

                    let scale = win.scale_factor().unwrap_or(1.0);

                    match enigo.location() {
                        Ok((mx, my)) => {
                            let window_x = ((mx - pos.x) as f64) / scale;
                            let window_y = ((my - pos.y) as f64) / scale;

                            let mut should_penetrate = true;
                            for r in regions.iter() {
                                if window_x >= r.x
                                    && window_x <= r.x + r.width
                                    && window_y >= r.y
                                    && window_y <= r.y + r.height
                                {
                                    should_penetrate = false;
                                    break;
                                }
                            }
                            should_penetrate
                        }
                        Err(_) => true,
                    }
                };

                (should_penetrate, last_val)
            };

            let needs_update = last_val != Some(should_penetrate);

            if needs_update {
                if let Some(win) = app_handle.get_webview_window("overlay") {
                    let _ = win.set_ignore_cursor_events(should_penetrate);
                }

                // NOTE: Removed set_focus() here. Stealing focus when the cursor
                // enters a no-penetrate region interferes with the gesture system
                // (device_query can lose button state on focus change) and causes
                // click effects to stop working. The overlay window receives mouse
                // events via set_ignore_cursor_events(false) without needing focus.

                let state = app_handle.state::<OverlayState>();
                if let Ok(mut last) = state.last_penetrate.try_lock() {
                    *last = Some(should_penetrate);
                };
            }

            thread::sleep(Duration::from_millis(16));
        }

        let state = app_handle.state::<OverlayState>();
        state.overlay_thread_running.store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
pub fn set_no_penetrate_regions(app: tauri::AppHandle, regions: Vec<Rect>) -> Result<(), String> {
    let state = app.state::<OverlayState>();
    if let Ok(mut r) = state.no_penetrate_regions.try_lock() {
        *r = regions;
    }
    if let Ok(mut last) = state.last_penetrate.try_lock() {
        *last = None;
    }
    state.regions_initialized.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn init_overlay(app: tauri::AppHandle) -> Result<(), String> {
    spawn_overlay_thread(app);
    Ok(())
}
