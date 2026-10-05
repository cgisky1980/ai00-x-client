//! DshManager — dsh 引擎的自动安装与 sidecar 生命周期管理。
//!
//! v3 架构（见 .trae/documents/Agent体系迁移DeepSeek-Harness分阶段计划.md）：
//! Ai00-X 安装/启动时自动装齐 dsh 运行环境；dsh 以 headless web 模式
//! （`dsh web --no-open`，仅用其 /api HTTP 面与 SSE/WS 事件流）作为
//! sidecar 运行，界面用我们自己的前端。
//!
//! 自动安装链（幂等，全部后台执行）：
//! 1. node：ai00-run NodeInstaller → `~/.ai00-run/node/v<NODE_VERSION>/`
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

/// 版本常量（node/dsh/npm 镜像/内置插件清单）——生成自 packages/shared/agent-versions.json
/// （`pnpm run generate-agent-versions`），与 scripts/dsh-plugin-check.mjs 同源，禁止手改。
#[path = "dsh_versions.gen.rs"]
pub mod dsh_versions_gen;

use dsh_versions_gen::{BUNDLED_PLUGINS, DSH_NPM_SPEC, NODE_VERSION};

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
    /// 插件装卸重启串行化：并发装卸各自触发重启时，start 在锁内串行执行，
    /// 后到者发现 Running 直接幂等返回——杜绝 stop/start 竞态双杀双启。
    restart_lock: tokio::sync::Mutex<()>,
    /// sidecar 专属 Job（kill-on-close）：主进程无论正常退出还是被强杀，
    /// 内核关闭 Job 句柄都会连带终止 node——防止残留 sidecar 抢占 2100
    /// 端口导致下次启动 loader 白屏。保活在此（句柄随主进程回收）。
    #[cfg(windows)]
    sidecar_job: std::sync::Mutex<Option<win32job::Job>>,
    /// 0.1.5 鉴权：stdout 捕获的一次性启动 token（`dsh web: http://...?token=X`）。
    auth_token: tokio::sync::Mutex<Option<String>>,
    /// 0.1.5 鉴权：token 换取的签名会话 cookie（`dsh-auth-<host>=<value>`，
    /// 引擎 .credentials.yaml 签名密钥不变则跨重启 30 天有效；每次 spawn 后
    /// 仍重新交换）。dsh_proxy 转发时注入到 /api 与 remote.mux 请求。
    auth_cookie: tokio::sync::Mutex<Option<String>>,
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

/// DSH_HOME：独立于用户 `~/.dsh`，隔离在 app data 下（internal_api 的 grants
/// 文件也放这里，pub 供跨模块/跨 crate 取同一路径，避免路径逻辑双写漂移）。
pub fn dsh_home() -> PathBuf {
    // 环境覆盖（笔阵 P0）：mkt-agent 独立实例与 desktop 隔离 DSH_HOME。
    if let Ok(p) = std::env::var("AI00X_DSH_HOME") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Ai00-X")
        .join("dsh")
}

// 引擎权限档（dsh-base permission-presets 读 DSH_PERMISSION_MODE）：
// read-only / workspace-write / danger-full-access。桌面设置页选择 →
// set_permission_mode → 下次 spawn_sidecar 注入（重启引擎后生效）。
static PERMISSION_MODE: std::sync::OnceLock<std::sync::RwLock<Option<String>>> =
    std::sync::OnceLock::new();

/// 设置引擎权限档（None = 引擎默认 workspace-write）。见 spawn_sidecar 注入点。
pub fn set_permission_mode(mode: Option<String>) {
    let lock = PERMISSION_MODE.get_or_init(|| std::sync::RwLock::new(None));
    if let Ok(mut guard) = lock.write() {
        *guard = mode.filter(|m| !m.is_empty());
    }
}

/// 当前待注入的权限档（UI 回显用）。
pub fn permission_mode() -> Option<String> {
    PERMISSION_MODE
        .get_or_init(|| std::sync::RwLock::new(None))
        .read()
        .ok()
        .and_then(|g| g.clone())
}

