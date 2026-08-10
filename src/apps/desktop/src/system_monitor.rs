//! System monitor: periodically collects CPU, memory, network stats and emits
//! "system-stats" event to the frontend.

use serde::Serialize;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, Networks, RefreshKind, System};
use tauri::{AppHandle, Emitter};
use tokio::time::{interval, Duration};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_usage: f32,
    pub mem_usage: u64,
    pub mem_total: u64,
    pub gpu_usage: Option<f32>,
    pub gpu_mem_usage: Option<u64>,
    pub gpu_mem_total: Option<u64>,
    pub net_up: u64,
    pub net_down: u64,
}

struct NetSnapshot {
    total_received: u64,
    total_transmitted: u64,
}

fn snapshot_networks(networks: &Networks) -> NetSnapshot {
    let mut total_received = 0u64;
    let mut total_transmitted = 0u64;
    for (_, net) in networks.iter() {
        total_received += net.received();
        total_transmitted += net.transmitted();
    }
    NetSnapshot {
        total_received,
        total_transmitted,
    }
}

pub fn spawn_system_monitor(app: AppHandle) {
    tokio::spawn(async move {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::nothing().with_ram()),
        );
        let mut networks = Networks::new_with_refreshed_list();

        // Initial wait + first refresh so CPU usage has a baseline.
        tokio::time::sleep(Duration::from_millis(500)).await;
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        networks.refresh(true);

        let mut prev_net = snapshot_networks(&networks);
        let mut tick = interval(Duration::from_secs(2));
        tick.tick().await; // consume first immediate tick

        loop {
            tick.tick().await;

            sys.refresh_cpu_usage();
            sys.refresh_memory();
            networks.refresh(false);

            let cpu_usage = sys.global_cpu_usage();
            let mem_usage = sys.used_memory();
            let mem_total = sys.total_memory();

            let cur_net = snapshot_networks(&networks);
            // bytes per second over the ~2s interval
            let elapsed_secs = 2f64;
            let net_down = ((cur_net
                .total_received
                .saturating_sub(prev_net.total_received)) as f64
                / elapsed_secs) as u64;
            let net_up = ((cur_net
                .total_transmitted
                .saturating_sub(prev_net.total_transmitted)) as f64
                / elapsed_secs) as u64;
            prev_net = cur_net;

            let stats = SystemStats {
                cpu_usage,
                mem_usage,
                mem_total,
                gpu_usage: None,
                gpu_mem_usage: None,
                gpu_mem_total: None,
                net_up,
                net_down,
            };

            if let Err(e) = app.emit("system-stats", &stats) {
                log::warn!("Failed to emit system-stats: {}", e);
            }
        }
    });
}
