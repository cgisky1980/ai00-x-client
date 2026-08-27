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
//! - `POST /ai00-internal/xp`              — XP 事件转发远端（member JWT；服务端按 kind 幂等去重）
//!
//! 鉴权：`X-Ai00-Internal-Token` 头匹配 `AI00_S_INTERNAL_TOKEN`（回退默认值），
//! 与 ai_gateway 同策略。业务逻辑留在既有 Rust 实现（D7：插件是薄壳）。

use salvo::http::StatusCode;
use salvo::prelude::*;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use ai00_x_core::infrastructure::ai00_s_internal_token;

const INTERNAL_TOKEN_HEADER: &str = "x-ai00-internal-token";

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
}

/// 内部 token 鉴权；失败时写好 401 响应并返回 false。
fn authed(req: &Request, res: &mut Response) -> bool {
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
    true
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
    if !authed(req, res) {
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
// 壁纸应用
// ---------------------------------------------------------------------------

#[handler]
async fn wallpaper_apply(req: &mut Request, res: &mut Response) {
    if !authed(req, res) {
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
    if !authed(req, res) {
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
    if !authed(req, res) {
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
    if !authed(req, res) {
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
    if !authed(req, res) {
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
    if !authed(req, res) {
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
    if !authed(req, res) {
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
    if !authed(req, res) {
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
    if !authed(req, res) {
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
    if !authed(req, res) {
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
    if !authed(req, res) {
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
