use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "windows")]
use windows::core::w;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, FindWindowW, GetClassNameW, GetClientRect, SetWindowPos,
    ShowWindow, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOW,
};

/// Whether to replace the desktop (default: true)
pub fn replace_mode() -> bool {
    std::env::var("AI00X_REPLACE_DESKTOP")
        .map(|v| v != "false" && v != "0")
        .unwrap_or(true)
}

/// Find the WorkerW that contains SHELLDLL_DefView
///
/// # Safety
///
/// 调用 Win32 `EnumWindows` / `FindWindowExW`，要求调用方在 GUI 线程上调用
/// （Win32 窗口操作不是线程安全的）。
#[cfg(target_os = "windows")]
pub unsafe fn find_workerw_with_defview() -> HWND {
    let mut result = HWND(std::ptr::null_mut());

    extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        unsafe {
            let result_ptr = lparam.0 as *mut HWND;
            if result_ptr.is_null() {
                return windows::core::BOOL(1);
            }

            let defview = FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), None)
                .unwrap_or(HWND(std::ptr::null_mut()));

            if !defview.0.is_null() {
                *result_ptr = hwnd;
                return windows::core::BOOL(0); // stop enumeration
            }

            windows::core::BOOL(1)
        }
    }

    let _ = EnumWindows(Some(enum_cb), LPARAM(&mut result as *mut _ as isize));

    result
}

/// Find the Progman window handle
///
/// # Safety
///
/// 调用 Win32 `FindWindowW`，要求在 GUI 线程上调用。
#[cfg(target_os = "windows")]
pub unsafe fn find_progman_hwnd() -> HWND {
    FindWindowW(w!("Progman"), None).unwrap_or(HWND(std::ptr::null_mut()))
}

/// Hide all SysListView32 desktop icon listviews
///
/// # Safety
///
/// 调用 Win32 `EnumWindows` / `ShowWindow`，要求在 GUI 线程上调用。
#[cfg(target_os = "windows")]
pub unsafe fn hide_all_defviews() {
    extern "system" fn enum_cb(hwnd: HWND, _lparam: LPARAM) -> windows::core::BOOL {
        unsafe {
            let mut class_buf = [0u16; 256];
            let n = GetClassNameW(hwnd, &mut class_buf);
            if n > 0 {
                let name = String::from_utf16_lossy(&class_buf[..n as usize]);
                if name == "WorkerW" || name == "Progman" {
                    let defview = FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), None)
                        .unwrap_or(HWND(std::ptr::null_mut()));
                    if !defview.0.is_null() {
                        let list = FindWindowExW(Some(defview), None, w!("SysListView32"), None)
                            .unwrap_or(HWND(std::ptr::null_mut()));
                        if !list.0.is_null() {
                            let _ = ShowWindow(list, SW_HIDE);
                        }
                    }
                }
            }
            windows::core::BOOL(1)
        }
    }

    let _ = EnumWindows(Some(enum_cb), LPARAM(0));
}

/// Resize a child window to fill its parent's client area
///
/// # Safety
///
/// 调用 Win32 `GetClientRect` / `SetWindowPos`，`child` 与 `parent` 必须是
/// 有效的 HWND，且调用方需在 GUI 线程上调用。
#[cfg(target_os = "windows")]
pub unsafe fn size_to_parent(child: HWND, parent: HWND) {
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let _ = GetClientRect(parent, &mut rc);
    let w = rc.right - rc.left;
    let h = rc.bottom - rc.top;
    let _ = SetWindowPos(
        child,
        None,
        0,
        0,
        w,
        h,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
    );
}

/// Check if the desktop (WorkerW or Progman) is currently the foreground window
#[cfg(target_os = "windows")]
pub fn is_desktop_foreground() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return false;
        }
        let mut buf = [0u16; 256];
        let n = GetClassNameW(fg, &mut buf);
        if n > 0 {
            let name = String::from_utf16_lossy(&buf[..n as usize]);
            return name == "WorkerW" || name == "Progman";
        }
        false
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_desktop_foreground() -> bool {
    false
}

/// Set desktop icons visibility (Windows only)
#[cfg(target_os = "windows")]
pub fn set_desktop_icons_visible(visible: bool) {
    unsafe {
        let progman = find_progman_hwnd();
        if progman.0.is_null() {
            return;
        }

        // Try to find SysListView32 inside SHELLDLL_DefView
        let mut _workerw = HWND(std::ptr::null_mut());
        let mut found = HWND(std::ptr::null_mut());

        extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
            unsafe {
                let found_ptr = lparam.0 as *mut HWND;
                let defview = FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), None)
                    .unwrap_or(HWND(std::ptr::null_mut()));
                if !defview.0.is_null() {
                    let list = FindWindowExW(Some(defview), None, w!("SysListView32"), None)
                        .unwrap_or(HWND(std::ptr::null_mut()));
                    if !list.0.is_null() {
                        *found_ptr = list;
                    }
                }
                windows::core::BOOL(1)
            }
        }

        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut found as *mut _ as isize));

        if found.0.is_null() {
            // Also try Progman directly
            let defview = FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), None)
                .unwrap_or(HWND(std::ptr::null_mut()));
            if !defview.0.is_null() {
                found = FindWindowExW(Some(defview), None, w!("SysListView32"), None)
                    .unwrap_or(HWND(std::ptr::null_mut()));
            }
        }

        if !found.0.is_null() {
            let cmd = if visible { SW_SHOW } else { SW_HIDE };
            let _ = ShowWindow(found, cmd);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_desktop_icons_visible(_visible: bool) {
    // no-op on non-Windows platforms
}

/// Enumerate child windows of a given parent (for debugging)
///
/// # Safety
///
/// 调用 Win32 `EnumChildWindows`，`parent` 必须是有效的 HWND，
/// 且调用方需在 GUI 线程上调用。
#[cfg(target_os = "windows")]
pub unsafe fn enumerate_children(parent: HWND) -> Vec<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

    let mut children: Vec<HWND> = Vec::new();

    extern "system" fn enum_child(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        unsafe {
            let vec_ptr = lparam.0 as *mut Vec<HWND>;
            if !vec_ptr.is_null() {
                (*vec_ptr).push(hwnd);
            }
            windows::core::BOOL(1)
        }
    }

    let _ = EnumChildWindows(
        Some(parent),
        Some(enum_child),
        LPARAM(&mut children as *mut _ as isize),
    );

    children
}

/// Get the class name of a window (for debugging)
#[cfg(target_os = "windows")]
pub fn hwnd_class_name(hwnd: HWND) -> Result<String, String> {
    unsafe {
        let mut buf = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut buf);
        if n > 0 {
            Ok(String::from_utf16_lossy(&buf[..n as usize]))
        } else {
            Err("Failed to get class name".to_string())
        }
    }
}

/// Open overlay and underlay if all services are ready
/// This is a placeholder - the actual readiness check depends on AppState
static OVERLAY_STARTED: AtomicBool = AtomicBool::new(false);

pub fn open_overlay_if_ready<F: FnOnce()>(check_ready: F) {
    if OVERLAY_STARTED.load(Ordering::SeqCst) {
        return;
    }
    // The caller should check readiness conditions before calling this
    OVERLAY_STARTED.store(true, Ordering::SeqCst);
    check_ready();
}
