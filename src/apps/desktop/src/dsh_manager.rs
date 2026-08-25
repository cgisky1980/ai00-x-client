//! DshManager — dsh 引擎的自动安装与 sidecar 生命周期管理。
//!
//! v3 架构（见 .trae/documents/Agent体系迁移DeepSeek-Harness分阶段计划.md）：
//! Ai00-X 安装/启动时自动装齐 dsh 运行环境；dsh 以 headless web 模式
//! （`dsh web --no-open`，仅用其 /api HTTP 面与 SSE/WS 事件流）作为
//! sidecar 运行，界面用我们自己的前端。
//!
//! 自动安装链（幂等，全部后台执行）：
//! 1. node：ai00-run NodeInstaller → `~/.ai00-run/node/v22.23.2/`
//! 2. dsh：托管 npm 全局安装 `@deepseek-ai/dsh@<pinned>`（npmmirror 镜像）
//! 3. profile `ai00x`：程序化建目录（bundles = base + web-app），
//!    `dsh plugin add` 预装随客户端分发的 `@ai00-x/dsh-ai-bridge`
//! 4. 安装标记 `install-marker.json`（版本指纹，变更时重装/升级）
//!
//! sidecar：`dsh.cmd web --no-open --host 127.0.0.1 --port <DSH_PORT>`，
//! DSH_HOME 隔离到 app data；崩溃退避自动重启；退出随主进程（Job Object）。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Child;

use ai00_x_core::util::process_manager;

/// 钉死的 node 版本（dsh 0.1.x 要求 node >= 22.19）。
const NODE_VERSION: &str = "22.23.2";
/// 钉死的 dsh npm 版本（锁版本升级走 D5 受控机制）。
const DSH_NPM_SPEC: &str = "@deepseek-ai/dsh@0.1.1-rc.2";
/// dsh NPM 镜像（国内加速；与 resource_manager 多主机测速体系后续对齐）。
const NPM_REGISTRY: &str = "https://registry.npmmirror.com";
/// sidecar 专用 profile 名（bundles: base + web-app + ai-bridge）。
const DSH_PROFILE: &str = "ai00x";
/// sidecar 端口（避开用户手跑 dsh web 的默认 3080）。
const DSH_PORT: u16 = 3210;

/// 安装/运行阶段（推给前端 `dsh://phase` 事件）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum DshPhase {
    /// 环境缺失，尚未开始安装。
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

// clippy(derivable_impls) 豁免：手写 impl 与枚举注释分离，可读性优先。
#[allow(clippy::derivable_impls)]
impl Default for DshPhase {
    fn default() -> Self {
        Self::NotReady
    }
}

pub struct DshManager {
    phase: std::sync::Mutex<DshPhase>,
    child: tokio::sync::Mutex<Option<Child>>,
    /// 用户主动停止标记（停止时不自动重启）。
    stopped_by_user: std::sync::atomic::AtomicBool,
    /// sidecar 专属 Job（kill-on-close）：主进程无论正常退出还是被强杀，
    /// 内核关闭 Job 句柄都会连带终止 node——防止残留 sidecar 抢占 2100
    /// 端口导致下次启动 loader 白屏。保活在此（句柄随主进程回收）。
    #[cfg(windows)]
    sidecar_job: std::sync::Mutex<Option<win32job::Job>>,
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/// ai00-run 维护的 node 安装根目录（与 ai00-run NodeInstaller 默认一致）。
fn node_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ai00-run")
        .join("node")
}

/// 托管 node 版本目录。
fn node_dir() -> PathBuf {
    node_root().join(format!("v{NODE_VERSION}"))
}

fn node_exe() -> PathBuf {
    if cfg!(windows) {
        node_dir().join("node.exe")
    } else {
        node_dir().join("bin").join("node")
    }
}

fn npm_cmd() -> PathBuf {
    if cfg!(windows) {
        node_dir().join("npm.cmd")
    } else {
        node_dir().join("bin").join("npm")
    }
}

fn dsh_cmd() -> PathBuf {
    if cfg!(windows) {
        node_dir().join("dsh.cmd")
    } else {
        node_dir().join("bin").join("dsh")
    }
}

/// DSH_HOME：独立于用户 `~/.dsh`，隔离在 app data 下。
fn dsh_home() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Ai00-X")
        .join("dsh")
}

fn profile_dir() -> PathBuf {
    dsh_home().join("profiles").join(DSH_PROFILE)
}

