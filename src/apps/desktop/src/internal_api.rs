//! 宿主内部业务 API：dsh `@ai00-x/tools` 插件回呼宿主业务能力的薄 HTTP 层。
//!
//! 端点（挂本地内嵌 Salvo 2100 的 `/ai00-internal/*`，仅本机监听）：
//! - `POST /ai00-internal/notify`          — 系统通知 `{title, body?}`
//! - `POST /ai00-internal/wallpaper/apply` — 应用壁纸到桌面 `{projectPath, mode?, monitorId?}`
//! - `GET  /ai00-internal/todo`            — 知行数据全量读
//! - `PUT  /ai00-internal/todo`            — 知行数据全量写（原子写；广播 `todo-agent-updated`）
//! - `POST /ai00-internal/todo/task/create` — agent 自主建卡（想法池落卡；广播 `todo-agent-updated`）
//! - `POST /ai00-internal/todo/focus`      — 追加专注记录（RMW + `todo-focus-appended` 事件）
//! - `GET  /ai00-internal/plan?taskId=`    — 读卡片计划文档 MD（?taskId=）
//! - `PUT  /ai00-internal/plan`            — 写卡片计划文档 `{taskId, markdown}`（广播 `todo-plan-updated`）
//! - `POST /ai00-internal/git/snapshot`    — 工作区 git 快照（libgit2）
//! - `POST /ai00-internal/xp`              — XP 事件转发远端（member JWT；服务端按 kind 幂等去重）
//! - `POST /ai00-internal/web/extract`     — web 有效信息提取（全本地闭环：搜索→并发抓取→并发本地筛选）
//! - `POST /ai00-internal/text/summarize`  — 长文总结（全本地闭环：≤6000 单次 / >6000 map-reduce）
//!
//! 鉴权分两层：
//! 1. `X-Ai00-Internal-Token` 头匹配 `AI00_S_INTERNAL_TOKEN`（回退默认值），
//!    与 ai_gateway 同策略。该 token 同时承担远端转发的 CSRF 豁免（fetchWithAuth
//!    / TokenManager / xp 转发），是全局共享密钥，不做插件区分。
//! 2. **插件 scope 层（v1）**：回呼带 `X-Ai00-Plugin-Id` 头标识来源插件。
//!    bundled 插件（dsh_versions_gen::BUNDLED_PLUGINS）→ 全 scope 放行；
//!    已标识的第三方插件 → 按 grants 文件（DSH_HOME/plugin-grants.json）逐 scope 放行，
//!    未授权 403 + `X-Ai00-Required-Scope` 头 + 广播 `dsh://permission-requested`（前端授权卡一键授予）；
//!    未标识请求（历史第三方插件/直连）→ 只放行 BASIC_SCOPES（只读 + 通知），写操作 403 并日志提示接入 Plugin-Id 头。
//!    已知边界：引擎侧插件同进程，恶意插件可省略 Plugin-Id 头拿 BASIC 之外的能力——不能，未标识只拿 BASIC；
//!    伪造 bundled id 可拿全量，这是进程内插件的固有边界（v1 诚实降级，真隔离 = P4 microVM 立项）。
//!
//! 业务逻辑留在既有 Rust 实现（D7：插件是薄壳）。

use std::collections::BTreeMap;
use std::path::PathBuf;

use salvo::http::StatusCode;
use salvo::prelude::*;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use ai00_x_core::infrastructure::ai00_s_internal_token;

use crate::dsh_manager::dsh_versions_gen::BUNDLED_PLUGINS;

const INTERNAL_TOKEN_HEADER: &str = "x-ai00-internal-token";
const PLUGIN_ID_HEADER: &str = "x-ai00-plugin-id";

/// scope 常量（grants 文件与前端授权卡共用同一词表）。
pub const SCOPE_NOTIFY: &str = "notify";
pub const SCOPE_WALLPAPER: &str = "wallpaper";
pub const SCOPE_TODO_READ: &str = "todo:read";
pub const SCOPE_TODO_WRITE: &str = "todo:write";
pub const SCOPE_PLAN_READ: &str = "plan:read";
pub const SCOPE_PLAN_WRITE: &str = "plan:write";
pub const SCOPE_GIT: &str = "git";
pub const SCOPE_XP: &str = "xp";
pub const SCOPE_WEB_EXTRACT: &str = "web:extract";
pub const SCOPE_TEXT_SUMMARIZE: &str = "text:summarize";

