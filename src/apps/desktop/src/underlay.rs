use tauri::{Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::time::sleep;

use ai00_x_core::service::config::server_endpoints::{LOCAL_EMBEDDED_SERVER_PORT, LOCAL_HOST};

#[cfg(desktop)]
#[cfg(target_os = "windows")]
use windows::core::w;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::POINT;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};

#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};

#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER,
    RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEMOUSE,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    DrawMenuBar, EnumChildWindows, FindWindowExW, FindWindowW, GetAncestor, GetClassNameW, GetMenu,
    GetMenuItemCount, GetSystemMetrics, GetWindowLongW, GetWindowRect, RemoveMenu,
    SendMessageTimeoutW, SetParent, SetWindowLongW, SetWindowPos, SetWindowTextW, ShowWindow,
    GA_PARENT, GWL_EXSTYLE, GWL_STYLE, MENU_ITEM_FLAGS, MF_BYPOSITION, MF_REMOVE,
    SEND_MESSAGE_TIMEOUT_FLAGS, SHOW_WINDOW_CMD, SMTO_NORMAL, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_ERASEBKGND, WM_INPUT, WM_NCCALCSIZE, WM_NCPAINT,
    WS_BORDER, WS_CAPTION, WS_CHILD, WS_CLIPSIBLINGS, WS_DLGFRAME, WS_EX_APPWINDOW,
    WS_EX_CLIENTEDGE, WS_EX_COMPOSITED, WS_EX_DLGMODALFRAME, WS_EX_NOREDIRECTIONBITMAP,
    WS_EX_STATICEDGE, WS_EX_TOOLWINDOW, WS_EX_WINDOWEDGE, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
    WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
};

#[cfg(target_os = "windows")]
extern "system" {
    fn ScreenToClient(hWnd: HWND, lpPoint: *mut POINT) -> i32;
}

// ---------------------------------------------------------------------------
// Monitor enumeration (Windows)
// ---------------------------------------------------------------------------

/// Enumerate all monitors and return their geometry.
///
/// Returns tuples of `(x, y, width, height, is_primary)`.
///
/// # Safety
///
/// 调用 Win32 `EnumDisplayMonitors`，要求在 GUI 线程上调用。
#[cfg(target_os = "windows")]
pub unsafe fn list_monitors() -> Vec<(i32, i32, i32, i32, bool)> {
    extern "system" fn enum_cb(
        hmon: HMONITOR,
        _hdc: HDC,
        _rc_ptr: *mut RECT,
        data: LPARAM,
    ) -> windows::core::BOOL {
        unsafe {
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                rcMonitor: RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
                rcWork: RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
                dwFlags: 0,
            };
            let _ = GetMonitorInfoW(hmon, &mut info);
            let vec_ptr = data.0 as *mut Vec<(i32, i32, i32, i32, bool)>;
            if !vec_ptr.is_null() {
                let primary = info.dwFlags & 0x00000001 != 0;
                (*vec_ptr).push((
                    info.rcMonitor.left,
                    info.rcMonitor.top,
                    info.rcMonitor.right,
                    info.rcMonitor.bottom,
                    primary,
                ));
            }
            windows::core::BOOL(1)
        }
    }
    let mut out: Vec<(i32, i32, i32, i32, bool)> = Vec::new();
    let _ = EnumDisplayMonitors(
        None,
        None,
        Some(enum_cb),
        LPARAM(&mut out as *mut _ as isize),
    );
    out
}