fn install_marker() -> PathBuf {
    dsh_home().join("install-marker.json")
}

/// 随客户端分发的 @ai00-x/dsh-ai-bridge 插件目录。
///
/// 解析顺序：env 覆盖 → exe 旁 `dsh-plugins/ai-bridge`（release 布局）
/// → dev 布局 `client/dsh-plugins/ai-bridge`（从 target/release 反推）。
fn ai_bridge_plugin_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("AI00X_DSH_PLUGINS_DIR") {
        let p = PathBuf::from(dir).join("ai-bridge");
        if p.join("package.json").exists() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    // release：exe 旁 dsh-plugins/ai-bridge
    let bundled = exe_dir.join("dsh-plugins").join("ai-bridge");
    if bundled.join("package.json").exists() {
        return Some(bundled);
    }
    // dev：client/target/release/../../dsh-plugins/ai-bridge
    let dev = exe_dir.join("../../dsh-plugins/ai-bridge");
    if dev.join("package.json").exists() {
        return Some(dev);
    }
    // dev（测试二进制在 target/release/deps/，深一层）
    let dev_deep = exe_dir.join("../../../dsh-plugins/ai-bridge");
    if dev_deep.join("package.json").exists() {
        return Some(dev_deep);
    }
    None
}

// ---------------------------------------------------------------------------
// 单例访问
// ---------------------------------------------------------------------------

pub fn get() -> &'static DshManager {
    // 泄漏式单例：进程生命周期内唯一，避免 Box::leak 之外的 unsafe。
    static INIT: std::sync::OnceLock<&'static DshManager> = std::sync::OnceLock::new();
    INIT.get_or_init(|| Box::leak(Box::new(DshManager::new())))
}

/// 引擎 sidecar 是否处于运行态（dsh_proxy 拒绝 WS 升级前探测用）。
pub fn engine_running() -> bool {
    get().running()
}

impl DshManager {
    fn new() -> Self {
        Self {
            phase: std::sync::Mutex::new(DshPhase::NotReady),
            child: tokio::sync::Mutex::new(None),
            stopped_by_user: std::sync::atomic::AtomicBool::new(false),
            #[cfg(windows)]
            sidecar_job: std::sync::Mutex::new(None),
        }
    }

    pub fn phase(&self) -> DshPhase {
        self.phase.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 引擎 sidecar 是否处于运行态（dsh_proxy 拒绝升级前探测用）。
    pub fn running(&self) -> bool {
        matches!(self.phase(), DshPhase::Running { .. })
    }

    fn set_phase(&self, phase: DshPhase) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = phase.clone();
        log::info!("[DshManager] phase -> {phase:?}");
        // 推送前端事件（窗口未起时静默忽略）
        if let Some(app) = app_handle() {
            let _ = tauri::Emitter::emit(&app, "dsh://phase", &phase);
        }
    }
}

/// 全局 AppHandle（setup 时注入）。
static APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

pub fn set_app_handle(app: tauri::AppHandle) {
    *APP_HANDLE.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
}

fn app_handle() -> Option<tauri::AppHandle> {
    APP_HANDLE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

// ---------------------------------------------------------------------------
// 环境检测（零副作用，供状态查询）
// ---------------------------------------------------------------------------

/// 安装标记指纹：node 版本 + dsh npm spec + 插件目录 mtime。
#[derive(Serialize)]
struct InstallFingerprint {
    node: String,
    dsh: String,
    plugin_marker: String,
}

fn fingerprint() -> Option<InstallFingerprint> {
    let plugin_dir = ai_bridge_plugin_dir()?;
    let plugin_marker = std::fs::metadata(plugin_dir)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        })
        .unwrap_or(0)
        .to_string();
    Some(InstallFingerprint {
        node: NODE_VERSION.to_string(),
        dsh: DSH_NPM_SPEC.to_string(),
        plugin_marker,
    })
}

fn fingerprint_matches_marker() -> bool {
    let Some(fp) = fingerprint() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(install_marker()) else {
        return false;
    };
    let Ok(marker) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    marker.get("node").and_then(|v| v.as_str()) == Some(fp.node.as_str())
        && marker.get("dsh").and_then(|v| v.as_str()) == Some(fp.dsh.as_str())
        && marker.get("plugin_marker").and_then(|v| v.as_str()) == Some(fp.plugin_marker.as_str())
}