/// 全部 scope（dsh_plugin_grants_list / 授权 UI 的词表）。
pub const ALL_SCOPES: &[&str] = &[
    SCOPE_NOTIFY,
    SCOPE_WALLPAPER,
    SCOPE_TODO_READ,
    SCOPE_TODO_WRITE,
    SCOPE_PLAN_READ,
    SCOPE_PLAN_WRITE,
    SCOPE_GIT,
    SCOPE_XP,
    SCOPE_WEB_EXTRACT,
    SCOPE_TEXT_SUMMARIZE,
];

/// 未标识请求（无 Plugin-Id 头）的兜底 scope：只读 + 通知。
/// 写操作（知行写/计划写/git/XP/壁纸）一律 403——历史第三方插件接入
/// Plugin-Id 头 + 授权后恢复。
pub const BASIC_SCOPES: &[&str] = &[
    SCOPE_NOTIFY,
    SCOPE_TODO_READ,
    SCOPE_PLAN_READ,
    SCOPE_WEB_EXTRACT,
    SCOPE_TEXT_SUMMARIZE,
];

/// grants 文件：DSH_HOME/plugin-grants.json，形如 `{ "<pluginId>": ["scope", ...] }`。
fn grants_path() -> PathBuf {
    crate::dsh_manager::dsh_home().join("plugin-grants.json")
}

