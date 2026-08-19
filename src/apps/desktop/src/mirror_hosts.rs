//! Shared mirror throughput probing.
//!
//! Extracted from model_checker.rs's `measure_host_speed` so the resource
//! downloader can reuse the same "real ranged download" strategy. Why not
//! HEAD latency: proxies like hf-mirror.com answer HEAD quickly yet redirect
//! large files to unreachable CDNs — only an actual 256 KiB ranged GET that
//! follows the redirect chain exposes the real throughput.
//!
//! Callers keep their own sorted result; this module is stateless.

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct MeasuredSpeed {
    pub host_key: String,
    /// Time to first byte; `u64::MAX` marks the host unreachable.
    pub latency_ms: u64,
    pub throughput_bps: u64,
}

const SPEED_TEST_BYTES: usize = 256 * 1024;
const SPEED_TEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Probe a list of `(host_key, probe_url)` pairs concurrently and return the
/// results sorted by throughput (descending). Unreachable hosts sink to the
/// end, keeping their relative input order.
pub async fn measure_mirror_speeds(probes: Vec<(String, String)>) -> Vec<MeasuredSpeed> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("reqwest client");

    let futures = probes.into_iter().map(|(key, url)| {
        let client = client.clone();
        async move {
            let speed = measure_one(client, &key, &url).await;
            (key, speed)
        }
    });
    let results = futures::future::join_all(futures).await;

    let mut measured: Vec<MeasuredSpeed> = Vec::with_capacity(results.len());
    for (key, speed) in results {
        log::info!(
            "[mirror_hosts] {} -> ttfb={}ms throughput={}KB/s",
            key,
            speed.latency_ms,
            speed.throughput_bps / 1024
        );
        measured.push(MeasuredSpeed {
            host_key: key,
            latency_ms: speed.latency_ms,
            throughput_bps: speed.throughput_bps,
        });
    }

    // Fastest first; unreachable (u64::MAX) hosts keep input order at the end
    // (stable sort).
    measured.sort_by(|a, b| {
        b.throughput_bps
            .cmp(&a.throughput_bps)
            .then(a.latency_ms.cmp(&b.latency_ms))
    });
    measured
}

async fn measure_one(client: reqwest::Client, key: &str, url: &str) -> MeasuredSpeed {
    use futures::StreamExt;

    let unreachable = || MeasuredSpeed {
        host_key: key.to_string(),
        latency_ms: u64::MAX,
        throughput_bps: 0,
    };

    let start = std::time::Instant::now();
    let resp = client
        .get(url)
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", SPEED_TEST_BYTES - 1),
        )
        .timeout(SPEED_TEST_TIMEOUT)
        .send()
        .await;
    let resp = match resp {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            log::warn!("[mirror_hosts] probe {} -> HTTP {}", url, r.status());
            return unreachable();
        }
        Err(e) => {
            log::warn!("[mirror_hosts] probe {} failed: {}", url, e);
            return unreachable();
        }
    };
    let ttfb_ms = start.elapsed().as_millis() as u64;

    let mut stream = resp.bytes_stream();
    let mut read: usize = 0;
    let dl_start = std::time::Instant::now();
    while read < SPEED_TEST_BYTES {
        match tokio::time::timeout(SPEED_TEST_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(c))) => read += c.len(),
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                log::warn!(
                    "[mirror_hosts] probe {} stream error after {}B: {}",
                    url,
                    read,
                    e
                );
                return unreachable();
            }
            Err(_) => {
                log::warn!("[mirror_hosts] probe {} timed out after {}B", url, read);
                return unreachable();
            }
        }
    }
    let dl_ms = dl_start.elapsed().as_millis().max(1) as u64;
    let throughput_bps = read as u64 * 1000 / dl_ms;

    MeasuredSpeed {
        host_key: key.to_string(),
        latency_ms: ttfb_ms,
        throughput_bps,
    }
}