/// 环境是否完整：node/dsh/profile/标记。
pub fn environment_ready() -> bool {
    node_exe().exists() && dsh_cmd().exists() && fingerprint_matches_marker()
}

// ---------------------------------------------------------------------------
// 自动安装链
// ---------------------------------------------------------------------------

/// 确保环境就绪（幂等）：缺失则安装，已完成则直接返回。
/// 由启动序列后台调用；UI 打开 dsh 场景时也可显式触发。
pub async fn ensure_environment() -> Result<(), String> {
    let mgr = get();
    if environment_ready() {
        // marker 匹配也做 profile 校验（幂等修复：manifest 缺 web-app 等历史损伤）
        ensure_profile().await?;
        if matches!(mgr.phase(), DshPhase::NotReady) {
            mgr.set_phase(DshPhase::Ready);
        }
        return Ok(());
    }

    mgr.set_phase(DshPhase::Installing {
        stage: "checking".into(),
    });

    // 1. node（ai00-run）
    if !node_exe().exists() {
        mgr.set_phase(DshPhase::Installing {
            stage: format!("installing node {NODE_VERSION}"),
        });
        install_node().await?;
    }

    // 2. dsh（托管 npm 全局安装）
    if !dsh_cmd().exists() {
        mgr.set_phase(DshPhase::Installing {
            stage: format!("installing {DSH_NPM_SPEC}"),
        });
        install_dsh().await?;
    }

    // 3. profile ai00x + 预装 ai-bridge 插件
    mgr.set_phase(DshPhase::Installing {
        stage: "preparing profile".into(),
    });
    ensure_profile().await?;

    // 4. 写安装标记
    if let Some(fp) = fingerprint() {
        let _ = std::fs::create_dir_all(dsh_home());
        let _ = std::fs::write(
            install_marker(),
            serde_json::to_string_pretty(&fp).unwrap_or_default(),
        );
    }

    mgr.set_phase(DshPhase::Ready);
    Ok(())
}

/// ai00-run 安装 node（下载 zip + 解压到 ~/.ai00-run/node/v<version>）。
async fn install_node() -> Result<(), String> {
    let installer = ai00_run::node::installer::NodeInstaller::new(Some(node_root()));
    installer
        .install(NODE_VERSION)
        .await
        .map(|p| {
            log::info!("[DshManager] node installed at {}", p.display());
        })
        .map_err(|e| format!("node install failed: {e}"))
}