/// 读 grants 文件（不存在/损坏按空表处理）。
pub(crate) fn read_grants() -> BTreeMap<String, Vec<String>> {
    std::fs::read_to_string(grants_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// 写 grants 文件（原子替换）。
pub(crate) fn write_grants(grants: &BTreeMap<String, Vec<String>>) -> Result<(), String> {
    let path = grants_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir grants dir: {e}"))?;
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(grants).unwrap_or_default(),
    )
    .map_err(|e| format!("write grants: {e}"))
}

/// 授权/回收一个插件的 scope（dsh_plugin_grant / dsh_plugin_revoke 命令实现）。
pub(crate) fn mutate_grant(plugin_id: &str, scope: &str, grant: bool) -> Result<(), String> {
    if !ALL_SCOPES.contains(&scope) {
        return Err(format!("unknown scope: {scope}"));
    }
    if plugin_id.trim().is_empty() {
        return Err("empty plugin id".into());
    }
    let mut grants = read_grants();
    let entry = grants.entry(plugin_id.to_string()).or_default();
    if grant {
        if !entry.iter().any(|s| s == scope) {
            entry.push(scope.to_string());
        }
    } else {
        entry.retain(|s| s != scope);
    }
    write_grants(&grants)
}

/// bundled 插件 id 集合（放行全 scope）。
fn is_bundled_plugin(plugin_id: &str) -> bool {
    BUNDLED_PLUGINS.iter().any(|(_, pkg)| *pkg == plugin_id)
}

/// 内部 token 鉴权 + 插件 scope 授权；失败时写好错误响应并返回 false。
fn authorize(req: &Request, res: &mut Response, scope: &str) -> bool {
    // 第 1 层：共享 token
    let expected = ai00_s_internal_token();
    let provided = req
        .headers()
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided != expected {
        res.status_code(StatusCode::UNAUTHORIZED);
        res.body(json!({"error": {"message": "invalid internal token"}}).to_string());
        return false;
    }
    // 第 2 层：插件 scope
    let plugin_id = req
        .headers()
        .get(PLUGIN_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let allowed = if plugin_id.is_empty() {
        BASIC_SCOPES.contains(&scope)
    } else if is_bundled_plugin(plugin_id) {
        true
    } else {
        read_grants()
            .get(plugin_id)
            .is_some_and(|scopes| scopes.iter().any(|s| s == scope))
    };
    if !allowed {
        log::warn!(
            "[internal-api] scope denied: plugin={:?} scope={scope}",
            if plugin_id.is_empty() {
                "<unidentified>"
            } else {
                plugin_id
            }
        );
        if let Ok(v) = salvo::http::HeaderValue::from_str(scope) {
            res.headers_mut().insert("x-ai00-required-scope", v);
        }
        res.status_code(StatusCode::FORBIDDEN);
        res.body(
            json!({
                "error": {
                    "message": format!("plugin scope not granted: {scope}"),
                    "requiredScope": scope,
                }
            })
            .to_string(),
        );
        // 授权卡：把 (pluginId, scope) 推给前端（unidentified 无法授权——
        // 插件必须先声明 Plugin-Id 头，此处不发事件）
        if !plugin_id.is_empty() {
            if let Some(app) = crate::dsh_manager::app_handle() {
                let _ = Emitter::emit(
                    &app,
                    "dsh://permission-requested",
                    json!({"pluginId": plugin_id, "scope": scope}),
                );
            }
        }
        return false;
    }
    true
}

/// 网关响应禁止缓存。
#[handler]
async fn no_cache(res: &mut Response) {
    res.headers_mut().insert(
        salvo::http::header::CACHE_CONTROL,
        salvo::http::HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
}

/// 挂到主 router 的业务子路由（外层 server.rs 已挂 "ai00-internal" 前缀）。
pub fn router() -> Router {
    Router::new()
        .push(Router::with_path("notify").hoop(no_cache).post(notify))
        .push(
            Router::with_path("wallpaper/apply")
                .hoop(no_cache)
                .post(wallpaper_apply),
        )
        .push(
            Router::with_path("wallpaper/projects")
                .hoop(no_cache)
                .get(wallpaper_projects),
        )
        .push(
            Router::with_path("wallpaper/create")
                .hoop(no_cache)
                .post(wallpaper_create),
        )
        .push(
            Router::with_path("todo")
                .hoop(no_cache)
                .get(todo_get)
                .put(todo_set)
                // Salvo 陷阱：子路径必须 .push 子 Router（挂 todo 自身会吞掉子路由）
                .push(
                    Router::with_path("task/create")
                        .hoop(no_cache)
                        .post(todo_task_create),
                ),
        )
        .push(
            Router::with_path("todo/focus")
                .hoop(no_cache)
                .post(todo_focus),
        )
        .push(
            Router::with_path("plan")
                .hoop(no_cache)
                .get(plan_get)
                .put(plan_set),
        )
        .push(
            Router::with_path("git/snapshot")
                .hoop(no_cache)
                .post(git_snapshot),
        )
        .push(Router::with_path("xp").hoop(no_cache).post(xp_report))
        .push(
            Router::with_path("web/extract")
                .hoop(no_cache)
                .post(web_extract),
        )
        .push(
            Router::with_path("text/summarize")
                .hoop(no_cache)
                .post(text_summarize),
        )
}

/// 解析 JSON body；失败时写好 400 响应并返回 None。
async fn parse_body(req: &mut Request, res: &mut Response) -> Option<Value> {
    match req.parse_json().await {
        Ok(v) => Some(v),
        Err(e) => {
            res.status_code(StatusCode::BAD_REQUEST);
            res.body(json!({"error": {"message": format!("invalid json: {e}")}}).to_string());
            None
        }
    }
}

/// 统一错误响应。
fn err(res: &mut Response, status: StatusCode, message: String) {
    res.status_code(status);
    res.body(json!({"error": {"message": message}}).to_string());
}

// ---------------------------------------------------------------------------
// 系统通知
// ---------------------------------------------------------------------------

#[handler]
async fn notify(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_NOTIFY) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    let Some(title) = body.get("title").and_then(|v| v.as_str()) else {
        err(res, StatusCode::BAD_REQUEST, "missing field: title".into());
        return;
    };
    let text = body.get("body").and_then(|v| v.as_str());

    let Some(app) = crate::dsh_manager::app_handle() else {
        err(res, StatusCode::SERVICE_UNAVAILABLE, "app not ready".into());
        return;
    };
    use tauri_plugin_notification::NotificationExt;
    let mut builder = app.notification().builder().title(title);
    if let Some(t) = text {
        builder = builder.body(t);
    }
    match builder.show() {
        Ok(()) => {
            res.body(json!({"ok": true}).to_string());
        }
        Err(e) => err(res, StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// web 有效信息提取（全本地闭环工具宿主侧：搜索→并发抓取→并发本地筛选）
// ---------------------------------------------------------------------------

#[handler]
async fn web_extract(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_WEB_EXTRACT) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    let Some(query) = body
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|q| !q.is_empty())
    else {
        err(res, StatusCode::BAD_REQUEST, "missing field: query".into());
        return;
    };
    let max_results = body
        .get("max_results")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);
    let pages = crate::web_extract::extract(query, max_results).await;
    res.body(json!({"pages": pages}).to_string());
}

// ---------------------------------------------------------------------------
// 长文总结（全本地闭环：≤6000 单次 / >6000 切块 map-reduce 并发）
// ---------------------------------------------------------------------------

#[handler]
async fn text_summarize(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_TEXT_SUMMARIZE) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    let Some(text) = body
        .get("text")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
    else {
        err(res, StatusCode::BAD_REQUEST, "missing field: text".into());
        return;
    };
    // 防滥用：单次总结上限 20 万字符（约 50 块，块间并发池内调度）
    const TEXT_CAP: usize = 200_000;
    if text.chars().count() > TEXT_CAP {
        err(
            res,
            StatusCode::BAD_REQUEST,
            format!("text too long (>{TEXT_CAP} chars)"),
        );
        return;
    }
    let focus = body.get("focus").and_then(|v| v.as_str());
    let max_length = body
        .get("max_length")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);
    let result = crate::web_extract::summarize(text, focus, max_length).await;
    res.body(json!(result).to_string());
}