// ---------------------------------------------------------------------------
// Subclass procedure for borderless window
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _u_id_subclass: usize,
    dw_ref_data: usize,
) -> LRESULT {
    match msg {
        WM_NCCALCSIZE => LRESULT(0), // No client area frame
        WM_NCPAINT => LRESULT(0),    // No non-client painting
        WM_ERASEBKGND => LRESULT(1), // Skip background erase
        WM_INPUT => {
            // Handle raw mouse input
            if dw_ref_data != 0 {
                let app_ptr = dw_ref_data as *const tauri::AppHandle;
                let app = &*app_ptr;

                let mut raw = std::mem::MaybeUninit::<RAWINPUT>::uninit();
                let mut size = std::mem::size_of::<RAWINPUT>() as u32;
                let result = GetRawInputData(
                    HRAWINPUT(lparam.0 as *mut _),
                    RID_INPUT,
                    Some(raw.as_mut_ptr() as *mut _),
                    &mut size,
                    std::mem::size_of::<RAWINPUTHEADER>() as u32,
                );

                if result != u32::MAX {
                    let raw = raw.assume_init();
                    if raw.header.dwType == RIM_TYPEMOUSE.0 {
                        let mouse = raw.data.mouse;
                        let mut pt = POINT { x: 0, y: 0 };
                        let _ = GetCursorPos(&mut pt);

                        // Convert screen coords to client coords
                        let _ = ScreenToClient(hwnd, &mut pt);

                        let buttons = unsafe { mouse.Anonymous.Anonymous.usButtonFlags };
                        let event_type = if buttons & 0x0001 != 0 {
                            "mousedown"
                        } else if buttons & 0x0002 != 0 {
                            "mouseup"
                        } else if buttons & 0x0400 != 0 {
                            "wheel"
                        } else {
                            "mousemove"
                        };

                        let button = if buttons & 0x0001 != 0
                            || buttons & 0x0004 != 0
                            || buttons & 0x0010 != 0
                        {
                            0 // left
                        } else if buttons & 0x0002 != 0
                            || buttons & 0x0008 != 0
                            || buttons & 0x0020 != 0
                        {
                            2 // right
                        } else if buttons & 0x0040 != 0 || buttons & 0x0080 != 0 {
                            1 // middle
                        } else {
                            0
                        };

                        let delta_y = if buttons & 0x0400 != 0 {
                            (unsafe { mouse.Anonymous.Anonymous.usButtonData }) as i16 as i32
                        } else {
                            0
                        };

                        let _ = app.emit(
                            "underlay_raw_mouse",
                            serde_json::json!({
                                "type": event_type,
                                "x": pt.x,
                                "y": pt.y,
                                "button": button,
                                "buttons": 0,
                                "deltaY": delta_y,
                            }),
                        );
                    }
                }
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

/// Register raw mouse input device so the underlay window receives WM_INPUT messages
/// even when embedded in the desktop layer.
#[cfg(target_os = "windows")]
unsafe fn register_raw_mouse_input(hwnd: HWND) {
    let devices = [RAWINPUTDEVICE {
        usUsagePage: 0x01, // HID_USAGE_PAGE_GENERIC
        usUsage: 0x02,     // HID_USAGE_GENERIC_MOUSE
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: hwnd,
    }];
    let _ = RegisterRawInputDevices(&devices, std::mem::size_of::<RAWINPUTDEVICE>() as u32);
}

#[cfg(target_os = "windows")]
unsafe fn enforce_borderless_style(hwnd: HWND) {
    let app_handle = APP_HANDLE_PTR.load(Ordering::SeqCst) as usize;
    let _ = SetWindowSubclass(hwnd, Some(subclass_proc), 1, app_handle);

    let style = GetWindowLongW(hwnd, GWL_STYLE);
    let bad_styles = WS_CAPTION.0 as i32
        | WS_THICKFRAME.0 as i32
        | WS_SYSMENU.0 as i32
        | WS_MAXIMIZEBOX.0 as i32
        | WS_MINIMIZEBOX.0 as i32
        | WS_DLGFRAME.0 as i32
        | WS_BORDER.0 as i32;
    let required_styles = WS_CHILD.0 as i32 | WS_VISIBLE.0 as i32 | WS_CLIPSIBLINGS.0 as i32;
    let new_style = (style & !bad_styles) | required_styles;
    let _ = SetWindowLongW(hwnd, GWL_STYLE, new_style);

    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
    let bad_ex_styles = WS_EX_DLGMODALFRAME.0 as i32
        | WS_EX_CLIENTEDGE.0 as i32
        | WS_EX_STATICEDGE.0 as i32
        | WS_EX_APPWINDOW.0 as i32
        | WS_EX_WINDOWEDGE.0 as i32
        | WS_EX_COMPOSITED.0 as i32;
    let required_ex_styles = WS_EX_TOOLWINDOW.0 as i32;
    let new_ex_style = (ex_style & !bad_ex_styles) | required_ex_styles;
    let _ = SetWindowLongW(hwnd, GWL_EXSTYLE, new_ex_style);

    // Remove menu
    let menu = GetMenu(hwnd);
    if !menu.is_invalid() {
        let count = GetMenuItemCount(Some(menu));
        if count > 0 {
            for _ in 0..count {
                let _ = RemoveMenu(menu, 0, MENU_ITEM_FLAGS(MF_BYPOSITION.0 | MF_REMOVE.0));
            }
        }
    }
    let _ = DrawMenuBar(hwnd);
    let _ = SetWindowTextW(hwnd, w!(" "));

    let _ = SetWindowPos(
        hwnd,
        None,
        0,
        0,
        0,
        0,
        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
    );
}

// ---------------------------------------------------------------------------
// Atomic guards
// ---------------------------------------------------------------------------

use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

static OVERLAY_SHOWN: AtomicBool = AtomicBool::new(false);
static UNDERLAY_SHOULD_EXIT: AtomicBool = AtomicBool::new(false);
static UNDERLAY_OFFSCREEN: AtomicBool = AtomicBool::new(false);
static APP_HANDLE_PTR: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

// ---------------------------------------------------------------------------
// Positioning helpers
// ---------------------------------------------------------------------------

/// Get the virtual screen rect that spans all monitors.
#[cfg(target_os = "windows")]
unsafe fn virtual_screen_rect() -> (i32, i32, i32, i32) {
    let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
    let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
    let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    (x, y, w, h)
}

/// Slide the underlay window on-screen (show smart desktop).
/// The window stays embedded in the desktop layer — we just move it into view.
#[cfg(target_os = "windows")]
unsafe fn slide_onscreen(hwnd: HWND, _parent: HWND) {
    let (vx, vy, sw, sh) = virtual_screen_rect();

    enforce_borderless_style(hwnd);

    // Move to virtual screen origin covering all monitors
    let _ = SetWindowPos(
        hwnd,
        None,
        vx,
        vy,
        sw,
        sh,
        SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOZORDER,
    );

    // Also position the webview child
    if let Some(child) = find_webview_child(hwnd) {
        enforce_borderless_style(child);
        let _ = SetWindowPos(
            child,
            None,
            0,
            0,
            sw,
            sh,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }

    let _ = ShowWindow(hwnd, SHOW_WINDOW_CMD(8));
}

/// Slide the underlay window off-screen (hide smart desktop).
/// The window stays embedded — we just move it out of the visible area.
#[cfg(target_os = "windows")]
unsafe fn slide_offscreen(hwnd: HWND, _parent: HWND) {
    let (_, _, sw, sh) = virtual_screen_rect();

    // Move off-screen to the left (keep current Z-order)
    let _ = SetWindowPos(
        hwnd,
        None,
        -sw,
        0,
        sw,
        sh,
        SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOZORDER,
    );

    // Also move the webview child off-screen
    if let Some(child) = find_webview_child(hwnd) {
        let _ = SetWindowPos(
            child,
            None,
            -sw,
            0,
            sw,
            sh,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

// ---------------------------------------------------------------------------
// Cleanup — slide off-screen
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub fn cleanup(app: &tauri::AppHandle) {
    UNDERLAY_SHOULD_EXIT.store(true, Ordering::SeqCst);
    OVERLAY_SHOWN.store(false, Ordering::SeqCst);

    if let Some(win) = app.get_webview_window("underlays") {
        if let Ok(h) = win.hwnd() {
            unsafe {
                let hwnd = HWND(h.0);
                let parent = GetAncestor(hwnd, GA_PARENT);
                if !parent.0.is_null() {
                    slide_offscreen(hwnd, parent);
                } else {
                    let _ = ShowWindow(hwnd, SHOW_WINDOW_CMD(0));
                }
            }
        }
    }

    UNDERLAY_OFFSCREEN.store(true, Ordering::SeqCst);
}

#[cfg(not(target_os = "windows"))]
pub fn cleanup(app: &tauri::AppHandle) {
    UNDERLAY_SHOULD_EXIT.store(true, Ordering::SeqCst);
    OVERLAY_SHOWN.store(false, Ordering::SeqCst);

    if let Some(win) = app.get_webview_window("underlays") {
        #[cfg(target_os = "macos")]
        {
            cleanup_macos(&win);
        }
        #[cfg(target_os = "linux")]
        {
            cleanup_linux(&win);
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = win.hide();
        }
    }

    UNDERLAY_OFFSCREEN.store(true, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// macOS platform implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn embed_and_show_macos(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    if let Ok(ns_view) = window.ns_view() {
        unsafe {
            // tauri returns the NSView as `*mut c_void`; objc2 0.6 msg_send!
            // requires a receiver implementing `Message`, so cast to AnyObject.
            let ns_view = ns_view as *mut AnyObject;
            let ns_window: Retained<NSWindow> = msg_send![&*ns_view, window];

            // Set window level to desktop (below desktop icons)
            // kCGDesktopWindowLevelKey = 4, CGWindowLevelForKey returns the actual level value
            let level: i64 = {
                extern "C" {
                    fn CGWindowLevelForKey(key: i32) -> i32;
                }
                CGWindowLevelForKey(4) as i64 // kCGDesktopWindowLevelKey
            };
            let _: () = msg_send![&*ns_window, setLevel: level];

            // Prevent hiding on Cmd+H or app deactivation
            let _: () = msg_send![&*ns_window, setCanHide: false];
            let _: () = msg_send![&*ns_window, setHidesOnDeactivate: false];

            // Show on all Spaces
            let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary;
            let _: () = msg_send![&*ns_window, setCollectionBehavior: behavior];

            // Cover all screens (union of all NSScreen frames)
            let screen_frame = get_combined_screen_frame_macos();
            let _: () = msg_send![&*ns_window, setFrame: screen_frame, display: true];

            // Order front (show)
            let _: () = msg_send![&*ns_window, orderFrontRegardless];
        }
    }
}

#[cfg(target_os = "macos")]
fn slide_offscreen_macos(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSWindow;

    if let Ok(ns_view) = window.ns_view() {
        unsafe {
            let ns_view = ns_view as *mut AnyObject;
            let ns_window: Retained<NSWindow> = msg_send![&*ns_view, window];
            // Move off-screen to the left
            let screen_frame = get_combined_screen_frame_macos();
            let offscreen_frame = objc2_core_foundation::CGRect {
                origin: objc2_core_foundation::CGPoint {
                    x: screen_frame.size.width * -1.0,
                    y: 0.0,
                },
                size: screen_frame.size,
            };
            let _: () = msg_send![&*ns_window, setFrame: offscreen_frame, display: true];
        }
    }
}

#[cfg(target_os = "macos")]
fn slide_onscreen_macos(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSWindow;

    if let Ok(ns_view) = window.ns_view() {
        unsafe {
            let ns_view = ns_view as *mut AnyObject;
            let ns_window: Retained<NSWindow> = msg_send![&*ns_view, window];
            let screen_frame = get_combined_screen_frame_macos();
            let _: () = msg_send![&*ns_window, setFrame: screen_frame, display: true];
        }
    }
}

#[cfg(target_os = "macos")]
fn cleanup_macos(window: &tauri::WebviewWindow) {
    slide_offscreen_macos(window);
    show_desktop_icons_macos();
}

/// Union of all active display frames.
///
/// Returns `objc2_core_foundation::CGRect` (objc2 0.6 implements `Encode` for
/// it, so it can cross the msg_send! FFI boundary); core-graphics is only used
/// to enumerate the displays, and the two CGRect layouts are identical.
#[cfg(target_os = "macos")]
fn get_combined_screen_frame_macos() -> objc2_core_foundation::CGRect {
    use core_graphics::display::CGDisplay;

    let displays = match CGDisplay::active_displays() {
        Ok(d) => d,
        Err(_) => {
            // Fallback: use main display
            let main = CGDisplay::main();
            let b = main.bounds();
            return objc2_core_foundation::CGRect {
                origin: objc2_core_foundation::CGPoint {
                    x: b.origin.x,
                    y: b.origin.y,
                },
                size: objc2_core_foundation::CGSize {
                    width: b.size.width,
                    height: b.size.height,
                },
            };
        }
    };

    if displays.is_empty() {
        let b = CGDisplay::main().bounds();
        return objc2_core_foundation::CGRect {
            origin: objc2_core_foundation::CGPoint {
                x: b.origin.x,
                y: b.origin.y,
            },
            size: objc2_core_foundation::CGSize {
                width: b.size.width,
                height: b.size.height,
            },
        };
    }

    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;

    for display_id in &displays {
        let display = CGDisplay::new(*display_id);
        let bounds = display.bounds();
        min_x = min_x.min(bounds.origin.x);
        min_y = min_y.min(bounds.origin.y);
        max_x = max_x.max(bounds.origin.x + bounds.size.width);
        max_y = max_y.max(bounds.origin.y + bounds.size.height);
    }

    objc2_core_foundation::CGRect {
        origin: objc2_core_foundation::CGPoint { x: min_x, y: min_y },
        size: objc2_core_foundation::CGSize {
            width: max_x - min_x,
            height: max_y - min_y,
        },
    }
}

#[cfg(target_os = "macos")]
fn hide_desktop_icons_macos() {
    // Hide desktop icons via Finder defaults, then restart Finder to apply.
    let _ = std::process::Command::new("defaults")
        .args([
            "write",
            "com.apple.finder",
            "CreateDesktop",
            "-bool",
            "false",
        ])
        .output();
    let _ = std::process::Command::new("killall")
        .args(["Finder"])
        .output();
}

#[cfg(target_os = "macos")]
fn show_desktop_icons_macos() {
    let _ = std::process::Command::new("defaults")
        .args([
            "write",
            "com.apple.finder",
            "CreateDesktop",
            "-bool",
            "true",
        ])
        .output();
    let _ = std::process::Command::new("killall")
        .args(["Finder"])
        .output();
}

// ---------------------------------------------------------------------------
// Linux platform implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn embed_and_show_linux(window: &tauri::WebviewWindow) {
    // Try to set X11 desktop properties via xprop
    // First, try to find the window ID using xdotool
    if let Ok(output) = std::process::Command::new("xdotool")
        .args(["search", "--name", "underlays"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Ok(xid) = line.trim().parse::<u64>() {
                if set_x11_desktop_properties(xid) {
                    log::info!("Underlay: set X11 desktop properties for window {}", xid);
                    break;
                }
            }
        }
    }

    // Cover all screens
    let _ = window.set_fullscreen(true);
    let _ = window.show();
}

#[cfg(target_os = "linux")]
fn slide_offscreen_linux(window: &tauri::WebviewWindow) {
    // Move off-screen by setting position far left
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: -3840,
        y: 0,
    }));
}

#[cfg(target_os = "linux")]
fn slide_onscreen_linux(window: &tauri::WebviewWindow) {
    // Move back to (0, 0)
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: 0,
        y: 0,
    }));
    let _ = window.show();
}

#[cfg(target_os = "linux")]
fn cleanup_linux(window: &tauri::WebviewWindow) {
    slide_offscreen_linux(window);
}

/// Set EWMH properties for desktop-level window (Linux X11 only)
#[cfg(target_os = "linux")]
fn set_x11_desktop_properties(xid: u64) -> bool {
    // Use xdotool or xprop as a subprocess to set window properties
    // This avoids adding x11rb as a dependency for a simple property set

    // Set _NET_WM_STATE to BELOW + STICKY + SKIP_TASKBAR + SKIP_PAGER
    let states = [
        "_NET_WM_STATE_BELOW",
        "_NET_WM_STATE_STICKY",
        "_NET_WM_STATE_SKIP_TASKBAR",
        "_NET_WM_STATE_SKIP_PAGER",
    ];

    for state in &states {
        let result = std::process::Command::new("xprop")
            .args([
                "-id",
                &xid.to_string(),
                "-f",
                "_NET_WM_STATE",
                "32a",
                "-set",
                "_NET_WM_STATE",
                state,
            ])
            .output();

        if result.is_err() {
            log::warn!("Underlay: failed to set X11 property {} via xprop", state);
            return false;
        }
    }

    // Also set window type to _NET_WM_WINDOW_TYPE_DESKTOP for compatibility
    // Some WMs respect this for keeping window below all others
    let _ = std::process::Command::new("xprop")
        .args([
            "-id",
            &xid.to_string(),
            "-f",
            "_NET_WM_WINDOW_TYPE",
            "32a",
            "-set",
            "_NET_WM_WINDOW_TYPE",
            "_NET_WM_WINDOW_TYPE_DESKTOP",
        ])
        .output();

    true
}

// ---------------------------------------------------------------------------
// Find webview child window
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
unsafe fn find_webview_child(parent: HWND) -> Option<HWND> {
    extern "system" fn enum_child(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        unsafe {
            let vec_ptr = lparam.0 as *mut Vec<HWND>;
            if !vec_ptr.is_null() {
                (*vec_ptr).push(hwnd);
            }
            windows::core::BOOL(1)
        }
    }
    let mut children: Vec<HWND> = Vec::new();
    let _ = EnumChildWindows(
        Some(parent),
        Some(enum_child),
        LPARAM(&mut children as *mut _ as isize),
    );

    for &h in &children {
        let mut buf = [0u16; 256];
        let n = GetClassNameW(h, &mut buf);
        if n > 0 {
            let name = String::from_utf16_lossy(&buf[..n as usize]);
            if name == "Chrome_RenderWidgetHostHWND" {
                return Some(h);
            }
        }
    }

    let prefs = [
        "Chrome_WidgetWin_1",
        "Chrome_WidgetWin_0",
        "WebView",
        "Windows.UI.Core.CoreWindow",
        "Internet Explorer_Server",
    ];
    for &h in &children {
        let mut buf = [0u16; 256];
        let n = GetClassNameW(h, &mut buf);
        if n > 0 {
            let name = String::from_utf16_lossy(&buf[..n as usize]);
            if prefs.iter().any(|p| &name == p) {
                return Some(h);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Desktop handles (Progman / WorkerW / SHELLDLL_DefView)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
unsafe fn desktop_handles() -> (HWND, HWND, HWND, bool) {
    let progman = FindWindowW(w!("Progman"), None).unwrap_or(HWND(std::ptr::null_mut()));
    let mut _res: usize = 0;
    let _ = SendMessageTimeoutW(
        progman,
        0x052C,
        WPARAM(0xD),
        LPARAM(0x1),
        SEND_MESSAGE_TIMEOUT_FLAGS(SMTO_NORMAL.0),
        1000,
        Some(&mut _res),
    );
    let ex = GetWindowLongW(progman, GWL_EXSTYLE);
    let raised = (ex & WS_EX_NOREDIRECTIONBITMAP.0 as i32) != 0;

    extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        unsafe {
            let result_ptr = lparam.0 as *mut (HWND, HWND);
            if result_ptr.is_null() {
                return windows::core::BOOL(1);
            }

            let defview = FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), None)
                .unwrap_or(HWND(std::ptr::null_mut()));

            if !defview.0.is_null() {
                let next_workerw = FindWindowExW(None, Some(hwnd), w!("WorkerW"), None)
                    .unwrap_or(HWND(std::ptr::null_mut()));

                (*result_ptr).0 = defview;
                (*result_ptr).1 = next_workerw;
            }

            windows::core::BOOL(1)
        }
    }

    let mut result = (HWND(std::ptr::null_mut()), HWND(std::ptr::null_mut()));
    let _ = windows::Win32::UI::WindowsAndMessaging::EnumWindows(
        Some(enum_windows_callback),
        LPARAM(&mut result as *mut _ as isize),
    );

    let mut shell_def = result.0;
    let mut workerw_wallpaper = result.1;

    if raised {
        workerw_wallpaper = FindWindowExW(Some(progman), None, w!("WorkerW"), None)
            .unwrap_or(HWND(std::ptr::null_mut()));
        if shell_def.0.is_null() {
            shell_def = FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), None)
                .unwrap_or(HWND(std::ptr::null_mut()));
        }
    }

    (progman, workerw_wallpaper, shell_def, raised)
}