/// 托管 npm 全局安装 dsh（锁版本 + npmmirror 镜像）。
async fn install_dsh() -> Result<(), String> {
    let npm = npm_cmd();
    let mut cmd = process_manager::create_tokio_command(&npm);
    cmd.args([
        "install",
        "-g",
        DSH_NPM_SPEC,
        &format!("--registry={NPM_REGISTRY}"),
    ])
    .current_dir(node_dir());
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("npm spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "npm install dsh failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    log::info!("[DshManager] dsh installed ({DSH_NPM_SPEC})");
    Ok(())
}

/// 建/修 profile `ai00x` 并预装 ai-bridge 插件。
///
/// 程序化三步：
/// a. 若 package.json 不存在 → 写初始模板（bundles = base + web-app）
/// b. 若已有但 bundles 缺 web-app（dsh plugin 默认 init 只有 base）→ 补写
/// c. `dsh plugin --profile ai00x add <plugin_dir>`（pnpm link + reconcile）
async fn ensure_profile() -> Result<(), String> {
    let dir = profile_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir profile failed: {e}"))?;

    // a + b：manifest 初始化/修正
    // 注意：必须真正落盘——`dsh plugin add` 首次运行时会用默认 bundles=[base]
    // 初始化 profile；不落盘我们声明的 web-app 就会被默认值覆盖。
    let manifest_path = dir.join("package.json");
    let mut manifest: serde_json::Value = if manifest_path.exists() {
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?)
            .unwrap_or_else(|_| default_profile_manifest())
    } else {
        default_profile_manifest()
    };

    let bundles_ok = manifest
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array())
        .is_some_and(|arr| {
            arr.iter()
                .any(|v| v.as_str() == Some("@deepseek-ai/dsh-web-app"))
        });
    let mut need_write = !manifest_path.exists() || !bundles_ok;
    if !bundles_ok {
        // 只补 web-app（保留既有 bundle 如 ai-bridge），不重写整个数组
        let mut bundles: Vec<serde_json::Value> = manifest
            .get("dsh")
            .and_then(|d| d.get("profile"))
            .and_then(|p| p.get("bundles"))
            .and_then(|b| b.as_array())
            .cloned()
            .unwrap_or_default();
        bundles.push(serde_json::json!("@deepseek-ai/dsh-web-app"));
        manifest["dsh"]["profile"]["bundles"] = serde_json::Value::Array(bundles);
    }
    // dependencies 已声明 ai-bridge 但 bundles 缺失（历史 reconcile 丢失）→ 直接补
    let has_bridge_dep = manifest
        .get("dependencies")
        .and_then(|d| d.as_object())
        .is_some_and(|d| d.contains_key("@ai00-x/dsh-ai-bridge"));
    let has_bridge_bundle = manifest
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array())
        .is_some_and(|arr| {
            arr.iter()
                .any(|v| v.as_str() == Some("@ai00-x/dsh-ai-bridge"))
        });
    if has_bridge_dep && !has_bridge_bundle {
        if let Some(arr) = manifest["dsh"]["profile"]["bundles"].as_array_mut() {
            arr.push(serde_json::json!("@ai00-x/dsh-ai-bridge"));
        }
        need_write = true;
    }
    if need_write {
        std::fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap_or_default(),
        )
        .map_err(|e| format!("write manifest failed: {e}"))?;
    }

    // 默认模型指向我们的网关（独立 DSH_HOME 无用户 settings 时兜底）
    ensure_default_model_setting().await?;
    // 空 patch 层（dsh 加载需要）
    let patch = dir.join("cordis.patch.yml");
    if !patch.exists() {
        let _ = std::fs::write(&patch, "[]\n");
    }
    let workspace = dir.join("pnpm-workspace.yaml");
    if !workspace.exists() {
        let _ = std::fs::write(
            &workspace,
            "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
        );
    }

    // c：预装 ai-bridge（link 本地分发的插件目录）
    let plugin_dir = ai_bridge_plugin_dir()
        .ok_or_else(|| "ai-bridge plugin directory not found (bundled or dev)".to_string())?;
    let deps_declared = manifest
        .get("dependencies")
        .and_then(|d| d.as_object())
        .is_some_and(|d| d.contains_key("@ai00-x/dsh-ai-bridge"));
    if !deps_declared {
        let dsh = dsh_cmd();
        let mut cmd = process_manager::create_tokio_command(&dsh);
        cmd.args([
            "plugin",
            "--profile",
            DSH_PROFILE,
            "add",
            &plugin_dir.to_string_lossy(),
        ])
        .env("DSH_HOME", dsh_home())
        .env("PATH", prepend_path(node_dir()));
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("dsh spawn failed: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "dsh plugin add failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    log::info!(
        "[DshManager] profile {DSH_PROFILE} ready at {}",
        dir.display()
    );
    Ok(())
}

fn default_profile_manifest() -> serde_json::Value {
    serde_json::json!({
        "name": format!("dsh-profile-{DSH_PROFILE}"),
        "private": true,
        "dependencies": {},
        "dsh": { "profile": { "bundles": [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
        ]}}
    })
}

/// 确保 DSH_HOME/settings.yaml 的默认模型指向 Ai00-X 网关（ai00-x/ai00-auto）。
/// 幂等：仅在无 agent-default-model 键时写入，尊重用户后续选择。
async fn ensure_default_model_setting() -> Result<(), String> {
    let path = dsh_home().join("settings.yaml");
    let raw = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    if raw.contains("agent-default-model") {
        return Ok(());
    }
    let entry = "agent-default-model:\n  provider: ai00-x\n  model: ai00-auto\n";
    let next = if raw.trim().is_empty() {
        entry.to_string()
    } else {
        format!("{raw}\n{entry}")
    };
    std::fs::create_dir_all(dsh_home()).map_err(|e| e.to_string())?;
    std::fs::write(&path, next).map_err(|e| format!("write settings failed: {e}"))
}

fn prepend_path(dir: PathBuf) -> String {
    let old = std::env::var("PATH").unwrap_or_default();
    format!(
        "{}{}{}",
        dir.display(),
        if cfg!(windows) { ";" } else { ":" },
        old
    )
}

// ---------------------------------------------------------------------------
// sidecar 生命周期
// ---------------------------------------------------------------------------

/// 启动 sidecar（幂等）：环境就绪 → spawn → 健康等待 → Running。
/// 崩溃后由监控 task 退避自动重启（除非 stop() 触发）。
pub async fn start() -> Result<(), String> {
    let mgr = get();
    if matches!(mgr.phase(), DshPhase::Running { .. }) {
        return Ok(());
    }
    mgr.stopped_by_user
        .store(false, std::sync::atomic::Ordering::SeqCst);

    // 环境保障（幂等，已装则秒回）
    ensure_environment().await?;

    mgr.set_phase(DshPhase::Installing {
        stage: "starting engine".into(),
    });

    spawn_sidecar().await?;

    // 健康等待：POST /api/host.describe 直到 200 或超时（首次启动含插件加载）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        if tokio::time::Instant::now() >= deadline {
            let err = "dsh sidecar health check timed out".to_string();
            mgr.set_phase(DshPhase::Failed { error: err.clone() });
            return Err(err);
        }
        if let Ok(resp) = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{DSH_PORT}/api/host.describe"))
            .json(&serde_json::json!({
                "type": "client-request",
                "rpcId": format!("health-{}", std::process::id()),
                "method": "host.describe",
                "payload": {}
            }))
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            if resp.status().is_success() {
                mgr.set_phase(DshPhase::Running { port: DSH_PORT });
                monitor_restart();
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
}

/// 用户主动停止（不自动重启）。
pub async fn stop() -> Result<(), String> {
    let mgr = get();
    mgr.stopped_by_user
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let mut child = mgr.child.lock().await;
    if let Some(mut c) = child.take() {
        let _ = c.kill().await;
    }
    mgr.set_phase(DshPhase::Ready);
    Ok(())
}

async fn spawn_sidecar() -> Result<(), String> {
    let mgr = get();
    // 直接 node bin.js（不走 dsh.cmd 批处理 wrapper——Windows 下 tokio spawn
    // 无法直接执行 .cmd；bin.js 路径与 dsh.cmd 内的解析一致）
    let bin = node_dir()
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if !bin.exists() {
        return Err(format!("dsh bin.js not found at {}", bin.display()));
    }
    let mut cmd = process_manager::create_tokio_command(node_exe());
    // 注意：不能写 `web` 子命令（与 --profile 互斥）；profile bundles 含
    // dsh-web-app，boot 后 app 自动是 web——直接跟 web app 的 flags。
    // trusted-host：放行我们 webview 的 origin（正式=内嵌服务器 2100，
    // dev=tauri.localhost）访问 /api 信任栅栏。
    cmd.arg(&bin)
        .args(["--profile", DSH_PROFILE, "--no-open", "--host", "127.0.0.1"])
        .arg("--port")
        .arg(DSH_PORT.to_string())
        .arg("--trusted-host")
        .arg("127.0.0.1:2100")
        .arg("--trusted-host")
        .arg("tauri.localhost")
        .env("DSH_HOME", dsh_home())
        .env(
            "AI00_S_INTERNAL_TOKEN",
            ai00_x_core::infrastructure::ai::client_factory::ai00_s_internal_token(),
        )
        .env("PATH", prepend_path(node_dir()))
        .current_dir(dsh_home())
        .kill_on_drop(true);

    // stdout/stderr 管道转发到日志（CREATE_NO_WINDOW 由 process_manager 处理）
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("dsh spawn failed: {e}"))?;
    log::info!(
        "[DshManager] sidecar spawned: pid={:?} port={DSH_PORT}",
        child.id()
    );

    // 日志泵（stderr → log）
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let line = String::from_utf8_lossy(&buf[..n]);
                        for l in line.lines().filter(|l| !l.trim().is_empty()) {
                            log::info!("[dsh] {l}");
                        }
                    }
                }
            }
        });
    }

    let mut slot = mgr.child.lock().await;
    // 若有旧进程残留先清理
    if let Some(mut old) = slot.take() {
        let _ = old.kill().await;
    }
    *slot = Some(child);

    // sidecar 专属 Job（kill-on-close）：即使主进程被强杀（Drop 不触发、
    // kill_on_drop 失效），内核回收 Job 句柄也会终止 node——残留 sidecar
    // 曾持有 2100 监听 socket 导致后续启动 loader 白屏（2026-08-25 踩坑）。
    #[cfg(windows)]
    {
        use win32job::ExtendedLimitInfo;
        match win32job::Job::create() {
            Ok(job) => {
                let mut info = ExtendedLimitInfo::new();
                info.limit_kill_on_job_close();
                if let Err(e) = job.set_extended_limit_info(&info) {
                    log::warn!("[DshManager] sidecar job limit set failed: {e}");
                } else if let Some(handle) = slot.as_ref().and_then(|c| c.raw_handle()) {
                    match job.assign_process(handle as isize) {
                        Ok(()) => {
                            let mut guard =
                                mgr.sidecar_job.lock().unwrap_or_else(|e| e.into_inner());
                            *guard = Some(job); // 保活：句柄随主进程生命周期
                            log::info!(
                                "[DshManager] sidecar guarded by dedicated kill-on-close job"
                            );
                        }
                        Err(e) => {
                            log::warn!("[DshManager] sidecar job assign failed: {e}")
                        }
                    }
                }
            }
            Err(e) => log::warn!("[DshManager] sidecar job create failed: {e}"),
        }
    }

    Ok(())
}