/// 端口/profile 环境覆盖（笔阵 P0）：mkt-agent 与 desktop 并存时各自隔离
/// sidecar（如 AI00X_DSH_PORT=3211 + AI00X_DSH_PROFILE=mkt）。缺省零变化。
pub fn dsh_port() -> u16 {
    std::env::var("AI00X_DSH_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DSH_PORT)
}

pub fn dsh_profile() -> String {
    std::env::var("AI00X_DSH_PROFILE").unwrap_or_else(|_| DSH_PROFILE.to_string())
}

/// 当前引擎会话 cookie（笔阵 mkt-agent driver 直连 /api 用；未握手时 None）。
pub async fn current_auth_cookie() -> Option<String> {
    get().auth_cookie.lock().await.clone()
}

/// 引擎 /api 基址（笔阵 mkt-agent driver 用）。
pub fn api_base() -> String {
    format!("http://127.0.0.1:{}", dsh_port())
}

pub(crate) fn profile_dir() -> PathBuf {
    dsh_home().join("profiles").join(dsh_profile())
}

fn install_marker() -> PathBuf {
    dsh_home().join("install-marker.json")
}

/// 随客户端分发的 dsh 插件目录（按子目录名解析）。
///
/// 解析顺序：env 覆盖 → exe 旁 `dsh-plugins/<name>`（release 布局）
/// → dev 布局 `client/dsh-plugins/<name>`（从 target/release 反推）。
fn bundled_plugin_dir(name: &str) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("AI00X_DSH_PLUGINS_DIR") {
        let p = PathBuf::from(dir).join(name);
        if p.join("package.json").exists() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    // release：exe 旁 dsh-plugins/<name>
    let bundled = exe_dir.join("dsh-plugins").join(name);
    if bundled.join("package.json").exists() {
        return Some(bundled);
    }
    // dev：client/target/release/../../dsh-plugins/<name>
    let dev = exe_dir.join("../../dsh-plugins").join(name);
    if dev.join("package.json").exists() {
        return Some(dev);
    }
    // dev（测试二进制在 target/release/deps/，深一层）
    let dev_deep = exe_dir.join("../../../dsh-plugins").join(name);
    if dev_deep.join("package.json").exists() {
        return Some(dev_deep);
    }
    None
}

/// 随客户端分发的 @ai00-x/dsh-ai-bridge 插件目录。
fn ai_bridge_plugin_dir() -> Option<PathBuf> {
    bundled_plugin_dir("ai-bridge")
}

// 随客户端分发的 dsh 插件清单见 dsh_versions_gen::BUNDLED_PLUGINS（生成常量）。

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
            restart_lock: tokio::sync::Mutex::new(()),
            #[cfg(windows)]
            sidecar_job: std::sync::Mutex::new(None),
            auth_token: tokio::sync::Mutex::new(None),
            auth_cookie: tokio::sync::Mutex::new(None),
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

pub fn app_handle() -> Option<tauri::AppHandle> {
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

/// 托管全局安装的 dsh 实际版本是否与 pinned spec 一致（升级检测：
/// `dsh.cmd` 存在 ≠ 版本正确，marker 可能与磁盘漂移，以 package.json 为准）。
fn installed_dsh_version_matches() -> bool {
    let pkg = node_dir()
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let Ok(raw) = std::fs::read_to_string(&pkg) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(installed) = v.get("version").and_then(|x| x.as_str()) else {
        return false;
    };
    // spec 形如 "@deepseek-ai/dsh@0.1.5-rc.2"：取最后一个 '@' 后为版本
    match DSH_NPM_SPEC.rsplit_once('@') {
        Some((_, want)) => installed == want,
        None => false,
    }
}

/// 环境是否完整：node/dsh/版本/标记。
pub fn environment_ready() -> bool {
    node_exe().exists()
        && dsh_cmd().exists()
        && installed_dsh_version_matches()
        && fingerprint_matches_marker()
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

    // 2. dsh（托管 npm 全局安装；已装但版本 ≠ pinned spec 时同样触发——升级路径）
    if !dsh_cmd().exists() || !installed_dsh_version_matches() {
        mgr.set_phase(DshPhase::Installing {
            stage: format!("installing {DSH_NPM_SPEC}"),
        });
        install_dsh().await?;
    }

    // 2.5 能力包（P2 能力吸纳：computer-use 等，best-effort——失败仅告警，
    // 引擎照常启动，只是对应能力缺席）
    install_capability_packages().await?;

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

    // 5. 引擎隔离终端 shim（P2-B；失败仅告警不影响环境就绪）
    if let Err(e) = ensure_terminal_shims() {
        log::warn!("[DshManager] terminal shims skipped: {e}");
    }

    mgr.set_phase(DshPhase::Ready);
    Ok(())
}

// ---------------------------------------------------------------------------
// 引擎隔离终端（P2-B）：托盘「引擎终端」直达操作本 profile 的终端
// ---------------------------------------------------------------------------

/// 生成 `<DSH_HOME>/bin` 私有 shim（dsh/node/npm）：内容 = 设 DSH_HOME +
/// 前置托管 node 的 PATH + 转发真实可执行。只在该终端进程生效，不污染系统 PATH。
pub fn ensure_terminal_shims() -> Result<PathBuf, String> {
    let home = dsh_home();
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("mkdir {}: {e}", bin.display()))?;
    let node_s = node_dir().to_string_lossy().to_string();
    let home_s = home.to_string_lossy().to_string();
    let entry_s = node_dir()
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
        .to_string_lossy()
        .to_string();
    let prologue =
        format!("@echo off\r\nset \"DSH_HOME={home_s}\"\r\nset \"PATH={node_s};%PATH%\"\r\n");
    let node_exe_line = format!("\"{node_s}\\node.exe\"");
    let dsh_entry_line = format!("\"{entry_s}\"");
    let npm_cli_line = format!("\"{node_s}\\node_modules\\npm\\bin\\npm-cli.js\"");
    let shims = [
        (
            "dsh.cmd",
            format!("{prologue}{node_exe_line} {dsh_entry_line} %*\r\n"),
        ),
        ("node.cmd", format!("{prologue}{node_exe_line} %*\r\n")),
        (
            "npm.cmd",
            format!("{prologue}{node_exe_line} {npm_cli_line} %*\r\n"),
        ),
    ];
    for (name, content) in shims {
        let path = bin.join(name);
        // 内容不变则跳过（幂等）
        if std::fs::read_to_string(&path)
            .map(|c| c == content)
            .unwrap_or(false)
        {
            continue;
        }
        std::fs::write(&path, &content).map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    Ok(bin)
}

/// 打开一个配置好的引擎终端（wt 优先，powershell 兜底）。
pub async fn open_engine_terminal() -> Result<(), String> {
    let bin = ensure_terminal_shims()?;
    let home = dsh_home();
    let node_s = node_dir().to_string_lossy().to_string();
    let bin_s = bin.to_string_lossy().to_string();
    let home_s = home.to_string_lossy().to_string();

    let mut cmd = std::process::Command::new("wt.exe");
    cmd.arg("-d")
        .arg(&home_s)
        .env("DSH_HOME", &home_s)
        .env("PATH", format!("{bin_s};{node_s};%PATH%"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    if cmd.spawn().is_ok() {
        log::info!("[DshManager] engine terminal opened (wt)");
        return Ok(());
    }

    // 兜底：powershell（wt 不在 PATH/未装 Windows Terminal）
    let mut fallback = std::process::Command::new("powershell");
    fallback
        .args([
            "-NoExit",
            "-Command",
            &format!("Set-Location -LiteralPath '{home_s}'"),
        ])
        .env("DSH_HOME", &home_s)
        .env("PATH", format!("{bin_s};{node_s};%PATH%"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        fallback.creation_flags(CREATE_NEW_CONSOLE);
    }
    fallback
        .spawn()
        .map(|_| {
            log::info!("[DshManager] engine terminal opened (powershell fallback)");
        })
        .map_err(|e| format!("open terminal failed: {e}"))
}

/// 托盘/前端命令入口。
#[tauri::command]
pub async fn open_dsh_terminal() -> Result<(), String> {
    open_engine_terminal().await
}

/// ai00-run 安装 node（下载 zip + 解压到 ~/.ai00-run/node/v<version>）。
/// 镜像降级链：npmmirror（国内快）→ nodejs.org 官方（兜底）；每个源失败
/// 记日志后自动切换下一个，全部失败才报错（弱网首启动不再卡死单点）。
async fn install_node() -> Result<(), String> {
    const NODE_DIST_MIRRORS: &[&str] = &[
        "https://npmmirror.com/mirrors/node",
        "https://nodejs.org/dist",
    ];
    let mut errors: Vec<String> = Vec::new();
    for mirror in NODE_DIST_MIRRORS {
        let mut installer = ai00_run::node::installer::NodeInstaller::new(Some(node_root()));
        installer.set_mirror_url((*mirror).to_string());
        match installer.install(NODE_VERSION).await {
            Ok(p) => {
                log::info!(
                    "[DshManager] node installed at {} (mirror: {mirror})",
                    p.display()
                );
                return Ok(());
            }
            Err(e) => {
                log::warn!(
                    "[DshManager] node install failed via {mirror}: {e}; trying next mirror"
                );
                errors.push(format!("{mirror}: {e}"));
            }
        }
    }
    Err(format!(
        "node install failed on all mirrors ({}): {}",
        NODE_DIST_MIRRORS.len(),
        errors.join(" | ")
    ))
}

/// npm registry 降级链（首启动离线保障）：npmmirror 主用，官方 registry 兜底。
const NPM_REGISTRY_FALLBACKS: &[&str] = &[
    "https://registry.npmmirror.com",
    "https://registry.npmjs.org",
];

/// 官方可选能力包（随引擎版本钉死；由版本限定 patch 资产 capability-rows
/// 挂进编排组合）。不在 @deepseek-ai/dsh 主包依赖里，需全局安装才能被解析。
const DSH_CAPABILITY_PACKAGES: &[&str] = &[
    "@deepseek-ai/dsh-computer-use",
    "@deepseek-ai/dsh-experimental-computer-use-cua-driver-native",
];

/// 全局安装能力包（best-effort）：已存在跳过；失败告警继续——引擎 boot 对
/// 不可解析的 bundle 只 warn+skip，能力缺席但无碍运行。
async fn install_capability_packages() -> Result<(), String> {
    let version = dsh_version()?;
    let npm = npm_cmd();
    for pkg in DSH_CAPABILITY_PACKAGES {
        let mut dir = node_dir().join("node_modules");
        for part in pkg.split('/') {
            dir.push(part);
        }
        if dir.exists() {
            continue;
        }
        let spec = format!("{pkg}@{version}");
        mgr_install_global(&npm, &spec).await.unwrap_or_else(|e| {
            log::warn!("[DshManager] capability package install failed ({spec}): {e}");
        });
    }
    Ok(())
}

/// 单包全局安装（复用 registry 降级链）。
async fn mgr_install_global(npm: &PathBuf, spec: &str) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    for registry in NPM_REGISTRY_FALLBACKS {
        let mut cmd = process_manager::create_tokio_command(npm);
        cmd.args(["install", "-g", spec, &format!("--registry={registry}")])
            .current_dir(node_dir());
        match cmd.output().await {
            Ok(output) if output.status.success() => {
                log::info!("[DshManager] installed {spec} (registry: {registry})");
                return Ok(());
            }
            Ok(output) => {
                errors.push(format!(
                    "{registry}: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            Err(e) => errors.push(format!("{registry}: {e}")),
        }
    }
    Err(format!(
        "install {spec} failed on all registries: {}",
        errors.join(" | ")
    ))
}

/// 托管 npm 全局安装 dsh（锁版本 + registry 降级链）。
async fn install_dsh() -> Result<(), String> {
    let npm = npm_cmd();
    let mut errors: Vec<String> = Vec::new();
    for registry in NPM_REGISTRY_FALLBACKS {
        let mut cmd = process_manager::create_tokio_command(&npm);
        cmd.args([
            "install",
            "-g",
            DSH_NPM_SPEC,
            &format!("--registry={registry}"),
        ])
        .current_dir(node_dir());
        let output = match cmd.output().await {
            Ok(o) => o,
            Err(e) => {
                log::warn!(
                    "[DshManager] npm spawn failed via {registry}: {e}; trying next registry"
                );
                errors.push(format!("{registry}: {e}"));
                continue;
            }
        };
        if output.status.success() {
            log::info!("[DshManager] dsh installed ({DSH_NPM_SPEC}, registry: {registry})");
            return Ok(());
        }
        log::warn!(
            "[DshManager] npm install dsh failed via {registry}: {}; trying next registry",
            String::from_utf8_lossy(&output.stderr)
        );
        errors.push(format!(
            "{registry}: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Err(format!(
        "npm install dsh failed on all registries ({}): {}",
        NPM_REGISTRY_FALLBACKS.len(),
        errors.join(" | ")
    ))
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

    // P2 能力吸纳：官方可选能力 bundle 逐项补齐（升级老 profile 时幂等修复）
    const REQUIRED_BUNDLES: &[&str] = &["@deepseek-ai/dsh-web-app"];
    let bundles_ok = manifest
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array())
        .is_some_and(|arr| {
            REQUIRED_BUNDLES
                .iter()
                .all(|b| arr.iter().any(|v| v.as_str() == Some(b)))
        });
    let missing_required: Vec<&str> = {
        let present = manifest
            .get("dsh")
            .and_then(|d| d.get("profile"))
            .and_then(|p| p.get("bundles"))
            .and_then(|b| b.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .collect::<std::collections::HashSet<_>>()
            })
            .unwrap_or_default();
        REQUIRED_BUNDLES
            .iter()
            .copied()
            .filter(|b| !present.contains(b))
            .collect()
    };
    let mut need_write = !manifest_path.exists() || !bundles_ok || !missing_required.is_empty();
    if !missing_required.is_empty() {
        // 只补缺失项（保留既有 bundle 如 ai-bridge），不重写整个数组
        let mut bundles: Vec<serde_json::Value> = manifest
            .get("dsh")
            .and_then(|d| d.get("profile"))
            .and_then(|p| p.get("bundles"))
            .and_then(|b| b.as_array())
            .cloned()
            .unwrap_or_default();
        for b in &missing_required {
            bundles.push(serde_json::json!(b));
        }
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

    // c：预装随客户端分发的插件（link 本地插件目录；ensure_profile 每次启动
    // 幂等跑，未声明的插件会自动补装——存量安装升级后无需重装环境）
    for (sub_dir, pkg_name) in BUNDLED_PLUGINS {
        let plugin_dir = bundled_plugin_dir(sub_dir)
            .ok_or_else(|| format!("{sub_dir} plugin directory not found (bundled or dev)"))?;
        let deps_declared = manifest
            .get("dependencies")
            .and_then(|d| d.as_object())
            .is_some_and(|d| d.contains_key(*pkg_name));
        if !deps_declared {
            let dsh = dsh_cmd();
            let mut cmd = process_manager::create_tokio_command(&dsh);
            cmd.args(["plugin", "--profile"])
                .arg(dsh_profile())
                .args(["add", &plugin_dir.to_string_lossy()])
                .env("DSH_HOME", dsh_home())
                .env("PATH", prepend_path(node_dir()));
            let output = cmd
                .output()
                .await
                .map_err(|e| format!("dsh spawn failed: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "dsh plugin add ({pkg_name}) failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }
    }

    log::info!(
        "[DshManager] profile {} ready at {}",
        dsh_profile(),
        dir.display()
    );
    ensure_orchestration_patch().await?;
    Ok(())
}

fn default_profile_manifest() -> serde_json::Value {
    serde_json::json!({
        "name": format!("dsh-profile-{}", dsh_profile()),
        "private": true,
        "dependencies": {},
        "dsh": { "profile": { "bundles": [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
        ]}}
    })
}

/// 确保 DSH_HOME/settings.yaml 的默认模型指向 Ai00-X 网关远端（ai00-x/ai00-salvo）。
///
/// 编排架构约定：主会话（含 plan 模式——plan 跟随会话模型）一律远端强模型；
/// 本地 RWKV 只服务子代理智能路由（research_worker 经 ai00-auto 由网关分流）。
/// - 无 agent-default-model 键 → 写入默认；
/// - 已有键且为 ai00-auto / rwkv-local → 一次性迁移到 ai00-salvo（2026-09
///   编排改造：此前默认 ai00-auto，存量安装可能停留在旧默认或用户手选本地）；
/// - 其他值（用户明确选择的远端子模型等）→ 尊重不动。
async fn ensure_default_model_setting() -> Result<(), String> {
    const REMOTE_ENTRY: &str = "agent-default-model:\n  provider: ai00-x\n  model: ai00-salvo\n";
    let path = dsh_home().join("settings.yaml");
    let raw = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    if !raw.contains("agent-default-model") {
        let next = if raw.trim().is_empty() {
            REMOTE_ENTRY.to_string()
        } else {
            format!("{raw}\n{REMOTE_ENTRY}")
        };
        std::fs::create_dir_all(dsh_home()).map_err(|e| e.to_string())?;
        return std::fs::write(&path, next).map_err(|e| format!("write settings failed: {e}"));
    }
    // 旧默认/本地默认 → 远端（逐行解析：只命中 agent-default-model 块内的
    // model 行，不依赖精确缩进与尾换行——文件末尾无换行的存量文件也能迁移）
    let mut in_default_block = false;
    let mut changed = false;
    let lines: Vec<String> = raw
        .split('\n')
        .map(|line| {
            let trimmed = line.trim_end();
            if trimmed.starts_with("agent-default-model:") {
                in_default_block = true;
                return line.to_string();
            }
            // 新的顶层键开始 → 离开 agent-default-model 块
            if in_default_block && !trimmed.is_empty() && !trimmed.starts_with([' ', '#']) {
                in_default_block = false;
            }
            if in_default_block
                && trimmed.trim_start().starts_with("model:")
                && (trimmed.ends_with("ai00-auto") || trimmed.ends_with("rwkv-local"))
            {
                changed = true;
                let indent = &line[..line.len() - line.trim_start().len()];
                return format!("{indent}model: ai00-salvo");
            }
            line.to_string()
        })
        .collect();
    if changed {
        let migrated = lines.join("\n");
        std::fs::write(&path, &migrated).map_err(|e| format!("write settings failed: {e}"))?;
        log::info!("[DshManager] agent-default-model migrated to ai00-salvo (remote)");
    }
    Ok(())
}

/// 编排架构 patch 层（profile cordis.patch.yml，客户端托管，整文件幂等覆写）：
/// 主对话 = 规划者（persona 软约束：只规划+并发派发，不直接调工具）；
/// 子代理 = 两类工人实例（同包 @deepseek-ai/dsh-tool-subagent 多行，
/// 各自 toolName + toolFilter + agentOptions.model 硬约束）。
///
/// persona 挂点：覆盖 system-prompt 行的 config.persona（deployment persona
/// 槽）。不能另插 @deepseek-ai/dsh-persona 行——"deployment:persona" 槽
/// 全局唯一，重复注册 boot 即崩（2026-09-11 实测，症状=sidecar 起不来、
/// dsh-api 全 502）。
///
/// 模型分工（与 ai_gateway.rs 白名单同源约定，见 LOCAL_TOOL_WHITELIST 注释）：
/// - research_worker：只读六件套 + model=ai00-auto → 网关 SmartRouter/
///   hybrid_tool_loop 判后 R0/R1 走本地 RWKV（零成本），本地失败自动远端；
/// - code_worker：执行类工具 + model=ai00-salvo → 远端强模型。
///
/// 工具名为 dsh 引擎注册名（dsh-tool-fs: read/read_image/edit/write、
/// dsh-tool-fs-search: glob/grep、dsh-tool-pwsh: pwsh、dsh-tool-bash: bash、
/// dsh-tool-skill: skill、dsh-tool-todo: todo_write、dsh-tool-web:
/// web_fetch/web_search）。改动组合后用
/// `dsh --profile ai00x --dump-config` 验证（DSH_HOME 指向 dsh_home()）。
/// 组合行为 boot 时装配——本文件变更需 sidecar 重启生效。
///
/// 动态段（每次启动重算，内容变化即覆写 patch）：
/// - skill-filesystem 覆盖行：bundledSkillDir 指向 <DSH_HOME>/bundled-skills
///   （桌面端启动时从内嵌资源同步内置技能，见 desktop skill_api）；
/// - MCP 桥接行：已启用的 MCP server 逐一生成 dsh-mcp-client 配置
///   （工具以 mcp__<server>__<tool> 注入 loop；改 MCP 配置需重启引擎生效）。
async fn ensure_orchestration_patch() -> Result<(), String> {
    // 独立宿主覆盖（营销中心等）：AI00X_DSH_PATCH 指向自备 cordis.patch.yml，
    // 整文件幂等覆写 profile patch——不套用桌面端编排架构（子代理路由面向
    // 桌面网关，独立宿主无此依赖）。
    if let Ok(path) = std::env::var("AI00X_DSH_PATCH") {
        if !path.is_empty() {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("读取 AI00X_DSH_PATCH（{path}）失败: {e}"))?;
            let target = profile_dir().join("cordis.patch.yml");
            std::fs::write(&target, content).map_err(|e| format!("写 profile patch 失败: {e}"))?;
            log::info!("[DshManager] profile patch overridden by AI00X_DSH_PATCH ({path})");
            return Ok(());
        }
    }
    let orchestration_head: &str = load_patch_asset("orchestration-head.patch.yml")?;
    let bundled_dir = dsh_home().join("bundled-skills");
    let bundled_display = bundled_dir.to_string_lossy().replace('\\', "/");

    // 动态段：帮手定义（<DSH_HOME>/agent-workers/*.md）+ Claude Code 兼容
    // hooks 桥挂载 + MCP 桥接行，全部走 insert 列表。
    let worker_defs = ensure_workers_seeded().await;
    let worker_rows = build_worker_rows(&worker_defs);
    let worker_names = if worker_defs.is_empty() {
        "（无可用帮手，请检查 agent-workers 目录）".to_string()
    } else {
        worker_defs
            .iter()
            .map(|w| w.tool_name.as_str())
            .collect::<Vec<_>>()
            .join(" / ")
    };
    let hooks_row = build_hooks_patch_row()?;
    let capability_rows = load_patch_asset("capability-rows.yml.tmpl")?;
    let mcp_rows = build_mcp_patch_rows().await?;

    let head = orchestration_head
        .replace("{BUNDLED_SKILLS_DIR}", &bundled_display)
        .replace("{WORKER_NAMES}", &worker_names);
    let insert_body = format!("{capability_rows}{hooks_row}{worker_rows}{mcp_rows}");
    let content = if insert_body.is_empty() {
        head
    } else {
        format!("{head}- insert:\n{insert_body}")
    };
    let file = profile_dir().join("cordis.patch.yml");
    let need_write = match std::fs::read_to_string(&file) {
        Ok(existing) => existing != content,
        Err(_) => true,
    };
    if need_write {
        std::fs::create_dir_all(profile_dir()).map_err(|e| format!("mkdir profile: {e}"))?;
        std::fs::write(&file, content).map_err(|e| format!("write orchestration patch: {e}"))?;
        log::info!("[DshManager] orchestration patch written/updated");
    }
    Ok(())
}

/// 从 DSH_NPM_SPEC 提取纯版本号（"@deepseek-ai/dsh@0.2.0-rc.2" → "0.2.0-rc.2"）。
pub(crate) fn dsh_version() -> Result<&'static str, String> {
    DSH_NPM_SPEC
        .rsplit('@')
        .next()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("无法从 DSH_NPM_SPEC 解析版本: {DSH_NPM_SPEC}"))
}

/// 按引擎版本加载版本限定 patch 资产（`patches/<引擎版本>/<file>`，
/// 编译期内嵌）。版本目录缺失 = 显式报错、不静默回退——升级引擎版本时
/// 必须新建 `patches/<新版本>/` 目录、对照上游变更逐行核对后重建
/// （纪律与模板说明见各版本目录内 INTENT.md）。
fn load_patch_asset(file: &str) -> Result<&'static str, String> {
    let version = dsh_version()?;
    match (version, file) {
        ("0.2.0-rc.2", "orchestration-head.patch.yml") => Ok(include_str!(
            "../patches/0.2.0-rc.2/orchestration-head.patch.yml"
        )),
        ("0.2.0-rc.2", "hooks-row.yml.tmpl") => {
            Ok(include_str!("../patches/0.2.0-rc.2/hooks-row.yml.tmpl"))
        }
        ("0.2.0-rc.2", "mcp-row.yml.tmpl") => {
            Ok(include_str!("../patches/0.2.0-rc.2/mcp-row.yml.tmpl"))
        }
        ("0.2.0-rc.2", "capability-rows.yml.tmpl") => Ok(include_str!(
            "../patches/0.2.0-rc.2/capability-rows.yml.tmpl"
        )),
        (v, f) => Err(format!(
            "patch 资产缺失: agent-host/patches/{v}/{f}——引擎版本 {v} 尚无版本限定 \
             patch 目录；请复制最接近版本目录、对照上游变更逐行核对后重建（见 INTENT.md）"
        )),
    }
}

// ---------------------------------------------------------------------------
// 帮手（worker）定义：数据驱动编排
// ---------------------------------------------------------------------------

/// 帮手定义文件目录：`<DSH_HOME>/agent-workers/*.md`。
/// 格式：YAML frontmatter（name/description/model/background/tools）+ 正文 persona。
/// 首次运行播种默认两个（research_worker / code_worker），用户可改可增；
/// 全部非法/删空时回退内嵌默认（空编排无法派发，兜底）。
fn workers_dir() -> PathBuf {
    dsh_home().join("agent-workers")
}

#[derive(Debug, Clone)]
struct WorkerDef {
    tool_name: String,
    description: String,
    model: String,
    background: String,
    tools: Vec<String>,
    persona: String,
    file_name: String,
}

const DEFAULT_WORKER_RESEARCH_MD: &str = r#"---
name: research_worker
description: 只读调研帮手：读文件、搜索、网络查证（智能路由，低成本）
model: ai00-auto
background: continuable
tools:
  - read
  - read_image
  - glob
  - grep
  - web_fetch
  - web_search
---
You are a research worker dispatched by the Ai00-X orchestrator.
只做只读调查（读文件 / 搜索 / 网络查证），不修改任何文件、不运行命令。
严格按任务边界工作，完成后返回精炼结论 + 证据位置（文件:行号或 URL）。
"#;

const DEFAULT_WORKER_CODE_MD: &str = r#"---
name: code_worker
description: 执行帮手：写码、改文件、跑命令、产出交付物（远端强模型）
model: ai00-salvo
background: continuable
tools:
  - read
  - read_image
  - glob
  - grep
  - edit
  - write
  - bash
  - pwsh
  - skill
  - todo_write
  - web_fetch
  - web_search
---
You are a code worker dispatched by the Ai00-X orchestrator.
只实现被派发的任务，不扩大范围；需要的事实自己去读。完成后报告：
改了什么、如何验证、遗留风险。
"#;

/// 解析 worker 定义 md；name 非法或缺 persona 视为无效。
fn parse_worker_md(file_name: &str, content: &str) -> Option<WorkerDef> {
    let trimmed = content.trim_start();
    let rest = trimmed.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let (frontmatter, body) = (&rest[..end], rest[end + 4..].trim());

    let mut name = None;
    let mut description = String::new();
    let mut model = "ai00-auto".to_string();
    let mut background = "continuable".to_string();
    let mut tools: Vec<String> = Vec::new();
    let mut in_tools = false;
    for line in frontmatter.lines() {
        let trimmed_line = line.trim();
        if trimmed_line.starts_with("- ") && in_tools {
            let tool = trimmed_line[2..].trim().to_string();
            if !tool.is_empty() {
                tools.push(tool);
            }
            continue;
        }
        in_tools = false;
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "name" if !value.is_empty() => name = Some(value.to_string()),
            "description" => description = value.to_string(),
            "model" if !value.is_empty() => model = value.to_string(),
            "background" if !value.is_empty() => background = value.to_string(),
            "tools" => in_tools = true,
            _ => {}
        }
    }
    let tool_name = name?;
    let valid = !tool_name.is_empty()
        && tool_name.len() <= 64
        && tool_name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if !valid || body.is_empty() {
        return None;
    }
    Some(WorkerDef {
        tool_name,
        description,
        model,
        background,
        tools,
        persona: body.to_string(),
        file_name: file_name.to_string(),
    })
}

/// 首次运行播种默认定义；随后加载目录内全部有效定义。
/// 目录被删空/全非法 → 回退内嵌默认（编排不允许空帮手集）。
async fn ensure_workers_seeded() -> Vec<WorkerDef> {
    let dir = workers_dir();
    if !dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::warn!("[DshManager] create agent-workers dir failed: {e}");
            return fallback_worker_defs();
        }
    }
    for (file, content) in [
        ("research_worker.md", DEFAULT_WORKER_RESEARCH_MD),
        ("code_worker.md", DEFAULT_WORKER_CODE_MD),
    ] {
        let path = dir.join(file);
        if !path.exists() {
            if let Err(e) = std::fs::write(&path, content) {
                log::warn!("[DshManager] seed default worker {file} failed: {e}");
            }
        }
    }

    let mut defs = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return fallback_worker_defs();
    };
    let mut file_names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.to_lowercase().ends_with(".md"))
        .collect();
    file_names.sort();
    for file_name in file_names {
        match std::fs::read_to_string(dir.join(&file_name)) {
            Ok(content) => match parse_worker_md(&file_name, &content) {
                Some(def) => defs.push(def),
                None => log::warn!("[DshManager] invalid worker definition skipped: {file_name}"),
            },
            Err(e) => log::warn!("[DshManager] read worker {file_name} failed: {e}"),
        }
    }
    if defs.is_empty() {
        log::warn!("[DshManager] no valid worker definitions; falling back to built-in defaults");
        return fallback_worker_defs();
    }
    defs
}

