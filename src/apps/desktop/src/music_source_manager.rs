//! MusicSourceManager — musicdl 在线音源 sidecar 的安装与生命周期管理。
//!
//! 架构（对齐 DshManager 成熟范式，见 参考/dsh-Agent场景与自动安装实施-20260825.md）：
//!
//! 自动安装链（幂等，首次使用在线音源时触发）：
//! 1. uv（PATH 探测；ai00-run PyManager 同款底层，但用 tokio Command
//!    避免 std::process 弹终端窗）
//! 2. venv：`uv venv {data}/music-source/venv --python 3.11`
//! 3. 依赖：`uv pip install --python <venv> musicdl`
//! 4. sidecar 脚本：include_str! 内嵌 server.py，每次启动覆盖落盘
//!    （保证升级客户端即升级脚本）
//!
//! sidecar：`<venv>/python server.py --port 0`，监听 127.0.0.1 随机端口；
//! 启动完成向 stdout 打印 `{"event":"ready","port":N}`，Rust 解析实际端口。
//! 崩溃退避自动重启；退出随主进程（专属 kill-on-close Job Object）。
//!
//! 上游引擎：https://github.com/CharlesPikachu/musicdl（多源容灾 +
//! AudioLinkTester 假音频剔除 + LRC 歌词）。

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Child;

use ai00_x_core::util::process_manager;

/// 钉死的 musicdl 版本（升级走此指纹：变更触发重装）。
const MUSICDL_SPEC: &str = "musicdl==2.13.6";
/// venv Python 版本。
const PY_VERSION: &str = "3.11";
/// 搜索超时（sidecar 内部 15s 截止 + 够用即返回，实测 6-8s；留余量）。
const SEARCH_TIMEOUT_SECS: u64 = 40;
/// 安装超时（musicdl 依赖 ~100MB，首次下载需要时间）。
const INSTALL_TIMEOUT_SECS: u64 = 600;
/// healthz 就绪探测超时。
const READY_TIMEOUT_SECS: u64 = 30;

/// 安装/运行阶段（推给前端 `music-source://phase` 事件）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum MusicSourcePhase {
    /// 尚未初始化。
    NotReady,
    /// 安装中（stage 描述当前步骤）。
    Installing { stage: String },
    /// 环境就绪，sidecar 未运行。
    Ready,
    /// sidecar 运行中。
    Running { port: u16 },
    /// 安装或运行失败。
    Failed { error: String },
}

// clippy(derivable_impls) 豁免：与 DshManager 保持一致，手写 impl 与枚举注释分离。
#[allow(clippy::derivable_impls)]
impl Default for MusicSourcePhase {
    fn default() -> Self {
        Self::NotReady
    }
}

pub struct MusicSourceManager {
    phase: std::sync::Mutex<MusicSourcePhase>,
    child: tokio::sync::Mutex<Option<Child>>,
    /// 用户主动停止标记（停止时不自动重启）。
    stopped_by_user: std::sync::atomic::AtomicBool,
    /// sidecar 专属 Job（kill-on-close）：主进程被强杀时内核回收 Job
    /// 句柄连带终止 python，防止残留 sidecar 占端口。
    #[cfg(windows)]
    sidecar_job: std::sync::Mutex<Option<win32job::Job>>,
    /// 并发安装/启动互斥（ensure_ready 只跑一份）。
    ensure_lock: tokio::sync::Mutex<()>,
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/// sidecar 根目录：app data 下的 music-source/（venv + server.py + marker）。
fn music_source_home() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Ai00-X")
        .join("music-source")
}

fn venv_dir() -> PathBuf {
    music_source_home().join("venv")
}

fn venv_python() -> PathBuf {
    if cfg!(windows) {
        venv_dir().join("Scripts").join("python.exe")
    } else {
        venv_dir().join("bin").join("python3")
    }
}

fn server_script() -> PathBuf {
    music_source_home().join("server.py")
}

fn install_marker() -> PathBuf {
    music_source_home().join("install-marker.json")
}

#[derive(Serialize, Deserialize)]
struct InstallMarker {
    /// 已安装的依赖指纹（MUSICDL_SPEC）。
    deps: String,
}

