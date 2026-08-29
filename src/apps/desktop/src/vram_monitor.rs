//! Cross-platform GPU VRAM monitor.
//!
//! Detection chain (per platform, first success wins; all failures -> `None`):
//! - Windows: DXGI `IDXGIAdapter3::QueryVideoMemoryInfo` (vendor-agnostic,
//!   covers NVIDIA/AMD/Intel) -> `nvidia-smi` subprocess fallback.
//! - Linux: NVML (NVIDIA, via `nvml-wrapper` dynamic loading) -> sysfs
//!   `/sys/class/drm/card*/device/mem_info_vram_*` (AMD) -> `nvidia-smi`.
//! - macOS: Metal `MTLDevice` (UMA: total = recommendedMaxWorkingSetSize,
//!   used = currentAllocatedSize of this process; best effort).
//!
//! All functions are sync and cheap except the `nvidia-smi` subprocess
//! fallback (spawn a process); callers on async contexts should wrap with
//! `spawn_blocking`.

/// Memory snapshot of one GPU adapter.
#[derive(Debug, Clone, Copy)]
pub struct GpuMemoryInfo {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

/// One enumerated GPU adapter.
#[derive(Debug, Clone)]
pub struct GpuInfo {
    pub index: usize,
    pub name: String,
    pub vendor: String,
    pub memory: Option<GpuMemoryInfo>,
}

/// Map a PCI vendor id to a display name.
fn vendor_name(vendor_id: u32) -> String {
    match vendor_id {
        0x10DE => "NVIDIA".to_string(),
        0x1002 | 0x1022 => "AMD".to_string(),
        0x8086 => "Intel".to_string(),
        0x13B5 => "ARM".to_string(),
        0x5143 => "Qualcomm".to_string(),
        0x106B => "Apple".to_string(),
        _ => format!("0x{vendor_id:04X}"),
    }
}

/// Enumerate all discrete GPU adapters with memory info when available.
pub fn enumerate_gpus() -> Vec<GpuInfo> {
    enumerate_platform()
}

/// Query memory info for the given adapter (or the adapter with most free
/// VRAM when `gpu_hint` is None / out of range). Returns `None` when no
/// backend is available — budget checks should then be skipped gracefully.
pub fn query_vram(gpu_hint: Option<usize>) -> Option<GpuMemoryInfo> {
    let gpus = enumerate_gpus();
    if gpus.is_empty() {
        return None;
    }
    let info = match gpu_hint {
        Some(i) if i < gpus.len() => gpus[i].memory,
        _ => {
            // Prefer the adapter with the largest free memory.
            gpus.iter()
                .filter_map(|g| g.memory)
                .max_by_key(|m| m.free_bytes)
        }
    };
    info
}

// ---------------------------------------------------------------------------
// Windows — DXGI primary, nvidia-smi fallback
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn enumerate_platform() -> Vec<GpuInfo> {
    match enumerate_dxgi() {
        Ok(gpus) if !gpus.is_empty() => gpus,
        ok_or_err => {
            log::info!(
                "[vram_monitor] DXGI unavailable ({:?}), falling back to nvidia-smi",
                ok_or_err.is_err()
            );
            enumerate_nvidia_smi()
        }
    }
}

#[cfg(target_os = "windows")]
fn enumerate_dxgi() -> Result<Vec<GpuInfo>, String> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
        DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
    };

    // SAFETY: CreateDXGIFactory1 has no preconditions; factory is released by RAII.
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.map_err(|e| e.to_string())?;

    let mut gpus = Vec::new();
    let mut i = 0u32;
    loop {
        // SAFETY: i is a valid loop index; out-of-range returns Err and ends the loop.
        let adapter: IDXGIAdapter3 = match unsafe { factory.EnumAdapters1(i) } {
            Ok(a) => match a.cast() {
                Ok(a3) => a3,
                Err(_) => {
                    i += 1;
                    continue;
                }
            },
            Err(_) => break,
        };
        i += 1;

        // SAFETY: GetDesc1 on a live adapter.
        let desc = match unsafe { adapter.GetDesc1() } {
            Ok(d) => d,
            Err(e) => {
                log::info!("[vram_monitor] GetDesc1 failed: {e}");
                continue;
            }
        };
        // Skip software (WARP) adapters.
        if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
            continue;
        }
        if desc.DedicatedVideoMemory == 0 {
            continue;
        }

        let name = String::from_utf16_lossy(
            &desc.Description[..desc.Description.iter().position(|c| *c == 0).unwrap_or(0)],
        );
        let vendor = vendor_name(desc.VendorId);

        let memory = {
            // SAFETY: live interface; out pointer to a local variable.
            let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
            let q = unsafe {
                adapter.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)
            };
            let total = desc.DedicatedVideoMemory as u64;
            q.ok().map(|_| {
                let used = info.CurrentUsage;
                let free = info.Budget.saturating_sub(used).min(total);
                GpuMemoryInfo {
                    used_bytes: used,
                    total_bytes: total,
                    free_bytes: free,
                }
            })
        };

        gpus.push(GpuInfo {
            index: gpus.len(),
            name,
            vendor,
            memory,
        });
    }
    if gpus.is_empty() {
        return Err("no hardware adapters".to_string());
    }
    Ok(gpus)
}