/// 内嵌默认（目录不可用/删空时的兜底，行为与旧硬编码编排一致）。
fn fallback_worker_defs() -> Vec<WorkerDef> {
    [
        ("research_worker.md", DEFAULT_WORKER_RESEARCH_MD),
        ("code_worker.md", DEFAULT_WORKER_CODE_MD),
    ]
    .iter()
    .filter_map(|(file, content)| parse_worker_md(file, content))
    .collect()
}

/// 帮手定义 → dsh-tool-subagent 编排行（insert 列表层级，YAML）。
fn build_worker_rows(defs: &[WorkerDef]) -> String {
    let mut rows = String::new();
    for def in defs {
        let id_suffix: String = def
            .tool_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        rows.push_str(&format!(
            "    - id: tool-subagent-{id_suffix}\n      name: '@deepseek-ai/dsh-tool-subagent'\n      config:\n        provider: spawn\n        toolName: {}\n        backgroundMode: {}\n        agentOptions:\n          provider: ai00-x\n          model: {}\n",
            yaml_quote(&def.tool_name),
            yaml_quote(&def.background),
            yaml_quote(&def.model),
        ));
        if !def.tools.is_empty() {
            rows.push_str("        toolFilter:\n          allow:\n");
            for tool in &def.tools {
                rows.push_str(&format!("            - {}\n", yaml_quote(tool)));
            }
        }
        rows.push_str("        persona: |-\n");
        for line in def.persona.lines() {
            if line.trim().is_empty() {
                rows.push('\n');
            } else {
                rows.push_str(&format!("          {line}\n"));
            }
        }
    }
    rows
}