/// 崩溃自动重启（退避上限，最多连重 5 次）。
fn monitor_restart() {
    tokio::spawn(async {
        let mgr = get();
        let mut consecutive_failures = 0u32;
        loop {
            // 等 child 退出
            let status = {
                let mut slot = mgr.child.lock().await;
                match slot.as_mut() {
                    Some(child) => child.wait().await,
                    None => return, // slot 被清（stop 或重启）→ 退出监控
                }
            };
            if mgr
                .stopped_by_user
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                log::info!("[DshManager] sidecar stopped by user");
                return;
            }
            match status {
                Ok(s) => log::warn!("[DshManager] sidecar exited: {s}"),
                Err(e) => log::warn!("[DshManager] sidecar wait error: {e}"),
            }
            consecutive_failures += 1;
            if consecutive_failures > 5 {
                mgr.set_phase(DshPhase::Failed {
                    error: "sidecar crashed repeatedly (5x)".into(),
                });
                return;
            }
            let backoff = Duration::from_secs(2u64.pow(consecutive_failures.min(4)));
            log::warn!(
                "[DshManager] restarting sidecar in {backoff:?} (attempt {consecutive_failures})"
            );
            tokio::time::sleep(backoff).await;
            if mgr
                .stopped_by_user
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            if spawn_sidecar().await.is_err() {
                continue;
            }
            consecutive_failures = 0;
        }
    });
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshStatus {
    pub phase: DshPhase,
    pub node_version: Option<String>,
    pub dsh_version: Option<String>,
    pub port: Option<u16>,
    pub environment_ready: bool,
}

