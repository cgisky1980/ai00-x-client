//! Todo core local storage — 待办清单核心功能的本地数据持久化。
//!
//! todo 已从插件提升为 overlay 核心功能：任务/清单/目标/专注记录是
//! 单机私数据，存本地 JSON 文件（`{data_dir}/Ai00-X/todo/data.json`，
//! 原子写）；游戏化（XP/勋章/等级）走服务器 `member_xp_events`，不在此层。
//!
//! 数据 schema 与旧插件版（plugins-data/com.ai00x.todo/data.json）完全
//! 一致——首启由前端做一次性迁移（plugin_data_get → todo_store_set）。

use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::fs;

/// todo 数据文件：`{data_dir}/Ai00-X/todo/data.json`
fn todo_store_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Ai00-X")
        .join("todo")
        .join("data.json")
}

/// 读取全部 todo 数据；`None` = 尚无数据（首次使用/未迁移）。
#[tauri::command]
pub async fn todo_store_get() -> Result<Option<Value>, String> {
    match fs::read_to_string(todo_store_path()).await {
        Ok(content) => {
            let value: Value =
                serde_json::from_str(&content).map_err(|e| format!("corrupt todo data: {e}"))?;
            Ok(Some(value))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read todo data: {e}")),
    }
}

/// 全量写入 todo 数据（原子写：临时文件 + rename，防半写损坏）。
#[tauri::command]
pub async fn todo_store_set(value: Value) -> Result<(), String> {
    let path = todo_store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create todo dir: {e}"))?;
    }
    let content =
        serde_json::to_string(&value).map_err(|e| format!("serialize todo data: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content)
        .await
        .map_err(|e| format!("write todo data (tmp): {e}"))?;
    fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("commit todo data: {e}"))?;
    Ok(())
}

/// 追加一条专注记录（underlay 番茄钟完成时调用）。
///
/// 服务端式原子读改写：避免 underlay 全量 `todo_store_set` 与 web-ui 的
/// 防抖全量保存相互覆盖丢数据。追加后广播 `todo-focus-appended` 事件，
/// web-ui（TodoOverlay 常驻监听）把会话并入内存并入账 XP。
#[tauri::command]
pub async fn todo_focus_append(
    app: AppHandle,
    started_at: i64,
    minutes: i64,
    outcome: String,
    task_id: Option<String>,
) -> Result<Value, String> {
    let session = json!({
        "taskId": task_id,
        "startedAt": started_at,
        "minutes": minutes.max(0),
        "outcome": outcome,
    });
    let path = todo_store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create todo dir: {e}"))?;
    }
    // 读（不存在则骨架）→ 追加 → 原子写
    let mut root: Value = match fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content).map_err(|e| format!("corrupt todo data: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({
            "version": 3,
            "lists": [],
            "goals": [],
            "tasks": [],
            "focusSessions": [],
            "rewards": [],
            "lastStreakSettleDate": null,
            "migratedFromPlugin": true,
        }),
        Err(e) => return Err(format!("read todo data: {e}")),
    };
    if !root.is_object() {
        return Err("corrupt todo data: root is not an object".into());
    }
    let sessions = root
        .as_object_mut()
        .and_then(|o| o.get_mut("focusSessions"))
        .and_then(Value::as_array_mut);
    match sessions {
        Some(arr) => arr.push(session.clone()),
        None => {
            root.as_object_mut()
                .map(|o| o.insert("focusSessions".into(), Value::Array(vec![session.clone()])));
        }
    }
    let content = serde_json::to_string(&root).map_err(|e| format!("serialize todo data: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content)
        .await
        .map_err(|e| format!("write todo data (tmp): {e}"))?;
    fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("commit todo data: {e}"))?;
    let _ = app.emit("todo-focus-appended", session.clone());
    Ok(session)
}