/// Claude Code 兼容 hooks 桥挂载行（configPath 指向 <DSH_HOME>/hooks.json）。
/// 行模板为版本限定资产（patches/<版本>/hooks-row.yml.tmpl）。
/// 配置缺失/解析失败时桥安全退化（告警 + 不挂任何 hook，agent 照常运行）；
/// 配置在引擎启动时读一次，改 hooks.json 需重启引擎。
fn build_hooks_patch_row() -> Result<String, String> {
    let hooks_path = dsh_home().join("hooks.json");
    let display = hooks_path.to_string_lossy().replace('\\', "/");
    let tmpl = load_patch_asset("hooks-row.yml.tmpl")?;
    Ok(tmpl.replace("{CONFIG_PATH}", &yaml_quote(&display)))
}

/// 把配置服务里已启用的 MCP server 生成为 dsh-mcp-client 编排补丁行（YAML，
/// 预缩进到 insert 列表层级）。
///
/// 引擎只桥接 tools（`mcp__<server>__<tool>`，与 Claude Code/Codex 同形命名）；
/// resources/prompts 不进 loop（引擎 0.1.5 明确 deferred），管理界面能力不受影响。
/// sse 传输引擎不支持，跳过并记日志。
async fn build_mcp_patch_rows() -> Result<String, String> {
    let config_service = match ai00_x_core::service::config::get_global_config_service() {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[DshManager] global config unavailable, skip MCP bridge rows: {e}");
            return Ok(String::new());
        }
    };
    let mcp_config = match ai00_x_core::service::mcp::MCPConfigService::new(config_service) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[DshManager] MCP config service init failed, skip MCP bridge rows: {e}");
            return Ok(String::new());
        }
    };
    let servers = mcp_config.load_all_configs().await.unwrap_or_else(|e| {
        log::warn!("[DshManager] load MCP configs failed, skip MCP bridge rows: {e}");
        Vec::new()
    });

    let mut rows = String::new();
    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for server in servers {
        if !server.enabled || !server.auto_start {
            continue;
        }
        let transport = server.resolved_transport();
        if matches!(
            transport,
            ai00_x_core::service::mcp::server::MCPServerTransport::Sse
        ) {
            log::warn!(
                "[DshManager] MCP server '{}' uses sse transport, unsupported by engine bridge; skipped",
                server.id
            );
            continue;
        }
        // 引擎 serverName 契约：[A-Za-z0-9_-]{1,32}，scope 内唯一
        let server_name: String = server
            .id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .take(32)
            .collect();
        if server_name.is_empty() || !used_names.insert(server_name.clone()) {
            log::warn!(
                "[DshManager] MCP server '{}' id sanitizes to empty/duplicate engine name; skipped",
                server.id
            );
            continue;
        }
        // 行骨架走版本限定模板；transport 体按配置生成（8 空格缩进）。
        let mut transport_body = String::new();
        match transport {
            ai00_x_core::service::mcp::server::MCPServerTransport::Stdio => {
                let Some(command) = server.command.as_deref().filter(|c| !c.is_empty()) else {
                    log::warn!(
                        "[DshManager] MCP server '{}' has no command for stdio; skipped",
                        server.id
                    );
                    continue;
                };
                transport_body.push_str(&format!(
                    "        transport: stdio\n        command: {}",
                    yaml_quote(command)
                ));
                if !server.args.is_empty() {
                    transport_body.push_str("\n        args:");
                    for arg in &server.args {
                        transport_body.push_str(&format!("\n          - {}", yaml_quote(arg)));
                    }
                }
                if !server.env.is_empty() {
                    transport_body.push_str("\n        env:");
                    let mut env: Vec<(&String, &String)> = server.env.iter().collect();
                    env.sort_by(|a, b| a.0.cmp(b.0));
                    for (key, value) in env {
                        transport_body.push_str(&format!(
                            "\n          {}: {}",
                            yaml_quote(key),
                            yaml_quote(value)
                        ));
                    }
                }
            }
            _ => {
                let Some(url) = server.url.as_deref().filter(|u| !u.is_empty()) else {
                    log::warn!(
                        "[DshManager] MCP server '{}' has no url for remote transport; skipped",
                        server.id
                    );
                    continue;
                };
                transport_body.push_str(&format!(
                    "        transport: streamable-http\n        url: {}",
                    yaml_quote(url)
                ));
                if !server.headers.is_empty() {
                    transport_body.push_str("\n        headers:");
                    let mut headers: Vec<(&String, &String)> = server.headers.iter().collect();
                    headers.sort_by(|a, b| a.0.cmp(b.0));
                    for (key, value) in headers {
                        transport_body.push_str(&format!(
                            "\n          {}: {}",
                            yaml_quote(key),
                            yaml_quote(value)
                        ));
                    }
                }
            }
        }
        let tmpl = load_patch_asset("mcp-row.yml.tmpl")?;
        rows.push_str(
            &tmpl
                .replace("{SERVER_NAME}", &server_name)
                .replace("{TRANSPORT_BODY}", &transport_body),
        );
    }
    Ok(rows)
}