// ---------------------------------------------------------------------------
// Linux — NVML (NVIDIA) -> sysfs (AMD/Intel) -> nvidia-smi
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn enumerate_platform() -> Vec<GpuInfo> {
    if let Some(gpus) = enumerate_nvml() {
        return gpus;
    }
    if let Some(gpus) = enumerate_sysfs() {
        return gpus;
    }
    enumerate_nvidia_smi()
}

#[cfg(target_os = "linux")]
fn enumerate_nvml() -> Option<Vec<GpuInfo>> {
    let nvml = nvml_wrapper::Nvml::init().ok()?;
    let count = nvml.device_count().ok()?;
    let mut gpus = Vec::new();
    for i in 0..count {
        let Ok(device) = nvml.device_by_index(i) else {
            continue;
        };
        let name = device.name().unwrap_or_else(|_| "NVIDIA GPU".to_string());
        let memory = device.memory_info().ok().map(|m| GpuMemoryInfo {
            used_bytes: m.used,
            total_bytes: m.total,
            free_bytes: m.free,
        });
        gpus.push(GpuInfo {
            index: gpus.len(),
            name,
            vendor: "NVIDIA".to_string(),
            memory,
        });
    }
    if gpus.is_empty() {
        None
    } else {
        Some(gpus)
    }
}

#[cfg(target_os = "linux")]
fn enumerate_sysfs() -> Option<Vec<GpuInfo>> {
    // /sys/class/drm/card{N}/device/{vendor,mem_info_vram_used,mem_info_vram_total}
    let mut gpus = Vec::new();
    let entries = std::fs::read_dir("/sys/class/drm").ok()?;
    let mut cards: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("card"))
        .collect();
    cards.sort_by_key(|a| a.file_name());
    for card in cards {
        let dev = card.path().join("device");
        let vendor_raw = std::fs::read_to_string(dev.join("vendor")).ok()?;
        let vendor_id = u32::from_str_radix(vendor_raw.trim().trim_start_matches("0x"), 16).ok()?;
        // Only AMD exposes mem_info_vram_* in sysfs reliably (amdgpu).
        if vendor_id != 0x1002 {
            continue;
        }
        let used = std::fs::read_to_string(dev.join("mem_info_vram_used"))
            .ok()?
            .trim()
            .parse::<u64>()
            .ok()?;
        let total = std::fs::read_to_string(dev.join("mem_info_vram_total"))
            .ok()?
            .trim()
            .parse::<u64>()
            .ok()?;
        let name = std::fs::read_to_string(dev.join("product_name"))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "AMD GPU".to_string());
        gpus.push(GpuInfo {
            index: gpus.len(),
            name,
            vendor: vendor_name(vendor_id),
            memory: Some(GpuMemoryInfo {
                used_bytes: used,
                total_bytes: total,
                free_bytes: total.saturating_sub(used),
            }),
        });
    }
    if gpus.is_empty() {
        None
    } else {
        Some(gpus)
    }
}

