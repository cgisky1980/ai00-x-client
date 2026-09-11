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
pub(crate) mod dsh_versions_gen;

use dsh_versions_gen::{BUNDLED_PLUGINS, DSH_NPM_SPEC, NODE_VERSION, NPM_REGISTRY};

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
/// 文件也放这里，pub(crate) 供跨模块取同一路径，避免路径逻辑双写漂移）。
pub(crate) fn dsh_home() -> PathBuf {
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

pub(crate) fn app_handle() -> Option<tauri::AppHandle> {
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
                    "dsh plugin add ({pkg_name}) failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }
    }

    log::info!(
        "[DshManager] profile {DSH_PROFILE} ready at {}",
        dir.display()
    );
    ensure_orchestration_patch()?;
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
fn ensure_orchestration_patch() -> Result<(), String> {
    const ORCHESTRATION_PATCH: &str = r#"# Ai00-X 编排架构 patch（dsh_manager::ensure_orchestration_patch 幂等维护，
# 手工改动会被启动覆写；组合预览：dsh --profile ai00x --dump-config）
#
# 编排约定：主对话只规划+并发派发（continuable 后台模式，完成自动通知）；
# research_worker 调研（只读，智能路由），code_worker 执行（远端强模型）。
# 注意：新增条目必须放 insert 列表（顶层裸行 = 按 id 覆盖既有条目）。
# 注意：规划者 persona 走 system-prompt 行覆盖——"deployment:persona" 槽
# 全局唯一，另插 @deepseek-ai/dsh-persona 行会重复注册导致 boot 崩溃
# （已实测）；策窗口 preset 的 per-agent persona 遮蔽不受影响。
- id: system-prompt
  config:
    persona: |-
      You are the Ai00-X orchestrator, powered by the {{model}} model. Your working directory is {{cwd}}.

      你的职责：规划与派发，不亲自执行。
      1. 理解用户意图后先给出简短计划（目标 / 步骤 / 并发分组），然后全部通过子代理执行。
      2. 尽量并发：相互独立的任务放在同一条回复里用 research_worker / code_worker 派发（默认后台运行，完成后会自动通知你）；只有下一步依赖结果时才同步等待。
      3. 每个任务写明六要素：目标与验收标准、边界（不要做什么）、建议用哪些工具、相关文件与上下文线索、期望的返回格式、并发分组。任务要明确、精简、自包含（worker 看不到你们的对话）。
      4. 分工：调研 / 检索 / 读码 / 事实查证 → research_worker；写码 / 改文件 / 跑命令 / 产出交付物 → code_worker。拿不准就用 code_worker。
      5. 你自己不直接调用文件 / 终端 / 网络工具（read、glob、grep、edit、write、bash、pwsh、web_* 等）——需要事实就派 research_worker。
      6. 收齐 worker 结论后向用户交付：结论优先，注明关键依据与未尽事项。执行细节属于 worker，不进入你的答复。

- insert:
    - id: tool-subagent-research
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: research_worker
        backgroundMode: continuable
        agentOptions:
          provider: ai00-x
          model: ai00-auto
        toolFilter:
          allow:
            - read
            - read_image
            - glob
            - grep
            - web_fetch
            - web_search
        persona: |-
          You are a research worker dispatched by the Ai00-X orchestrator.
          只做只读调查（读文件 / 搜索 / 网络查证），不修改任何文件、不运行命令。
          严格按任务边界工作，完成后返回精炼结论 + 证据位置（文件:行号或 URL）。

    - id: tool-subagent-code
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: code_worker
        backgroundMode: continuable
        agentOptions:
          provider: ai00-x
          model: ai00-salvo
        toolFilter:
          allow:
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
        persona: |-
          You are a code worker dispatched by the Ai00-X orchestrator.
          只实现被派发的任务，不扩大范围；需要的事实自己去读。完成后报告：
          改了什么、如何验证、遗留风险。
"#;
    let file = profile_dir().join("cordis.patch.yml");
    let need_write = match std::fs::read_to_string(&file) {
        Ok(existing) => existing != ORCHESTRATION_PATCH,
        Err(_) => true,
    };
    if need_write {
        std::fs::create_dir_all(profile_dir()).map_err(|e| format!("mkdir profile: {e}"))?;
        std::fs::write(&file, ORCHESTRATION_PATCH)
            .map_err(|e| format!("write orchestration patch: {e}"))?;
        log::info!("[DshManager] orchestration patch written/updated");
    }
    Ok(())
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
                .post(format!("http://127.0.0.1:{DSH_PORT}/api/settings/describe"))
                .header("content-type", "application/json")
                .header(reqwest::header::COOKIE, &cookie)
                .json(&probe)
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
        .get(format!("http://127.0.0.1:{DSH_PORT}/?token={token}"))
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
    cmd.args(["plugin", "--profile", DSH_PROFILE])
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

/// 插件 scope 授权条目（grants 文件 + bundled 全量视图）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshPluginGrants {
    pub plugin_id: String,
    pub scopes: Vec<String>,
    /// bundled 插件全量放行（grants 文件不存储）。
    pub bundled: bool,
}

/// 列出插件 scope 授权视图：bundled 插件 = 全 scope；其余来自 grants 文件。
#[tauri::command]
pub async fn dsh_plugin_grants_list() -> Result<Vec<DshPluginGrants>, String> {
    use crate::internal_api::ALL_SCOPES;
    let mut out: Vec<DshPluginGrants> = BUNDLED_PLUGINS
        .iter()
        .map(|(_, pkg)| DshPluginGrants {
            plugin_id: pkg.to_string(),
            scopes: ALL_SCOPES.iter().map(|s| s.to_string()).collect(),
            bundled: true,
        })
        .collect();
    for (plugin_id, scopes) in crate::internal_api::read_grants() {
        if scopes.is_empty() {
            continue;
        }
        out.push(DshPluginGrants {
            plugin_id,
            scopes,
            bundled: false,
        });
    }
    out.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id));
    Ok(out)
}

/// 授予第三方插件一个 scope（授权卡 / 插件设置页）。
#[tauri::command]
pub async fn dsh_plugin_grant(plugin_id: String, scope: String) -> Result<(), String> {
    crate::internal_api::mutate_grant(&plugin_id, &scope, true)
}

/// 回收第三方插件的一个 scope。
#[tauri::command]
pub async fn dsh_plugin_revoke(plugin_id: String, scope: String) -> Result<(), String> {
    crate::internal_api::mutate_grant(&plugin_id, &scope, false)
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