// ---------------------------------------------------------------------------
// 壁纸应用
// ---------------------------------------------------------------------------

#[handler]
async fn wallpaper_apply(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_WALLPAPER) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    let request: crate::api::wallpaper_api::ApplyToDesktopRequest =
        match serde_json::from_value(body) {
            Ok(r) => r,
            Err(e) => {
                err(
                    res,
                    StatusCode::BAD_REQUEST,
                    format!("invalid request: {e}"),
                );
                return;
            }
        };

    let Some(app) = crate::dsh_manager::app_handle() else {
        err(res, StatusCode::SERVICE_UNAVAILABLE, "app not ready".into());
        return;
    };
    let state = app.state::<crate::api::app_state::AppState>();
    match crate::api::wallpaper_api::apply_wallpaper_to_desktop(app.clone(), state, request).await {
        Ok(()) => {
            res.body(json!({"ok": true}).to_string());
        }
        Err(e) => err(res, StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// ---------------------------------------------------------------------------
// 壁纸项目（agent 创建/列出壁纸项目的通道——HTML 经参数落盘，绕开 dsh 沙箱）
// ---------------------------------------------------------------------------

#[handler]
async fn wallpaper_projects(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_WALLPAPER) {
        return;
    }
    let Some(app) = crate::dsh_manager::app_handle() else {
        err(res, StatusCode::SERVICE_UNAVAILABLE, "app not ready".into());
        return;
    };
    let state = app.state::<crate::api::app_state::AppState>();
    match crate::api::wallpaper_api::list_workspace_wallpaper_projects(state).await {
        Ok(list) => {
            let items: Vec<Value> = list
                .iter()
                .map(|p| {
                    json!({
                        "id": p.id,
                        "name": p.name,
                        "description": p.description,
                        "serveUrl": format!("/wallpaper/projects/{}/index.html", p.id),
                    })
                })
                .collect();
            res.body(json!({ "projects": items }).to_string());
        }
        Err(e) => err(res, StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[handler]
async fn wallpaper_create(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_WALLPAPER) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    let name = match body.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ => {
            err(res, StatusCode::BAD_REQUEST, "missing field: name".into());
            return;
        }
    };
    let html = match body.get("html").and_then(|v| v.as_str()) {
        Some(h) if !h.trim().is_empty() => h.to_string(),
        _ => {
            err(res, StatusCode::BAD_REQUEST, "missing field: html".into());
            return;
        }
    };
    let apply = body.get("apply").and_then(|v| v.as_bool()).unwrap_or(true);

    let Some(app) = crate::dsh_manager::app_handle() else {
        err(res, StatusCode::SERVICE_UNAVAILABLE, "app not ready".into());
        return;
    };
    let state = app.state::<crate::api::app_state::AppState>();

    // 1. 创建项目目录（exe 旁 workspaces；State 不可重用，各步独立取）
    let created = match crate::api::wallpaper_api::create_workspace_wallpaper_project(
        app.state::<crate::api::app_state::AppState>(),
        crate::api::wallpaper_api::CreateWorkspaceProjectRequest {
            name,
            dir_name: String::new(),
        },
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            err(
                res,
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("create project: {e}"),
            );
            return;
        }
    };

    // 2. 写入 agent 生成的 index.html（项目目录落盘）
    let index_path = std::path::PathBuf::from(&created.project_path).join("index.html");
    if let Err(e) = tokio::fs::write(&index_path, html).await {
        err(
            res,
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write index.html: {e}"),
        );
        return;
    }

    // 3. publish（拷贝到 serve 目录，取 serveUrl）
    let published = match crate::api::wallpaper_api::publish_wallpaper_project(
        app.state::<crate::api::app_state::AppState>(),
        crate::api::wallpaper_api::PublishWorkspaceProjectRequest {
            dir_name: created.project.id.clone(),
        },
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            err(
                res,
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("publish: {e}"),
            );
            return;
        }
    };

    // 4. 应用桌面（apply 默认 true——壁纸 agent 的通常目的就是换壁纸）
    if apply {
        let apply_req = crate::api::wallpaper_api::ApplyToDesktopRequest {
            project_path: created.project_path.clone(),
            mode: None,
            monitor_id: None,
        };
        if let Err(e) =
            crate::api::wallpaper_api::apply_wallpaper_to_desktop(app.clone(), state, apply_req)
                .await
        {
            // 应用失败不撤销创建——项目已可用，返回标记让 agent 决定是否重试
            res.body(
                json!({
                    "projectId": created.project.id,
                    "name": created.project.name,
                    "serveUrl": published.serve_url,
                    "applied": false,
                    "applyError": e,
                })
                .to_string(),
            );
            return;
        }
    }

    res.body(
        json!({
            "projectId": created.project.id,
            "name": created.project.name,
            "serveUrl": published.serve_url,
            "applied": apply,
        })
        .to_string(),
    );
}

