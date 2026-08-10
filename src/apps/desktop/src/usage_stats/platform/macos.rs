//! macOS foreground application detector.
//!
//! Uses `osascript` invoking System Events (migrated from
//! `computer_use/desktop_host.rs::macos_foreground_application`) to obtain
//! PID + name + bundle_id, and `sysinfo` to resolve exe path from the PID.
//!
//! The `osascript` invocation is blocking (~10-30ms); the caller
//! (`collector.rs`) wraps `detect_foreground` in `spawn_blocking`.

use std::sync::Mutex;

use sysinfo::{Pid, System};

use super::{ForegroundApp, ForegroundDetector};

/// macOS foreground detector. Holds a `sysinfo` `System` handle refreshed
/// on every call to resolve exe paths.
pub struct MacosDetector {
    sys: Mutex<System>,
}

impl MacosDetector {
    pub fn new() -> Self {
        Self {
            sys: Mutex::new(System::new()),
        }
    }
}

impl Default for MacosDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl ForegroundDetector for MacosDetector {
    fn detect_foreground(&self) -> Option<ForegroundApp> {
        // osascript returns: "<pid>|<name>|<bundle_id>"
        // (matching the format used by `desktop_host.rs::macos_foreground_application`).
        let out = std::process::Command::new("/usr/bin/osascript")
            .args([
                "-e",
                r#"tell application "System Events"
  set p to first process whose frontmost is true
  return (unix id of p as text) & "|" & (name of p) & "|" & (try (bundle identifier of p as text) on error "" end try)
end tell"#,
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }

        let s = String::from_utf8_lossy(&out.stdout);
        let parts: Vec<&str> = s.trim().splitn(3, '|').collect();
        if parts.len() < 2 {
            return None;
        }
        let pid_val: i32 = parts[0].trim().parse().ok()?;
        let name = parts[1].trim().to_string();
        let bundle = parts
            .get(2)
            .map(|x| x.trim())
            .filter(|x| !x.is_empty())
            .map(|x| x.to_string());

        // Resolve exe path via sysinfo (refresh just this PID).
        let exe_path = {
            let mut sys = self.sys.lock().ok()?;
            sys.refresh_processes(
                sysinfo::ProcessesToUpdate::Some(&[Pid::from_u32(pid_val as u32)]),
                true,
            );
            sys.process(Pid::from_u32(pid_val as u32))
                .and_then(|p| p.exe().map(|e| e.to_string_lossy().to_string()))
        };

        Some(ForegroundApp {
            process_name: name,
            window_title: None, // Phase 2: AXUICopyElementText or kAXTitleAttribute.
            process_id: Some(pid_val as u32),
            bundle_id: bundle,
            exe_path,
            idle_secs: None, // Phase 2: CGEventSourceSecondsSinceLastEventType.
        })
    }
}