/// 输出为 YAML 双引号标量（转义反斜杠与双引号；配置值不含换行）。
fn yaml_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
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

    // 环境保障（幂等，已装则秒回）；失败发事件供前端引导「从 checkpoint 恢复」
    if let Err(e) = ensure_environment().await {
        if let Some(app) = app_handle() {
            let _ = tauri::Emitter::emit(
                &app,
                "dsh://env-install-failed",
                serde_json::json!({ "error": e }),
            );
        }
        return Err(e);
    }

    mgr.set_phase(DshPhase::Installing {
        stage: "starting engine".into(),
    });

    spawn_sidecar().await?;

    // 健康等待：0.1.5 鉴权链——stdout 捕获 token → GET /?token= 换签名 cookie
    // （无 Origin + cookie = 信任栅栏放行）→ POST /api/settings/describe 探活
    // （host.describe 已在 0.1.5 移除）。
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut warned_no_token = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            let err = "dsh sidecar health check timed out".to_string();
            mgr.set_phase(DshPhase::Failed { error: err.clone() });
            return Err(err);
        }
        if mgr.auth_token.lock().await.is_none() {
            if !warned_no_token {
                warned_no_token = true;
                log::info!("[DshManager] waiting for launch token on sidecar stdout");
            }
            tokio::time::sleep(Duration::from_millis(800)).await;
            continue;
        }
        // token → cookie（每轮重试直到成功；引擎未监听时 GET 会失败）
        let needs_exchange = mgr.auth_cookie.lock().await.is_none();
        if needs_exchange {
            let token = mgr.auth_token.lock().await.clone().unwrap_or_default();
            match exchange_auth_cookie(&token).await {
                Ok(cookie) => {
                    log::info!("[DshManager] auth cookie exchanged from launch token");
                    *mgr.auth_cookie.lock().await = Some(cookie);
                }
                Err(e) => {
                    log::info!("[DshManager] auth cookie exchange pending: {e}");
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    continue;
                }
            }
        }
        let cookie = mgr.auth_cookie.lock().await.clone();
        if let Some(cookie) = cookie {
            let probe = serde_json::json!({
                "type": "client-request",
                "rpcId": format!("health-{}", std::process::id()),
                "method": "settings/describe",
                "payload": { "args": {} }
            });
            if let Ok(resp) = ai00_x_core::util::local_http_client()
                .post(format!(
                    "http://127.0.0.1:{}/api/settings/describe",
                    dsh_port()
                ))
                .header("content-type", "application/json")
                .header(reqwest::header::COOKIE, &cookie)
                .json(&probe)
                .timeout(Duration::from_secs(3))
                .send()
                .await
            {
                if resp.status().is_success() {
                    mgr.set_phase(DshPhase::Running { port: dsh_port() });
                    monitor_restart();
                    // P1-B：健康启动后轮转写 checkpoint（失败仅告警，绝不影响启动结果）
                    tokio::spawn(async {
                        if let Err(e) = crate::checkpoint::snapshot_if_changed().await {
                            log::warn!("[checkpoint] snapshot failed: {e}");
                        }
                    });
                    return Ok(());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
}

/// 0.1.5 鉴权：用一次性启动 token 换签名会话 cookie。
/// `?token=` 只在 `GET /` 接受，303 → Set-Cookie（authority-bound，
/// Host/Origin 栅栏在无 Origin 的服务端转发场景下直接放行）。
async fn exchange_auth_cookie(token: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        // 回环目标绝不能走系统代理（同 dsh_proxy 教训）
        .no_proxy()
        .build()
        .map_err(|e| format!("http client build failed: {e}"))?;
    let resp = client
        .get(format!("http://127.0.0.1:{}/?token={token}", dsh_port()))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("token exchange GET failed: {e}"))?;
    for value in resp.headers().get_all(reqwest::header::SET_COOKIE) {
        let Ok(s) = value.to_str() else {
            continue;
        };
        let pair = s.split(';').next().unwrap_or_default();
        if pair.starts_with("dsh-auth-") {
            return Ok(pair.to_string());
        }
    }
    Err(format!(
        "no dsh-auth cookie in token exchange response (status {})",
        resp.status()
    ))
}

/// 用户主动停止（不自动重启）。
/// checkpoint 恢复命令串行化用（与 dsh_restart 同锁）。
pub(crate) async fn restart_lock_guard() -> tokio::sync::MutexGuard<'static, ()> {
    get().restart_lock.lock().await
}