/// Embed the underlay window into the desktop layer and position it on-screen.
/// We embed into the WorkerW that contains SHELLDLL_DefView (same as the original approach),
/// which allows the underlay to receive mouse and keyboard input.
#[cfg(target_os = "windows")]
unsafe fn embed_and_show(hwnd: HWND) {
    let (progman, workerw_wallpaper, shell_def, _raised) = desktop_handles();

    // Embed directly into SHELLDLL_DefView (the icon layer).
    // This makes underlay a sibling of SysListView32. We position
    // underlay ABOVE SysListView32 in Z-order so it covers the icons
    // and receives mouse/keyboard input. SHELLDLL_DefView is in the
    // input routing chain, so its children can receive input.
    let parent = if !shell_def.0.is_null() {
        shell_def
    } else if !workerw_wallpaper.0.is_null() {
        workerw_wallpaper
    } else {
        progman
    };

    if !parent.0.is_null() {
        enforce_borderless_style(hwnd);
        let _ = SetParent(hwnd, Some(parent));

        // Position underlay ABOVE SysListView32 so it covers icons and receives input
        // SetWindowPos(list, hwnd) puts list AFTER hwnd → list is below hwnd → hwnd is on top
        if !shell_def.0.is_null() {
            let list = FindWindowExW(Some(shell_def), None, w!("SysListView32"), None)
                .unwrap_or(HWND(std::ptr::null_mut()));
            if !list.0.is_null() {
                let _ = SetWindowPos(
                    list,
                    Some(hwnd),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }

        // Register raw mouse input so underlay receives WM_INPUT even when embedded
        register_raw_mouse_input(hwnd);

        // Slide on-screen
        slide_onscreen(hwnd, parent);
    }
}

// ---------------------------------------------------------------------------
// ensure() — main entry point
// ---------------------------------------------------------------------------

pub fn ensure(app: &tauri::AppHandle) {
    // Store AppHandle pointer for subclass callback (Windows raw input)
    #[cfg(target_os = "windows")]
    {
        let app_ptr = Box::into_raw(Box::new(app.clone())) as *mut std::ffi::c_void;
        APP_HANDLE_PTR.store(app_ptr, Ordering::SeqCst);
    }

    // If underlay exists but is off-screen, slide it back on-screen
    if UNDERLAY_OFFSCREEN.load(Ordering::SeqCst) {
        if let Some(win) = app.get_webview_window("underlays") {
            #[cfg(target_os = "windows")]
            {
                if let Ok(h) = win.hwnd() {
                    unsafe {
                        let hwnd = HWND(h.0);
                        let parent = GetAncestor(hwnd, GA_PARENT);
                        if !parent.0.is_null() {
                            // Still embedded — just slide back on-screen
                            slide_onscreen(hwnd, parent);
                        } else {
                            // Lost parent — re-embed
                            embed_and_show(hwnd);
                        }
                    }
                }
            }
            #[cfg(target_os = "macos")]
            {
                slide_onscreen_macos(&win);
            }
            #[cfg(target_os = "linux")]
            {
                slide_onscreen_linux(&win);
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
            {
                let _ = win.show();
            }

            UNDERLAY_OFFSCREEN.store(false, Ordering::SeqCst);
            UNDERLAY_SHOULD_EXIT.store(false, Ordering::SeqCst);
            OVERLAY_SHOWN.store(true, Ordering::SeqCst);
            return;
        }
    }

    if OVERLAY_SHOWN.load(Ordering::SeqCst) {
        return;
    }

    // Reset exit flag so the maintenance loop can run after a close/reopen cycle
    UNDERLAY_SHOULD_EXIT.store(false, Ordering::SeqCst);

    // dev 与生产统一走内嵌 salvo（2100），不再依赖 vite dev server
    let base_url = format!("http://{}:{}", LOCAL_HOST, LOCAL_EMBEDDED_SERVER_PORT);
    let underlay_url = format!("{}/underlay/", base_url);

    if let Some(_u) = app.get_webview_window("underlays") {
        OVERLAY_SHOWN.store(true, Ordering::SeqCst);
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            sleep(std::time::Duration::from_millis(50)).await;
            if let Some(u2) = app2.get_webview_window("underlays") {
                // Inject JS event listeners
                let _ = u2.eval("(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<100;i++){try{const api=window.__TAURI__?.event; if(api?.listen){const { listen, emit }=api; await listen('rwkv://debug',(e)=>console.log('[rwkv://debug]',e.payload)); await listen('underlay_debug',(e)=>console.log('[underlay_debug]',e.payload)); await listen('underlay_check_hit',async(e)=>{const {x,y}=e.payload;const els=document.elementsFromPoint(x,y);const el=els.find(e=>getComputedStyle(e).pointerEvents!=='none');const hit=!!el && el.tagName!=='HTML' && el.tagName!=='BODY' && el.id!=='root'; await emit('underlay_hit_status',{hit}); if(hit){ await emit('underlay_click',{x,y}); }}); await listen('underlay_inject_mouse',async(e)=>{const {type,x,y,buttons,button,deltaX,deltaY}=e.payload;const els=document.elementsFromPoint(x,y);const el=els.find(e=>getComputedStyle(e).pointerEvents!=='none');if(el){if(type==='wheel'){const opts={bubbles:true,cancelable:true,deltaX:deltaX||0,deltaY:deltaY||0,clientX:x,clientY:y};el.dispatchEvent(new WheelEvent('wheel',opts));}else{const opts={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,buttons:buttons,button:button};if(type==='click'){el.dispatchEvent(new MouseEvent('click',opts));}else{let ptrType=type;if(type==='mousedown')ptrType='pointerdown';else if(type==='mouseup')ptrType='pointerup';else if(type==='mousemove')ptrType='pointermove';el.dispatchEvent(new PointerEvent(ptrType,{...opts,pointerId:1,pointerType:'mouse',isPrimary:true}));el.dispatchEvent(new MouseEvent(type,opts));}}}}); window.addEventListener('beforeunload',()=>{try{emit('underlay_page_loading');}catch{}}); window.addEventListener('load',()=>{try{emit('underlay_page_loaded');}catch{}}); console.log('underlay debug listener ready'); break;}}catch(e){console.log('underlay debug listener inject attempt failed',e)} await sleep(100);} })();");

                // Show window after delay
                let app_show = app2.clone();
                tauri::async_runtime::spawn(async move {
                    sleep(std::time::Duration::from_millis(300)).await;
                    if let Some(w) = app_show.get_webview_window("underlays") {
                        #[cfg(target_os = "windows")]
                        {
                            if let Ok(h) = w.hwnd() {
                                unsafe {
                                    embed_and_show(HWND(h.0));
                                }
                            }
                        }
                        #[cfg(target_os = "macos")]
                        {
                            embed_and_show_macos(&w);
                        }
                        #[cfg(target_os = "linux")]
                        {
                            embed_and_show_linux(&w);
                        }
                        #[cfg(not(any(
                            target_os = "windows",
                            target_os = "macos",
                            target_os = "linux"
                        )))]
                        {
                            let _ = w.show();
                        }
                    }
                });

                // Event listeners
                let app_click = app2.clone();
                u2.listen("underlay_click", move |_event| {
                    #[cfg(target_os = "windows")]
                    {
                        if let Some(w) = app_click.get_webview_window("underlays") {
                            if let Ok(h) = w.hwnd() {
                                unsafe {
                                    let hwnd = HWND(h.0);
                                    let _ = SetFocus(Some(hwnd));
                                    if let Some(child) = find_webview_child(hwnd) {
                                        let _ = SetFocus(Some(child));
                                    }
                                }
                            }
                        }
                    }
                });

                let app_focus1 = app2.clone();
                u2.listen("tauri://focus", move |_event| {
                    #[cfg(target_os = "windows")]
                    {
                        if let Some(w) = app_focus1.get_webview_window("underlays") {
                            if let Ok(h) = w.hwnd() {
                                unsafe {
                                    enforce_borderless_style(HWND(h.0));
                                    let _ = ShowWindow(HWND(h.0), SHOW_WINDOW_CMD(8));
                                }
                            }
                        }
                    }
                });

                let app3 = app2.clone();
                u2.listen("underlay_page_loading", move |_event| {
                    if let Some(w) = app3.get_webview_window("underlays") {
                        let _ = w.hide();
                    }
                });

                let app4 = app2.clone();
                u2.listen("underlay_page_loaded", move |_event| {
                    if let Some(w) = app4.get_webview_window("underlays") {
                        #[cfg(target_os = "windows")]
                        {
                            if let Ok(h) = w.hwnd() {
                                unsafe {
                                    let hwnd = HWND(h.0);
                                    let parent = GetAncestor(hwnd, GA_PARENT);
                                    if !parent.0.is_null() {
                                        slide_onscreen(hwnd, parent);
                                    } else {
                                        embed_and_show(hwnd);
                                    }
                                }
                            }
                        }
                        #[cfg(target_os = "macos")]
                        {
                            slide_onscreen_macos(&w);
                        }
                        #[cfg(target_os = "linux")]
                        {
                            slide_onscreen_linux(&w);
                        }
                        #[cfg(not(any(
                            target_os = "windows",
                            target_os = "macos",
                            target_os = "linux"
                        )))]
                        {
                            let _ = w.show();
                        }
                    }
                });

                // Windows: embed into desktop layer
                #[cfg(target_os = "windows")]
                {
                    if let Ok(h) = u2.hwnd() {
                        unsafe {
                            let hwnd = HWND(h.0);
                            embed_and_show(hwnd);
                        }
                    }
                }

                let _ = app2.emit("underlay-ready", ());

                // Navigate to underlay URL after delay
                let app3 = app2.clone();
                let nav_url = underlay_url.clone();
                tauri::async_runtime::spawn(async move {
                    sleep(std::time::Duration::from_millis(500)).await;
                    if let Some(win) = app3.get_webview_window("underlays") {
                        let _ = win.eval(format!("try{{if(!location.href.includes('/underlay/')){{location.replace('{}');}}}}catch(e){{console.log('navigate error',e)}}", nav_url).as_str());
                    }
                });

                // Keepalive loop — maintain SetParent + z-order + on-screen position
                // (Windows-only; WebviewWindow::hwnd and HWND don't exist elsewhere)
                #[cfg(target_os = "windows")]
                {
                    let app_keep = app2.clone();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            if UNDERLAY_SHOULD_EXIT.load(Ordering::SeqCst) {
                                break;
                            }
                            sleep(std::time::Duration::from_millis(500)).await;
                            if let Some(wv) = app_keep.get_webview_window("underlays") {
                                if let Ok(hh) = wv.hwnd() {
                                    let uh = HWND(hh.0);
                                    unsafe {
                                        let (progman, ww_sel, shell_def, _raised) =
                                            desktop_handles();

                                        // Embed into SHELLDLL_DefView (icon layer) first,
                                        // fallback to WorkerW then Progman
                                        let target_parent = if !shell_def.0.is_null() {
                                            shell_def
                                        } else if !ww_sel.0.is_null() {
                                            ww_sel
                                        } else {
                                            progman
                                        };

                                        // Re-embed if parent changed
                                        let current_parent = GetAncestor(uh, GA_PARENT);
                                        if current_parent.0 != target_parent.0 {
                                            enforce_borderless_style(uh);
                                            let _ = SetParent(uh, Some(target_parent));
                                        }

                                        // Keep underlay above SysListView32 in Z-order
                                        // SetWindowPos(list, uh) puts list AFTER uh → list below uh
                                        if !shell_def.0.is_null() {
                                            let list = FindWindowExW(
                                                Some(shell_def),
                                                None,
                                                w!("SysListView32"),
                                                None,
                                            )
                                            .unwrap_or(HWND(std::ptr::null_mut()));
                                            if !list.0.is_null() {
                                                let _ = SetWindowPos(
                                                    list,
                                                    Some(uh),
                                                    0,
                                                    0,
                                                    0,
                                                    0,
                                                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                                                );
                                            }
                                        }

                                        // If on-screen, maintain correct position (all monitors)
                                        if !UNDERLAY_OFFSCREEN.load(Ordering::SeqCst) {
                                            let (vx, vy, sw, sh) = virtual_screen_rect();
                                            let mut wr = RECT {
                                                left: 0,
                                                top: 0,
                                                right: 0,
                                                bottom: 0,
                                            };
                                            let _ = GetWindowRect(uh, &mut wr);
                                            // Check if window is roughly in the right position
                                            if wr.left != vx
                                                || wr.top != vy
                                                || (wr.right - wr.left) != sw
                                                || (wr.bottom - wr.top) != sh
                                            {
                                                let _ = SetWindowPos(
                                                    uh,
                                                    None,
                                                    vx,
                                                    vy,
                                                    sw,
                                                    sh,
                                                    SWP_NOACTIVATE
                                                        | SWP_FRAMECHANGED
                                                        | SWP_NOZORDER,
                                                );
                                            }
                                        }

                                        enforce_borderless_style(uh);
                                    }
                                }
                            }
                        }
                    });
                }

                // macOS/Linux: embed and show
                #[cfg(target_os = "macos")]
                {
                    embed_and_show_macos(&u2);
                    hide_desktop_icons_macos();
                }
                #[cfg(target_os = "linux")]
                {
                    embed_and_show_linux(&u2);
                }
                #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
                {
                    let _ = u2.show();
                }
            }
        });
    } else {
        // Create new underlay window
        match WebviewWindowBuilder::new(
            app,
            "underlays",
            WebviewUrl::External(tauri::Url::parse(&underlay_url).unwrap()),
        )
        .decorations(false)
        .transparent(false)
        .shadow(false)
        .fullscreen(false)
        .visible(false)
        .resizable(false)
        .skip_taskbar(true)
        .build()
        {
            Ok(_u) => {
                OVERLAY_SHOWN.store(true, Ordering::SeqCst);
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    sleep(std::time::Duration::from_millis(30)).await;
                    if let Some(u2) = app2.get_webview_window("underlays") {
                        #[cfg(target_os = "windows")]
                        {
                            if let Ok(h) = u2.hwnd() {
                                unsafe {
                                    let hwnd = HWND(h.0);

                                    // Move window off-screen initially to prevent ghost image
                                    let (_, _, sw, sh) = virtual_screen_rect();
                                    let _ = SetWindowPos(
                                        hwnd,
                                        None,
                                        -sw,
                                        0,
                                        sw,
                                        sh,
                                        SWP_NOACTIVATE | SWP_NOZORDER,
                                    );

                                    // Set extended styles
                                    let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
                                    let mut new_style = style | WS_EX_TOOLWINDOW.0 as i32;
                                    new_style &= !(WS_EX_APPWINDOW.0 as i32);
                                    let _ = SetWindowLongW(hwnd, GWL_EXSTYLE, new_style);

                                    // Embed into desktop layer and show
                                    embed_and_show(hwnd);

                                    let _ = app2.emit("underlay-ready", ());
                                }
                            }
                        }

                        #[cfg(target_os = "macos")]
                        {
                            embed_and_show_macos(&u2);
                            hide_desktop_icons_macos();
                        }
                        #[cfg(target_os = "linux")]
                        {
                            embed_and_show_linux(&u2);
                        }
                        #[cfg(not(any(
                            target_os = "windows",
                            target_os = "macos",
                            target_os = "linux"
                        )))]
                        {
                            let _ = u2.show();
                        }
                    }
                });
            }
            Err(e) => {
                let _ = app.emit("rwkv://debug", format!("underlay: rust create error {}", e));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn open_underlay_force(app: tauri::AppHandle) -> Result<(), String> {
    ensure(&app);
    Ok(())
}

#[tauri::command]
pub async fn close_underlay(app: tauri::AppHandle) -> Result<(), String> {
    cleanup(&app);
    if let Some(win) = app.get_webview_window("underlays") {
        let _ = win.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn is_underlay_open(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(app.get_webview_window("underlays").is_some())
}