/// 环境是否已装好（marker 匹配 + venv python 存在）。
fn environment_ready() -> bool {
    if !venv_python().exists() {
        return false;
    }
    match std::fs::read_to_string(install_marker()) {
        Ok(text) => match serde_json::from_str::<InstallMarker>(&text) {
            Ok(marker) => marker.deps == MUSICDL_SPEC,
            Err(_) => false,
        },
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// 单例访问
// ---------------------------------------------------------------------------

pub fn get() -> &'static MusicSourceManager {
    static INIT: std::sync::OnceLock<&'static MusicSourceManager> = std::sync::OnceLock::new();
    INIT.get_or_init(|| Box::leak(Box::new(MusicSourceManager::new())))
}

impl MusicSourceManager {
    fn new() -> Self {
        Self {
            phase: std::sync::Mutex::new(MusicSourcePhase::NotReady),
            child: tokio::sync::Mutex::new(None),
            stopped_by_user: std::sync::atomic::AtomicBool::new(false),
            #[cfg(windows)]
            sidecar_job: std::sync::Mutex::new(None),
            ensure_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn phase(&self) -> MusicSourcePhase {
        self.phase.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_phase(&self, phase: MusicSourcePhase) {
        let mut guard = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        *guard = phase;
    }
}

// ---------------------------------------------------------------------------
// 自动安装链
// ---------------------------------------------------------------------------

/// 确保环境 + sidecar 就绪（幂等，并发调用共享同一安装流程）。
pub async fn ensure_ready() -> Result<u16, String> {
    let mgr = get();
    let _guard = mgr.ensure_lock.lock().await;

    // 已在运行 → 直接返回端口
    if let MusicSourcePhase::Running { port } = mgr.phase() {
        return Ok(port);
    }
    mgr.stopped_by_user
        .store(false, std::sync::atomic::Ordering::SeqCst);

    // 1. 安装链（幂等）
    if !environment_ready() {
        install_environment().await?;
    }

    // 2. 落盘 sidecar 脚本（每次覆盖，保证随客户端升级）
    std::fs::create_dir_all(music_source_home()).map_err(|e| e.to_string())?;
    std::fs::write(server_script(), SERVER_PY)
        .map_err(|e| format!("failed to write server.py: {e}"))?;

    // 3. 启动 sidecar
    let port = spawn_sidecar().await?;
    mgr.set_phase(MusicSourcePhase::Running { port });
    Ok(port)
}

/// uv venv + uv pip install musicdl（对齐 ai00-run PyManager 的 uv 底层）。
async fn install_environment() -> Result<(), String> {
    let mgr = get();
    mgr.set_phase(MusicSourcePhase::Installing {
        stage: "checking uv".into(),
    });

    // uv 探测（uv venv/pip 需要）
    let uv = process_manager::create_tokio_command("uv")
        .arg("--version")
        .output()
        .await
        .map_err(|e| format!("uv not found (请先安装 uv: https://docs.astral.sh/uv/): {e}"))?;
    if !uv.status.success() {
        return Err("uv not usable — install it first: https://docs.astral.sh/uv/".into());
    }

    // venv
    mgr.set_phase(MusicSourcePhase::Installing {
        stage: "creating python venv".into(),
    });
    let out = process_manager::create_tokio_command("uv")
        .args([
            "venv",
            &venv_dir().to_string_lossy(),
            "--python",
            PY_VERSION,
        ])
        .output()
        .await
        .map_err(|e| format!("uv venv spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "uv venv failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    // musicdl 依赖
    mgr.set_phase(MusicSourcePhase::Installing {
        stage: "installing musicdl (may take a few minutes on first run)".into(),
    });
    let mut install_cmd = process_manager::create_tokio_command("uv");
    install_cmd.args([
        "pip",
        "install",
        "--python",
        &venv_dir().to_string_lossy(),
        MUSICDL_SPEC,
    ]);
    let out = run_with_timeout(install_cmd, Duration::from_secs(INSTALL_TIMEOUT_SECS)).await?;
    if !out.status.success() {
        return Err(format!(
            "uv pip install musicdl failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    // marker
    std::fs::create_dir_all(music_source_home()).map_err(|e| e.to_string())?;
    let marker = InstallMarker {
        deps: MUSICDL_SPEC.into(),
    };
    std::fs::write(
        install_marker(),
        serde_json::to_string_pretty(&marker).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;

    mgr.set_phase(MusicSourcePhase::Ready);
    log::info!("[MusicSource] environment installed ({MUSICDL_SPEC})");
    Ok(())
}

/// 带超时的命令执行（tokio::time::timeout 包装 output()）。
async fn run_with_timeout(
    mut cmd: tokio::process::Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| format!("command timed out after {}s", timeout.as_secs()))?
        .map_err(|e| format!("spawn failed: {e}"))
}

// ---------------------------------------------------------------------------
// sidecar 生命周期
// ---------------------------------------------------------------------------

/// 启动 sidecar 并等待就绪，返回实际端口。
async fn spawn_sidecar() -> Result<u16, String> {
    let mgr = get();

    let mut cmd = process_manager::create_tokio_command(venv_python());
    cmd.arg(server_script()).arg("--port").arg("0");
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn music source sidecar: {e}"))?;

    // stdout：读首行 ready JSON 解析端口；其余行丢弃（排水防阻塞）
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let port = match stdout {
        Some(stdout) => {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            match tokio::time::timeout(
                Duration::from_secs(READY_TIMEOUT_SECS),
                reader.read_line(&mut line),
            )
            .await
            {
                Ok(Ok(0)) | Err(_) | Ok(Err(_)) => {
                    return Err("sidecar exited before ready (see app log)".into());
                }
                Ok(Ok(_)) => {
                    // 后续行排水（防缓冲写满阻塞子进程）
                    tokio::spawn(async move {
                        use tokio::io::AsyncReadExt;
                        let mut reader = reader;
                        let mut buf = [0u8; 4096];
                        loop {
                            match reader.read(&mut buf[..]).await {
                                Ok(0) | Err(_) => break,
                                Ok(_) => {}
                            }
                        }
                    });
                    parse_ready_port(&line)
                        .ok_or_else(|| format!("invalid sidecar ready line: {line}"))?
                }
            }
        }
        None => return Err("sidecar stdout not piped".into()),
    };

    // stderr 日志泵 → app log
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf[..]).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]);
                        for l in text.lines().filter(|l| !l.trim().is_empty()) {
                            log::info!("[music-source] {l}");
                        }
                    }
                }
            }
        });
    }

    let mut slot = mgr.child.lock().await;
    if let Some(mut old) = slot.take() {
        let _ = old.kill().await;
    }
    *slot = Some(child);

    // sidecar 专属 Job（kill-on-close）——防主进程被强杀后残留 python
    #[cfg(windows)]
    {
        use win32job::ExtendedLimitInfo;
        match win32job::Job::create() {
            Ok(job) => {
                let mut info = ExtendedLimitInfo::new();
                info.limit_kill_on_job_close();
                if let Err(e) = job.set_extended_limit_info(&info) {
                    log::warn!("[MusicSource] sidecar job limit set failed: {e}");
                } else if let Some(handle) = slot.as_ref().and_then(|c| c.raw_handle()) {
                    match job.assign_process(handle as isize) {
                        Ok(()) => {
                            let mut guard =
                                mgr.sidecar_job.lock().unwrap_or_else(|e| e.into_inner());
                            *guard = Some(job);
                        }
                        Err(e) => log::warn!("[MusicSource] sidecar job assign failed: {e}"),
                    }
                }
            }
            Err(e) => log::warn!("[MusicSource] sidecar job create failed: {e}"),
        }
    }

    // healthz 就绪确认
    wait_healthz(port).await?;

    // 崩溃重启监控
    monitor_restart();

    log::info!("[MusicSource] sidecar running on 127.0.0.1:{port}");
    Ok(port)
}

