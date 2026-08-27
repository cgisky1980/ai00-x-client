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

/// 计划文档目录：`{data_dir}/Ai00-X/todo/plans/`（文件化计划，人与 agent 共享读写）。
fn todo_plans_dir() -> PathBuf {
    let base = todo_store_path();
    let parent = base.parent().unwrap_or(std::path::Path::new("."));
    parent.join("plans")
}

/// 读取一张卡片的计划 MD；`None` = 尚无计划文件。
#[tauri::command]
pub async fn todo_plan_get(task_id: String) -> Result<Option<String>, String> {
    // 任务 id 自生成含时间戳与随机段，仍做一层文件名清洗防御
    let safe: String = task_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let path = todo_plans_dir().join(format!("{safe}.md"));
    match fs::read_to_string(&path).await {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read plan: {e}")),
    }
}

/// 写入一张卡片的计划 MD（原子写）。
///
/// 任何一方写入（web-ui 编辑保存 / dsh agent `ai00_plan_write`）都广播
/// `todo-plan-updated {taskId}`——PlanDocPanel 监听此事件热刷新，
/// 实现「计划文档是人与 agent 的共享工作面」的双向可见。
#[tauri::command]
pub async fn todo_plan_set(
    app: AppHandle,
    task_id: String,
    markdown: String,
) -> Result<(), String> {
    let safe: String = task_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dir = todo_plans_dir();
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create plans dir: {e}"))?;
    let path = dir.join(format!("{safe}.md"));
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, markdown)
        .await
        .map_err(|e| format!("write plan (tmp): {e}"))?;
    fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("commit plan: {e}"))?;
    let _ = app.emit("todo-plan-updated", json!({ "taskId": task_id }));
    Ok(())
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
    let content = serde_json::to_string(&value).map_err(|e| format!("serialize todo data: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content)
        .await
        .map_err(|e| format!("write todo data (tmp): {e}"))?;
    fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("commit todo data: {e}"))?;
    Ok(())
}

/// agent 自主建卡：在想法池追加一张任务卡（人机对等的想法收集）。
///
/// dsh `ai00_task_create` 工具经内部 API 调用（RMW + 原子写），落卡后广播
/// `todo-agent-updated`——web-ui（TodoOverlay）重读盘，想法池实时可见。
/// 新卡 `status: 'requirement'`（想法池），走完整 想法→计划→执行→验收 生命周期。
#[allow(clippy::needless_pass_by_value)]
pub async fn todo_task_create(app: &AppHandle, body: &Value) -> Result<Value, String> {
    let title: String = body
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "missing field: title".to_string())?
        .chars()
        .take(120)
        .collect();
    let notes = body
        .get("notes")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .chars()
        .take(2000)
        .collect::<String>();
    let source_task_id = body
        .get("sourceTaskId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    let mut data = match todo_store_get().await? {
        Some(v) => v,
        None => json!({
            "version": 3,
            "lists": [],
            "goals": [],
            "tasks": [],
            "focusSessions": [],
            "rewards": [],
            "lastStreakSettleDate": null,
            "migratedFromPlugin": false,
        }),
    };

    // goalId 存在性校验（不存在 → 置 null，防脏外键）；milestoneId 须属于该志
    let goal_id: Option<String> = body
        .get("goalId")
        .and_then(|v| v.as_str())
        .filter(|id| {
            data.get("goals")
                .and_then(|g| g.as_array())
                .is_some_and(|gs| {
                    gs.iter()
                        .any(|g| g.get("id").and_then(|v| v.as_str()) == Some(*id))
                })
        })
        .map(str::to_owned);
    let milestone_id: Option<String> = match &goal_id {
        Some(gid) => body
            .get("milestoneId")
            .and_then(|v| v.as_str())
            .filter(|mid| {
                data.get("goals")
                    .and_then(|g| g.as_array())
                    .and_then(|gs| {
                        gs.iter()
                            .find(|g| g.get("id").and_then(|v| v.as_str()) == Some(gid.as_str()))
                    })
                    .and_then(|g| g.get("milestones"))
                    .and_then(|m| m.as_array())
                    .is_some_and(|ms| {
                        ms.iter()
                            .any(|m| m.get("id").and_then(|v| v.as_str()) == Some(*mid))
                    })
            })
            .map(str::to_owned),
        None => None,
    };
    let due: Option<String> = body
        .get("due")
        .and_then(|v| v.as_str())
        .filter(|s| s.len() == 10 && s.as_bytes().get(4) == Some(&b'-'))
        .map(str::to_owned);

    let now = chrono_millis();
    let task_id = format!("t-{now}-{}", &rand_suffix());
    // 源任务标注并入 notes（TodoTask 无独立字段——notes 是持久可靠的落点）
    let full_notes = match source_task_id {
        Some(src) if notes.is_empty() => format!("（源自任务 {src}）"),
        Some(src) => format!("{notes}\n（源自任务 {src}）"),
        None => notes,
    };
    let task = json!({
        "id": task_id,
        "listId": null,
        "title": title,
        "notes": full_notes,
        "due": due,
        "repeat": null,
        "checklist": [],
        "flag": false,
        "completedAt": null,
        "createdAt": now,
        "order": now,
        "focus": { "pomodoros": 0, "minutes": 0 },
        "goalId": goal_id,
        "milestoneId": milestone_id,
        "remindAt": null,
        "remindedAt": null,
        "status": "requirement",
    });

    let tasks = data
        .get_mut("tasks")
        .and_then(|v| v.as_array_mut())
        .ok_or("todo data missing tasks array")?;
    tasks.push(task.clone());
    todo_store_set(data).await?;
    let _ = app.emit("todo-agent-updated", ());
    Ok(task)
}

/// 当前毫秒时间戳。
fn chrono_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 短随机后缀（与 web-ui genId 风格一致）。
fn rand_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{:x}", (n << 20) ^ (chrono_millis() & 0xFFFFF))
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
        Ok(content) => {
            serde_json::from_str(&content).map_err(|e| format!("corrupt todo data: {e}"))?
        }
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
