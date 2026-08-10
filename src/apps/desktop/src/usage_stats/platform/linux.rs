//! Linux foreground application detector (Phase 1 stub).
//!
//! Phase 1 returns `None` (no foreground detection on Linux until Phase 2).
//! Phase 2 will implement X11 active-window query via `x11rb`
//! (`_NET_ACTIVE_WINDOW` property on the root window of the default screen).
//! Wayland has no standard foreground-window API — Phase 2 will degrade to
//! AFK-only + session-level tracking on Wayland sessions.
//!
//! See `参考/add-software-usage-stats.md` for the platform support matrix.

use super::{ForegroundApp, ForegroundDetector};

/// Linux foreground detector (stub).
pub struct LinuxDetector;

impl LinuxDetector {
    pub fn new() -> Self {
        Self
    }
}

impl Default for LinuxDetector {
    fn default() -> Self {
        Self
    }
}

impl ForegroundDetector for LinuxDetector {
    fn detect_foreground(&self) -> Option<ForegroundApp> {
        // Phase 1: no foreground detection on Linux. The collector will fall
        // back to AFK + session-level tracking only. Phase 2 will query X11.
        None
    }
}