/// 解析 sidecar 首行 `{"event":"ready","port":N}`。
fn parse_ready_port(line: &str) -> Option<u16> {
    #[derive(Deserialize)]
    struct ReadyLine {
        event: String,
        port: u16,
    }
    let parsed: ReadyLine = serde_json::from_str(line.trim()).ok()?;
    (parsed.event == "ready").then_some(parsed.port)
}

/// 轮询 /healthz 直到 200（READY_TIMEOUT_SECS 内）。
async fn wait_healthz(port: u16) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/healthz");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(READY_TIMEOUT_SECS);
    while tokio::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err("sidecar healthz timeout".into())
}

/// 崩溃自动重启（退避上限，最多连重 5 次）。
fn monitor_restart() {
    tokio::spawn(async {
        let mgr = get();
        let mut consecutive_failures = 0u32;
        loop {
            let status = {
                let mut slot = mgr.child.lock().await;
                match slot.as_mut() {
                    Some(child) => child.wait().await,
                    None => return,
                }
            };
            if mgr
                .stopped_by_user
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                log::info!("[MusicSource] sidecar stopped by user");
                return;
            }
            match status {
                Ok(s) => log::warn!("[MusicSource] sidecar exited: {s}"),
                Err(e) => log::warn!("[MusicSource] sidecar wait error: {e}"),
            }
            consecutive_failures += 1;
            if consecutive_failures > 5 {
                mgr.set_phase(MusicSourcePhase::Failed {
                    error: "sidecar crashed repeatedly (5x)".into(),
                });
                return;
            }
            let backoff = Duration::from_secs(2u64.pow(consecutive_failures.min(4)));
            log::warn!(
                "[MusicSource] restarting sidecar in {:?} (attempt {consecutive_failures})",
                backoff
            );
            tokio::time::sleep(backoff).await;
            if let Err(e) = spawn_sidecar().await {
                log::error!("[MusicSource] sidecar restart failed: {e}");
                mgr.set_phase(MusicSourcePhase::Failed { error: e });
                return;
            }
        }
    });
}