#[tauri::command]
pub async fn dsh_status() -> Result<DshStatus, String> {
    let mgr = get();
    let phase = mgr.phase();
    let port = match &phase {
        DshPhase::Running { port } => Some(*port),
        _ => None,
    };
    Ok(DshStatus {
        phase,
        node_version: node_exe().exists().then(|| NODE_VERSION.to_string()),
        dsh_version: dsh_cmd().exists().then(|| DSH_NPM_SPEC.to_string()),
        port,
        environment_ready: environment_ready(),
    })
}

/// 确保引擎可用（安装 + 启动，幂等）。UI 打开 dsh 场景时调用。
#[tauri::command]
pub async fn dsh_ensure_ready() -> Result<DshStatus, String> {
    start().await?;
    dsh_status().await
}

#[tauri::command]
pub async fn dsh_stop() -> Result<DshStatus, String> {
    stop().await?;
    dsh_status().await
}

/// 启动序列入口：后台静默安装并启动（不阻塞主窗口）。
pub fn spawn_bootstrap() {
    tokio::spawn(async {
        if let Err(e) = start().await {
            log::error!("[DshManager] bootstrap failed: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_manifest_contains_web_app() {
        let m = default_profile_manifest();
        let bundles = m["dsh"]["profile"]["bundles"].as_array().unwrap();
        assert!(bundles
            .iter()
            .any(|b| b.as_str() == Some("@deepseek-ai/dsh-web-app")));
    }

    #[test]
    fn plugin_dir_resolves_in_dev() {
        // CARGO_MANIFEST_DIR = client/src/apps/desktop → repo client 根需退三级
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../dsh-plugins/ai-bridge");
        assert!(p.join("package.json").exists(), "expected {}", p.display());
    }
}