// ---------------------------------------------------------------------------
// nvidia-smi subprocess fallback (Windows / Linux)
// ---------------------------------------------------------------------------

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn enumerate_nvidia_smi() -> Vec<GpuInfo> {
    use std::process::Command;

    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=index,name,memory.used,memory.total",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = match cmd.output() {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            log::info!("[vram_monitor] nvidia-smi exit {:?}", o.status.code());
            return Vec::new();
        }
        Err(e) => {
            log::info!("[vram_monitor] nvidia-smi not available: {e}");
            return Vec::new();
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut gpus = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if parts.len() < 3 {
            continue;
        }
        let (Some(used), Some(total)) = (
            parts.get(2).and_then(|s| s.parse::<u64>().ok()),
            parts
                .get(3)
                .or_else(|| parts.get(2))
                .and_then(|s| s.parse::<u64>().ok()),
        ) else {
            continue;
        };
        let total = if parts.len() >= 4 { total } else { 0 };
        if total == 0 {
            continue;
        }
        gpus.push(GpuInfo {
            index: gpus.len(),
            name: parts[1].to_string(),
            vendor: "NVIDIA".to_string(),
            memory: Some(GpuMemoryInfo {
                used_bytes: used * 1024 * 1024,
                total_bytes: total * 1024 * 1024,
                free_bytes: total.saturating_sub(used) * 1024 * 1024,
            }),
        });
    }
    gpus
}

// ---------------------------------------------------------------------------
// macOS — Metal (UMA, best effort)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn enumerate_platform() -> Vec<GpuInfo> {
    use objc2_metal::{MTLCopyAllDevices, MTLDevice};

    // SAFETY: MTLCopyAllDevices has no preconditions on Apple Silicon.
    let devices = unsafe { MTLCopyAllDevices() };
    let mut gpus = Vec::new();
    for (i, device) in devices.iter().enumerate() {
        let dev: &MTLDevice = device;
        let total = unsafe { dev.recommendedMaxWorkingSetSize() };
        let used = unsafe { dev.currentAllocatedSize() };
        if total == 0 {
            continue;
        }
        let name = dev.name().to_string();
        gpus.push(GpuInfo {
            index: gpus.len(),
            name,
            vendor: "Apple".to_string(),
            memory: Some(GpuMemoryInfo {
                used_bytes: used,
                total_bytes: total,
                free_bytes: total.saturating_sub(used),
            }),
        });
        let _ = i;
    }
    if gpus.is_empty() {
        log::info!("[vram_monitor] Metal returned no devices (UMA reporting unavailable)");
    }
    gpus
}

// ---------------------------------------------------------------------------
// Other platforms
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn enumerate_platform() -> Vec<GpuInfo> {
    Vec::new()
}

/// GPU utilization in percent, when the selected backend supports it.
/// Currently only the Linux NVML path provides utilization; DXGI/Metal do
/// not expose it — returns `None` there (frontend shows nothing).
pub fn query_gpu_utilization(gpu_hint: Option<usize>) -> Option<f32> {
    #[cfg(target_os = "linux")]
    {
        let nvml = nvml_wrapper::Nvml::init().ok()?;
        let index = gpu_hint.unwrap_or(0) as i32;
        let device = nvml.device_by_index(index as u32).ok()?;
        Some(device.utilization_rates().ok()?.gpu as f32)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = gpu_hint;
        None
    }
}