/// 用户主动停止（不自动重启）。
pub async fn stop() {
    let mgr = get();
    mgr.stopped_by_user
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let mut slot = mgr.child.lock().await;
    if let Some(mut child) = slot.take() {
        let _ = child.kill().await;
    }
    #[cfg(windows)]
    {
        let mut guard = mgr.sidecar_job.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }
    mgr.set_phase(MusicSourcePhase::Ready);
}

// ---------------------------------------------------------------------------
// HTTP 调用（search）
// ---------------------------------------------------------------------------

/// 一次搜索的结果（与 sidecar server.py 的 song 序列化 1:1）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSong {
    pub source: String,
    pub name: String,
    pub singers: String,
    pub album: String,
    pub duration_s: u64,
    pub ext: String,
    pub file_size_bytes: u64,
    pub download_url: String,
    pub lyric: Option<String>,
    pub cover_url: Option<String>,
    pub identifier: String,
    #[serde(default)]
    pub dl_headers: std::collections::HashMap<String, String>,
}

/// 榜单/歌单曲目（仅元数据；播放前经 resolve 换成 OnlineSong）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineTrack {
    pub track_id: String,
    pub name: String,
    pub singers: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub duration_s: u64,
    #[serde(default)]
    pub cover_url: Option<String>,
}

/// 排行榜条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineChart {
    pub id: String,
    pub name: String,
}

/// 榜单/歌单内容（名称 + 曲目列表）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineTrackList {
    pub name: String,
    pub tracks: Vec<OnlineTrack>,
}

/// sidecar POST：透传错误体（{"error": "..."}）给前端展示。
async fn sidecar_post<T: serde::de::DeserializeOwned>(
    port: u16,
    path: &str,
    body: serde_json::Value,
    timeout: Duration,
) -> Result<T, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("http://127.0.0.1:{port}{path}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("response read failed: {e}"))?;
    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| format!("http {}", status.as_u16()));
        return Err(msg);
    }
    serde_json::from_str(&text).map_err(|e| format!("response parse failed: {e}"))
}

/// 调 sidecar /search（自动 ensure_ready）。
pub async fn search(keyword: &str) -> Result<Vec<OnlineSong>, String> {
    let port = ensure_ready().await?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("http://127.0.0.1:{port}/search"))
        .json(&serde_json::json!({ "keyword": keyword }))
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("search failed: http {}", resp.status().as_u16()));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("search response parse failed: {e}"))?;
    let songs: Vec<OnlineSong> =
        serde_json::from_value(body.get("songs").cloned().unwrap_or(serde_json::json!([])))
            .map_err(|e| format!("search songs parse failed: {e}"))?;
    Ok(songs)
}

/// 榜单列表（网易云官方榜）。
pub async fn charts() -> Result<Vec<OnlineChart>, String> {
    let port = ensure_ready().await?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("http://127.0.0.1:{port}/charts"))
        .send()
        .await
        .map_err(|e| format!("charts request failed: {e}"))?;
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("charts response parse failed: {e}"))?;
    serde_json::from_value(body.get("charts").cloned().unwrap_or(serde_json::json!([])))
        .map_err(|e| format!("charts parse failed: {e}"))
}