pub async fn stop() -> Result<(), String> {
    let mgr = get();
    mgr.stopped_by_user
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let mut child = mgr.child.lock().await;
    if let Some(mut c) = child.take() {
        let _ = c.kill().await;
    }
    // 清理鉴权状态：下次 start 重新捕获 token + 交换 cookie
    *mgr.auth_token.lock().await = None;
    *mgr.auth_cookie.lock().await = None;
    mgr.set_phase(DshPhase::Ready);
    Ok(())
}

/// dsh_proxy 转发时注入的签名会话 cookie（0.1.5 鉴权）。
/// 返回 `"dsh-auth-<host>=<value>"` 或 None（引擎未就绪）。
pub fn auth_cookie() -> Option<String> {
    let mgr = get();
    mgr.auth_cookie.try_lock().ok().and_then(|g| g.clone())
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
        .arg("--profile")
        .arg(dsh_profile())
        .args(["--no-open", "--host", "127.0.0.1"])
        .arg("--port")
        .arg(dsh_port().to_string())
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
    if let Some(mode) = permission_mode() {
        cmd.env("DSH_PERMISSION_MODE", mode);
    }
    // P2 隐私对齐：引擎会话遥测默认 FEEDBACK_ONLY（用户点反馈即上传会话前缀到
    // 官方收集器 dsh-otel-collector.deepseeksvc.com），与本地优先立场冲突 → DISABLED。
    // 产品遥测（host-product-telemetry）因 profile 名非 desktop 已自动关闭。
    cmd.env("DSH_TELEMETRY_MODE", "DISABLED");

    // stdout/stderr 管道转发到日志（CREATE_NO_WINDOW 由 process_manager 处理）
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("dsh spawn failed: {e}"))?;
    log::info!(
        "[DshManager] sidecar spawned: pid={:?} port={}",
        child.id(),
        dsh_port()
    );

    // 日志泵（stderr → log + 插件错误事件；stdout 排水防管道阻塞）
    if let Some(stderr) = child.stderr.take() {
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
                            log::info!("[dsh] {l}");
                            // 插件树/插件行加载失败：显性化到前端（否则静默白屏，
                            // 真实原因只在 app.log 的 [dsh] 行里）。
                            // 归因升级：`failed to apply loader entry <module>` 提取模块名，
                            // 前端据此提示「疑似插件 X 导致」+ 一键停用。
                            if l.contains("plugin tree failed to load")
                                || l.contains("failed to apply loader entry")
                            {
                                let module = l
                                    .split("failed to apply loader entry")
                                    .nth(1)
                                    .map(|rest| {
                                        rest.split_whitespace().next().unwrap_or("").to_string()
                                    })
                                    .filter(|m| !m.is_empty());
                                if let Some(app) = app_handle() {
                                    let _ = tauri::Emitter::emit(
                                        &app,
                                        "dsh://plugin-error",
                                        serde_json::json!({
                                            "module": module,
                                            "raw": l.trim(),
                                        }),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        });
    }
    // stdout 行泵：解析一次性启动 token（0.1.5 鉴权）。行格式：
    // `dsh web: http://127.0.0.1:3210/?token=<TOKEN>`（早于 /api 就绪打印）
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mgr = get();
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(idx) = line.find("?token=") {
                    // 截到空白/右括号为止：0.1.5 还会打 LAN 行尾
                    // `...?token=X (LAN: http://...?token=Y)`，不能整行捕获
                    let rest = &line[idx + "?token=".len()..];
                    let end = rest
                        .find(|c: char| c.is_whitespace() || c == ')')
                        .unwrap_or(rest.len());
                    let token = rest[..end].to_string();
                    if !token.is_empty() {
                        log::info!("[DshManager] captured launch token from stdout");
                        *mgr.auth_token.lock().await = Some(token);
                    }
                } else if !line.trim().is_empty() {
                    log::info!("[dsh] {line}");
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
// 插件管理（Phase 4.3：profile manifest 层 + 装卸）
// ---------------------------------------------------------------------------

/// 已安装插件（profile dependencies 层，可装卸的 bundle 级插件）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshPluginEntry {
    pub name: String,
    /// 依赖声明（版本号或 link: 路径）。
    pub spec: String,
    /// 是否在 profile bundles 里（dsh 会实际加载）。
    pub in_bundles: bool,
    /// 随客户端分发（不可卸载）。
    pub bundled: bool,
}

/// 读 profile manifest → 已装插件列表。
fn read_profile_plugins() -> Result<(Vec<DshPluginEntry>, serde_json::Value), String> {
    let manifest_path = profile_dir().join("package.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read profile manifest: {e}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse profile manifest: {e}"))?;
    let bundles: Vec<String> = manifest
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let mut entries: Vec<DshPluginEntry> = manifest
        .get("dependencies")
        .and_then(|d| d.as_object())
        .map(|deps| {
            deps.iter()
                .map(|(name, spec)| DshPluginEntry {
                    name: name.clone(),
                    spec: spec.as_str().unwrap_or("").to_string(),
                    in_bundles: bundles.contains(name),
                    bundled: BUNDLED_PLUGINS.iter().any(|(_, pkg)| pkg == name),
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((entries, manifest))
}

/// manifest 写回（原子）。
fn write_profile_manifest(manifest: &serde_json::Value) -> Result<(), String> {
    let path = profile_dir().join("package.json");
    let content =
        serde_json::to_string_pretty(manifest).map_err(|e| format!("serialize manifest: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("write manifest: {e}"))
}

/// 执行 `dsh plugin --profile ai00x <args...>`。
async fn dsh_plugin_cmd(args: &[&str]) -> Result<String, String> {
    let dsh = dsh_cmd();
    let mut cmd = process_manager::create_tokio_command(&dsh);
    cmd.arg("plugin")
        .arg("--profile")
        .arg(dsh_profile())
        .args(args)
        .env("DSH_HOME", dsh_home())
        .env("PATH", prepend_path(node_dir()))
        .current_dir(profile_dir());
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("dsh spawn failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "dsh plugin {} failed: {stderr}",
            args.first().unwrap_or(&"")
        ));
    }
    Ok(stdout)
}

/// 装卸后重启引擎（插件树只在 boot 时装载）。
///
/// 串行化：stop 立即执行；start 在 restart_lock 内的后台任务里跑——
/// 并发装卸各自触发的重启被合并（后到者见 Running 幂等返回），
/// 全程经 `dsh://phase` 广播 restarting 阶段给前端横幅。
async fn restart_engine_for_plugins() {
    let mgr = get();
    mgr.set_phase(DshPhase::Installing {
        stage: "restarting engine".into(),
    });
    if let Err(e) = stop().await {
        log::warn!("[DshManager] stop before plugin restart failed: {e}");
    }
    tokio::spawn(async {
        let _guard = get().restart_lock.lock().await;
        if let Err(e) = start().await {
            log::error!("[DshManager] restart after plugin change failed: {e}");
        }
    });
}

#[tauri::command]
pub async fn dsh_plugins_list() -> Result<Vec<DshPluginEntry>, String> {
    let (entries, _) = read_profile_plugins()?;
    Ok(entries)
}

/// 卸载插件（内置拒绝；pnpm remove + bundles 同步清理 + 引擎重启）。
#[tauri::command]
pub async fn dsh_plugin_remove(name: String) -> Result<(), String> {
    let (entries, mut manifest) = read_profile_plugins()?;
    let entry = entries
        .iter()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("plugin not installed: {name}"))?;
    if entry.bundled {
        return Err("bundled plugins cannot be removed".into());
    }
    // bundles 数组同步清理（否则 pnpm remove 后 manifest 仍引用 → 树加载失败）
    if let Some(arr) = manifest
        .get_mut("dsh")
        .and_then(|d| d.get_mut("profile"))
        .and_then(|p| p.get_mut("bundles"))
        .and_then(|b| b.as_array_mut())
    {
        arr.retain(|v| v.as_str() != Some(name.as_str()));
    }
    write_profile_manifest(&manifest)?;
    dsh_plugin_cmd(&["remove", &name]).await?;
    restart_engine_for_plugins().await;
    Ok(())
}

/// 停用/启用插件（编辑 bundles 数组；依赖保留在 dependencies，装过的包不卸）。
/// 引擎只在 boot 时装载插件树，改完必须重启。
#[tauri::command]
pub async fn dsh_plugin_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    let (entries, mut manifest) = read_profile_plugins()?;
    if !entries.iter().any(|e| e.name == name) {
        return Err(format!("plugin not installed: {name}"));
    }
    let bundles = manifest
        .get_mut("dsh")
        .and_then(|d| d.get_mut("profile"))
        .and_then(|p| p.get_mut("bundles"))
        .and_then(|b| b.as_array_mut())
        .ok_or("profile manifest has no dsh.profile.bundles")?;
    if enabled {
        if !bundles.iter().any(|v| v.as_str() == Some(name.as_str())) {
            bundles.push(serde_json::json!(name));
        }
    } else {
        bundles.retain(|v| v.as_str() != Some(name.as_str()));
    }
    write_profile_manifest(&manifest)?;
    restart_engine_for_plugins().await;
    Ok(())
}

/// 安装插件（npm spec；装完加入 bundles + 引擎重启）。
#[tauri::command]
pub async fn dsh_plugin_install(spec: String) -> Result<(), String> {
    if spec.trim().is_empty() {
        return Err("empty package spec".into());
    }
    dsh_plugin_cmd(&["add", &spec]).await?;
    // add 后 reconcile 已把带 dsh.bundle 声明的包加入 bundles（ai-bridge 同机制）；
    // manifest 重读校验，未加入则补（防御非 bundle 声明包）
    let (_, mut manifest) = read_profile_plugins()?;
    if let Some(deps) = manifest.get("dependencies").and_then(|d| d.as_object()) {
        // spec 形态可能是 pkg / pkg@ver / @scope/pkg@ver——精确匹配优先，退化 endsWith
        let hit = deps
            .keys()
            .find(|k| k.as_str() == spec.trim())
            .or_else(|| deps.keys().find(|k| spec.trim().starts_with(k.as_str())));
        if let Some(name) = hit {
            let name = name.clone();
            if let Some(arr) = manifest
                .get_mut("dsh")
                .and_then(|d| d.get_mut("profile"))
                .and_then(|p| p.get_mut("bundles"))
                .and_then(|b| b.as_array_mut())
            {
                if !arr.iter().any(|v| v.as_str() == Some(name.as_str())) {
                    arr.push(serde_json::json!(name));
                }
            }
            write_profile_manifest(&manifest)?;
        }
    }
    restart_engine_for_plugins().await;
    Ok(())
}

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

/// 用户手动重启引擎（Failed 态恢复入口：崩溃重试耗尽后 monitor 已退出，
/// 重新走一遍 start 会重建监控循环）。Running 态调用 = 幂等秒回。
#[tauri::command]
pub async fn dsh_restart() -> Result<DshStatus, String> {
    let _guard = get().restart_lock.lock().await;
    start().await?;
    dsh_status().await
}

// ---------------------------------------------------------------------------
// 帮手定义 / hooks 配置管理命令（设置页「Agent 编排」用；改动重启引擎生效）
// ---------------------------------------------------------------------------

fn validate_worker_file_name(file_name: &str) -> Result<(), String> {
    let ok = file_name.to_lowercase().ends_with(".md")
        && !file_name.contains("..")
        && !file_name.contains('/')
        && !file_name.contains('\\')
        && file_name.len() <= 128
        && file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid worker file name: {file_name}"))
    }
}

/// 列出全部帮手定义（种子缺失时顺带播种）。
#[tauri::command]
pub async fn dsh_workers_list() -> Result<Vec<serde_json::Value>, String> {
    let defs = ensure_workers_seeded().await;
    Ok(defs
        .iter()
        .map(|d| {
            serde_json::json!({
                "fileName": d.file_name,
                "name": d.tool_name,
                "description": d.description,
                "model": d.model,
                "background": d.background,
                "tools": d.tools,
            })
        })
        .collect())
}

/// 读单个帮手定义原文（编辑器回填）。
#[tauri::command]
pub async fn dsh_worker_read(file_name: String) -> Result<String, String> {
    validate_worker_file_name(&file_name)?;
    let path = workers_dir().join(&file_name);
    if !path.exists() {
        return Err(format!("worker definition not found: {file_name}"));
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 保存帮手定义（先过解析校验，非法拒绝落盘；重启引擎生效）。
#[tauri::command]
pub async fn dsh_worker_save(file_name: String, content: String) -> Result<(), String> {
    validate_worker_file_name(&file_name)?;
    parse_worker_md(&file_name, &content).ok_or_else(|| {
        "invalid worker definition: check frontmatter (name/description/model/background/tools) and non-empty persona body".to_string()
    })?;
    std::fs::create_dir_all(workers_dir()).map_err(|e| e.to_string())?;
    std::fs::write(workers_dir().join(&file_name), content).map_err(|e| e.to_string())
}

/// 删除帮手定义（删空由加载侧兜底回退内嵌默认；重启引擎生效）。
#[tauri::command]
pub async fn dsh_worker_delete(file_name: String) -> Result<(), String> {
    validate_worker_file_name(&file_name)?;
    let path = workers_dir().join(&file_name);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 读 Claude Code 兼容 hooks 配置（<DSH_HOME>/hooks.json；空串 = 未配置）。
#[tauri::command]
pub async fn dsh_hooks_config_get() -> Result<String, String> {
    let path = dsh_home().join("hooks.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 写 hooks 配置（JSON 对象校验；清空即删除文件 = 关闭 hooks；重启引擎生效）。
#[tauri::command]
pub async fn dsh_hooks_config_set(content: String) -> Result<(), String> {
    let path = dsh_home().join("hooks.json");
    let trimmed = content.trim();
    if trimmed.is_empty() {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("invalid JSON: {e}"))?;
    if !value.is_object() {
        return Err("hooks config must be a JSON object".to_string());
    }
    std::fs::create_dir_all(dsh_home()).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{pretty}\n")).map_err(|e| e.to_string())
}

/// 启动序列入口：后台静默安装并启动（不阻塞主窗口）。
pub fn spawn_bootstrap() {
    tokio::spawn(async {
        if let Err(e) = start().await {
            log::error!("[DshManager] bootstrap failed: {e}");
            // headless 消费方（mkt-agent）只靠轮询 phase 感知结果，
            // 失败必须落 Failed 态，否则轮询方永远停在 Installing 等到超时。
            get().set_phase(DshPhase::Failed { error: e });
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
        // CARGO_MANIFEST_DIR = client/src/crates/agent-host → repo client 根需退三级
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../dsh-plugins/ai-bridge");
        assert!(p.join("package.json").exists(), "expected {}", p.display());
    }

    #[test]
    fn parse_worker_md_defaults_are_valid() {
        let research = parse_worker_md("research_worker.md", DEFAULT_WORKER_RESEARCH_MD)
            .expect("default research worker must parse");
        assert_eq!(research.tool_name, "research_worker");
        assert_eq!(research.model, "ai00-auto");
        assert_eq!(research.background, "continuable");
        assert!(research.tools.contains(&"grep".to_string()));
        assert!(research.persona.contains("research worker"));

        let code = parse_worker_md("code_worker.md", DEFAULT_WORKER_CODE_MD)
            .expect("default code worker must parse");
        assert_eq!(code.model, "ai00-salvo");
        assert!(code.tools.contains(&"edit".to_string()));
    }

    #[test]
    fn parse_worker_md_rejects_invalid() {
        // 缺 name
        assert!(parse_worker_md("a.md", "---\ndescription: x\n---\nbody").is_none());
        // name 含非法字符
        assert!(
            parse_worker_md("b.md", "---\nname: Bad Name\ndescription: x\n---\nbody").is_none()
        );
        // 空 persona
        assert!(parse_worker_md("c.md", "---\nname: ok\n---\n   ").is_none());
    }

    #[test]
    fn worker_rows_are_well_formed_yaml_entries() {
        let defs = fallback_worker_defs();
        let rows = build_worker_rows(&defs);
        assert!(rows.contains("toolName: \"research_worker\""));
        assert!(rows.contains("backgroundMode: \"continuable\""));
        assert!(rows.contains("            - \"read\"\n"));
        // persona block scalar 缩进比键深
        assert!(rows.contains("        persona: |-\n          You are a research worker"));
    }
}
