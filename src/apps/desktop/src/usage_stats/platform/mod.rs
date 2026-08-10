//! Cross-platform foreground application detection abstraction.
//!
//! Each platform module implements [`ForegroundDetector`] and exposes a
//! concrete detector struct. [`default_detector`] returns the appropriate
//! implementation for the current target OS.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Detected foreground application.
///
/// `exe_path` is the canonical unique identity (absolute path to the
/// executable). `process_name` is display-only and may collide across
/// different install paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForegroundApp {
    /// Process executable name (e.g. `chrome.exe` on Windows, `Chrome` on macOS).
    pub process_name: String,
    /// Window title. May be `None` when the foreground window has no title
    /// or when the user disabled title capture for this app (Phase 3).
    pub window_title: Option<String>,
    /// OS process ID.
    pub process_id: Option<u32>,
    /// macOS bundle identifier (e.g. `com.google.Chrome`). `None` on non-macOS.
    pub bundle_id: Option<String>,
    /// Absolute path to the executable. Used as the unique identity across
    /// same-named processes on different install paths.
    pub exe_path: Option<String>,
    /// Seconds since the last user input (mouse/keyboard). Used by the
    /// collector to mark segments as AFK when above the AFK threshold.
    /// `None` when idle detection is unavailable on this platform.
    pub idle_secs: Option<u64>,
}

/// Platform-agnostic foreground detector.
///
/// Implementations must be cheap to construct and stateless (or hold only
/// cached resources like the `sysinfo` `System` handle).
pub trait ForegroundDetector: Send + Sync {
    /// Return the currently focused foreground application, or `None` if no
    /// foreground window is available (locked screen, headless session, etc.).
    fn detect_foreground(&self) -> Option<ForegroundApp>;
}

// ── Platform module declarations ─────────────────────────────────────────

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "linux")]
pub mod linux;

// ── Default detector factory ─────────────────────────────────────────────

/// Construct the platform-default foreground detector.
///
/// Returns `Arc<dyn ForegroundDetector>` so the collector can share the
/// detector across `spawn_blocking` calls without `unsafe` conversions.
#[cfg(target_os = "windows")]
pub fn default_detector() -> Arc<dyn ForegroundDetector> {
    Arc::new(windows::WindowsDetector::new())
}

/// Construct the platform-default foreground detector.
#[cfg(target_os = "macos")]
pub fn default_detector() -> Arc<dyn ForegroundDetector> {
    Arc::new(macos::MacosDetector::new())
}

/// Construct the platform-default foreground detector.
#[cfg(target_os = "linux")]
pub fn default_detector() -> Arc<dyn ForegroundDetector> {
    Arc::new(linux::LinuxDetector::new())
}

/// Construct the platform-default foreground detector.
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn default_detector() -> Arc<dyn ForegroundDetector> {
    Arc::new(UnsupportedDetector)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
struct UnsupportedDetector;

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
impl ForegroundDetector for UnsupportedDetector {
    fn detect_foreground(&self) -> Option<ForegroundApp> {
        None
    }
}
