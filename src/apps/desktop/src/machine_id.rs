//! Machine ID — cross-platform device fingerprint for account-device binding.
//!
//! Generates a stable, unique identifier for the current device by collecting
//! hardware serial numbers and hashing them with SHA-256.
//!
//! Platform implementations:
//! - **Windows**: WMI queries for baseboard serial + CPU processor ID
//! - **macOS**: IOPlatformUUID from IOKit registry
//! - **Linux**: `/etc/machine-id` (systemd standard)

use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};

/// Cached machine ID — computed once per process lifetime.
static MACHINE_ID: Lazy<String> = Lazy::new(compute_machine_id);

/// Returns the machine ID for the current device.
/// The result is a 64-character lowercase hex string (SHA-256).
#[tauri::command]
pub fn get_machine_id() -> String {
    MACHINE_ID.clone()
}

/// Returns a friendly device name (OS + hostname).
#[tauri::command]
pub fn get_device_name() -> String {
    let os = std::env::consts::OS; // "windows", "macos", "linux"
    let hostname = gethostname::gethostname()
        .to_str()
        .unwrap_or("unknown")
        .to_string();
    format!("{}-{}", capitalize_first(os), hostname)
}

fn capitalize_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().chain(c).collect(),
    }
}

fn compute_machine_id() -> String {
    let raw = collect_hardware_ids();
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(target_os = "windows")]
fn collect_hardware_ids() -> String {
    let baseboard = run_powershell(
        r#"Get-WmiObject Win32_BaseBoard | Select-Object -ExpandProperty SerialNumber"#,
    )
    .unwrap_or_default();

    let cpu = run_powershell(
        r#"Get-WmiObject Win32_Processor | Select-Object -ExpandProperty ProcessorId"#,
    )
    .unwrap_or_default();

    format!("windows:{}:{}", baseboard.trim(), cpu.trim())
}

#[cfg(target_os = "macos")]
fn collect_hardware_ids() -> String {
    let uuid = run_command("ioreg", &["-d2", "-c", "IOPlatformExpertDevice"]).unwrap_or_default();

    // Extract IOPlatformUUID from ioreg output
    let platform_uuid = uuid
        .lines()
        .find(|l| l.contains("IOPlatformUUID"))
        .and_then(|l| l.split('"').nth(3))
        .unwrap_or("");

    format!("macos:{}", platform_uuid.trim())
}

#[cfg(target_os = "linux")]
fn collect_hardware_ids() -> String {
    // /etc/machine-id is the standard systemd machine identifier
    let machine_id = std::fs::read_to_string("/etc/machine-id").unwrap_or_default();

    format!("linux:{}", machine_id.trim())
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW = 0x08000000
    // 隐藏 PowerShell 控制台窗口，避免前端调用时弹出终端
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("powershell failed: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_command(cmd: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("{} failed: {}", cmd, e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_machine_id_is_stable() {
        let id1 = compute_machine_id();
        let id2 = compute_machine_id();
        assert_eq!(id1, id2, "machine ID should be stable within a process");
        assert_eq!(id1.len(), 64, "SHA-256 hex should be 64 chars");
    }

    #[test]
    fn test_device_name_format() {
        let name = get_device_name();
        assert!(name.contains('-'), "device name should contain a dash");
        assert!(
            name.starts_with("Windows") || name.starts_with("Macos") || name.starts_with("Linux"),
            "device name should start with OS"
        );
    }
}