/// 榜单曲目（纯元数据，秒回）。
pub async fn chart_tracks(chart_id: &str) -> Result<OnlineTrackList, String> {
    let port = ensure_ready().await?;
    sidecar_post(
        port,
        "/chart_tracks",
        serde_json::json!({ "chartId": chart_id }),
        Duration::from_secs(30),
    )
    .await
}

/// 电台曲池（多榜单并发取样 + 去重洗牌，纯元数据）。
pub async fn radio_pool() -> Result<Vec<OnlineTrack>, String> {
    let port = ensure_ready().await?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(40))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("http://127.0.0.1:{port}/radio_pool"))
        .send()
        .await
        .map_err(|e| format!("radio pool request failed: {e}"))?;
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("radio pool response parse failed: {e}"))?;
    serde_json::from_value(body.get("tracks").cloned().unwrap_or(serde_json::json!([])))
        .map_err(|e| format!("radio pool parse failed: {e}"))
}

/// 解析网易云歌单链接/ID → 曲目列表（纯元数据，秒回）。
pub async fn parse_playlist(url: &str) -> Result<OnlineTrackList, String> {
    let port = ensure_ready().await?;
    sidecar_post(
        port,
        "/playlist",
        serde_json::json!({ "url": url }),
        Duration::from_secs(30),
    )
    .await
}

/// 榜单/歌单曲目 → 带校验直链的 OnlineSong（多源搜索 + 名称匹配）。
pub async fn resolve(name: &str, singers: &str) -> Result<OnlineSong, String> {
    let port = ensure_ready().await?;
    #[derive(serde::Deserialize)]
    struct ResolveResp {
        song: OnlineSong,
    }
    let resp: ResolveResp = sidecar_post(
        port,
        "/resolve",
        serde_json::json!({ "name": name, "singers": singers }),
        Duration::from_secs(SEARCH_TIMEOUT_SECS),
    )
    .await?;
    Ok(resp.song)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// sidecar 状态查询（前端启动时轮询/展示）。
#[tauri::command]
pub async fn music_source_status() -> Result<MusicSourcePhase, String> {
    Ok(get().phase())
}

/// 确保就绪并返回端口（在线音源面板打开时调用）。
#[tauri::command]
pub async fn music_source_ensure_ready() -> Result<u16, String> {
    ensure_ready().await
}

/// 聚合搜索（musicdl 多源：QQ/酷我/咪咕/网易云/酷狗）。
#[tauri::command]
pub async fn music_source_search(keyword: String) -> Result<Vec<OnlineSong>, String> {
    let kw = keyword.trim().to_string();
    if kw.is_empty() {
        return Ok(vec![]);
    }
    search(&kw).await
}

/// 排行榜列表（网易云官方榜）。
#[tauri::command]
pub async fn music_source_charts() -> Result<Vec<OnlineChart>, String> {
    charts().await
}

/// 榜单曲目（纯元数据，秒回）。
#[tauri::command]
pub async fn music_source_chart_tracks(chart_id: String) -> Result<OnlineTrackList, String> {
    chart_tracks(chart_id.trim()).await
}

/// 电台曲池（多榜单混合洗牌，纯元数据）。
#[tauri::command]
pub async fn music_source_radio_pool() -> Result<Vec<OnlineTrack>, String> {
    radio_pool().await
}

/// 解析网易云歌单链接/ID → 曲目列表（纯元数据，秒回）。
#[tauri::command]
pub async fn music_source_parse_playlist(url: String) -> Result<OnlineTrackList, String> {
    parse_playlist(url.trim()).await
}

/// 榜单/歌单曲目解析为可播放歌曲（多源搜索 + 名称匹配，约 10s）。
#[tauri::command]
pub async fn music_source_resolve(name: String, singers: String) -> Result<OnlineSong, String> {
    resolve(name.trim(), singers.trim()).await
}

/// 停止 sidecar（设置里手动关）。
#[tauri::command]
pub async fn music_source_stop() -> Result<(), String> {
    stop().await;
    Ok(())
}

/// 内嵌的 sidecar 脚本（随客户端分发，每次启动覆盖落盘）。
const SERVER_PY: &str = include_str!("music_source/server.py");