// ---------------------------------------------------------------------------
// 知行数据
// ---------------------------------------------------------------------------

#[handler]
async fn todo_get(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_TODO_READ) {
        return;
    }
    match crate::api::todo_api::todo_store_get().await {
        Ok(Some(value)) => {
            res.body(value.to_string());
        }
        // 尚无数据：返回空对象（调用方无需区分 null）
        Ok(None) => {
            res.body(json!({}).to_string());
        }
        Err(e) => err(res, StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[handler]
async fn todo_set(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_TODO_WRITE) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    match crate::api::todo_api::todo_store_set(body).await {
        Ok(()) => {
            // agent 侧写入广播：web-ui 内存态重读盘（todo-agent-updated → load）。
            // ⚠️ 只在此 handler emit——todo_store_set 本身还被 web-ui 的 Tauri
            // 保存命令调用，那里 emit 会造成 load→save→emit→load 死循环。
            if let Some(app) = crate::dsh_manager::app_handle() {
                let _ = app.emit("todo-agent-updated", ());
            }
            res.body(json!({"ok": true}).to_string());
        }
        Err(e) => err(res, StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[handler]
async fn todo_task_create(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_TODO_WRITE) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    let Some(app) = crate::dsh_manager::app_handle() else {
        err(res, StatusCode::SERVICE_UNAVAILABLE, "app not ready".into());
        return;
    };
    match crate::api::todo_api::todo_task_create(&app, &body).await {
        Ok(task) => {
            res.body(task.to_string());
        }
        Err(e) => err(res, StatusCode::BAD_REQUEST, e),
    }
}

#[handler]
async fn todo_focus(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_TODO_WRITE) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    let started_at = body
        .get("startedAt")
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            // 未提供时以当前时间计（秒）
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        });
    let minutes = body.get("minutes").and_then(|v| v.as_i64()).unwrap_or(0);
    let outcome = body
        .get("outcome")
        .and_then(|v| v.as_str())
        .unwrap_or("finished")
        .to_string();
    let task_id = body
        .get("taskId")
        .and_then(|v| v.as_str())
        .map(String::from);

    let Some(app) = crate::dsh_manager::app_handle() else {
        err(res, StatusCode::SERVICE_UNAVAILABLE, "app not ready".into());
        return;
    };
    match crate::api::todo_api::todo_focus_append(app, started_at, minutes, outcome, task_id).await
    {
        Ok(session) => {
            res.body(session.to_string());
        }
        Err(e) => err(res, StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// ---------------------------------------------------------------------------
// 计划文档（dsh agent 经此双向读写 plans/<taskId>.md——与策窗口共享同一文件）
// ---------------------------------------------------------------------------

#[handler]
async fn plan_get(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_PLAN_READ) {
        return;
    }
    let Some(task_id) = req.query::<String>("taskId").filter(|s| !s.is_empty()) else {
        err(res, StatusCode::BAD_REQUEST, "missing query: taskId".into());
        return;
    };
    match crate::api::todo_api::todo_plan_get(task_id.clone()).await {
        Ok(Some(markdown)) => {
            res.body(json!({ "taskId": task_id, "markdown": markdown, "found": true }).to_string());
        }
        Ok(None) => {
            res.body(json!({ "taskId": task_id, "markdown": null, "found": false }).to_string());
        }
        Err(e) => err(res, StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[handler]
async fn plan_set(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_PLAN_WRITE) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    let Some(task_id) = body
        .get("taskId")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
    else {
        err(res, StatusCode::BAD_REQUEST, "missing field: taskId".into());
        return;
    };
    let Some(markdown) = body.get("markdown").and_then(|v| v.as_str()) else {
        err(
            res,
            StatusCode::BAD_REQUEST,
            "missing field: markdown".into(),
        );
        return;
    };

    let Some(app) = crate::dsh_manager::app_handle() else {
        err(res, StatusCode::SERVICE_UNAVAILABLE, "app not ready".into());
        return;
    };
    match crate::api::todo_api::todo_plan_set(app, task_id, markdown.to_owned()).await {
        Ok(()) => {
            res.body(json!({"ok": true}).to_string());
        }
        Err(e) => err(res, StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// ---------------------------------------------------------------------------
// 工作区 git 快照（志目录/默认工作区：auto-init 静默 + 任务粒度 commit）
// ---------------------------------------------------------------------------

#[handler]
async fn git_snapshot(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_GIT) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    let Some(dir) = body
        .get("dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
    else {
        err(res, StatusCode::BAD_REQUEST, "missing field: dir".into());
        return;
    };
    let message = body
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("task: agent snapshot")
        .to_string();
    let path = std::path::PathBuf::from(&dir);
    if !path.is_dir() {
        err(
            res,
            StatusCode::BAD_REQUEST,
            format!("dir not found: {dir}"),
        );
        return;
    }
    // 静默快照：失败不 5xx（快照是增强能力，不阻塞委托/完成主流程）
    // 纯 libgit2——不依赖系统安装 git
    match ai00_x_git::snapshot(&path, &message) {
        Ok(result) => {
            res.body(serde_json::to_string(&result).unwrap_or_default());
        }
        Err(_e) => {
            res.body(
                json!({ "initialized": false, "commit": null, "message": message }).to_string(),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// XP 事件转发（远端 ai00-x.com，member JWT；服务端按 kind 幂等去重）
// ---------------------------------------------------------------------------

#[handler]
async fn xp_report(req: &mut Request, res: &mut Response) {
    if !authorize(req, res, SCOPE_XP) {
        return;
    }
    let Some(body) = parse_body(req, res).await else {
        return;
    };
    if body.get("kind").and_then(|v| v.as_str()).is_none() {
        err(res, StatusCode::BAD_REQUEST, "missing field: kind".into());
        return;
    }

    // 会员 token（未登录则 401，由调用方决定是否静默降级）
    let auth_info = match crate::auth::ensure_auth_synced().await {
        Ok(Some(info)) => info,
        Ok(None) => {
            err(res, StatusCode::UNAUTHORIZED, "not logged in".into());
            return;
        }
        Err(e) => {
            err(res, StatusCode::INTERNAL_SERVER_ERROR, e);
            return;
        }
    };

    // 远端 base url
    let config_service = match ai00_x_core::service::config::get_global_config_service() {
        Ok(s) => s,
        Err(e) => {
            err(
                res,
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("config service: {e}"),
            );
            return;
        }
    };
    let global_config: ai00_x_core::service::config::GlobalConfig =
        match config_service.get_config(None).await {
            Ok(c) => c,
            Err(e) => {
                err(
                    res,
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("get config: {e}"),
                );
                return;
            }
        };
    let url = format!("{}/api/v1/me/xp/events", global_config.app.ai00_s_base_url);

    // 转发（与 refresh_auth_token_impl 同款头策略：Bearer + 内部 token CSRF 豁免）
    let client = reqwest::Client::new();
    let send = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", auth_info.token))
        .header("X-Ai00-Internal-Token", ai00_s_internal_token())
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;
    let resp = match send {
        Ok(r) => r,
        Err(e) => {
            err(
                res,
                StatusCode::BAD_GATEWAY,
                format!("xp forward failed: {e}"),
            );
            return;
        }
    };

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let bytes = resp.bytes().await.unwrap_or_default();
    res.status_code(StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY));
    if let Ok(ct) = salvo::http::HeaderValue::from_str(&content_type) {
        res.headers_mut()
            .insert(salvo::http::header::CONTENT_TYPE, ct);
    }
    res.body(bytes);
}
