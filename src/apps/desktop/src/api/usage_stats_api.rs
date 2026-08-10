//! Tauri commands for usage statistics.
//!
//! All commands accept a `State<'_, UsageStatsStore>` (managed in `lib.rs`
//! setup). SQLite queries are blocking, so each command clones the store
//! handle (cheap — `Arc<Pool>` internally) and runs the query on a
//! `spawn_blocking` thread to avoid stalling the Tokio runtime.

use chrono::NaiveDate;
use tauri::State;

use crate::usage_stats::queries::{
    Category, DaySummary, HeatmapCell, TimelineItem, TopAppItem, TrendItem,
};
use crate::usage_stats::storage::{AppRule, UsageStatsStore};

/// Parse `YYYY-MM-DD` or fall back to today (local timezone).
fn parse_date_or_today(s: Option<String>) -> Result<NaiveDate, String> {
    match s {
        Some(s) => NaiveDate::parse_from_str(&s, "%Y-%m-%d")
            .map_err(|e| format!("invalid date '{}': {}", s, e)),
        None => Ok(chrono::Local::now().date_naive()),
    }
}

fn parse_date(s: &str, field: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|e| format!("invalid {} date '{}': {}", field, s, e))
}

// ── Read queries ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn usage_stats_day_summary(
    store: State<'_, UsageStatsStore>,
    date: Option<String>,
) -> Result<DaySummary, String> {
    let date = parse_date_or_today(date)?;
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.day_summary(date))
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn usage_stats_timeline(
    store: State<'_, UsageStatsStore>,
    date: Option<String>,
) -> Result<Vec<TimelineItem>, String> {
    let date = parse_date_or_today(date)?;
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.timeline_for_date(date))
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn usage_stats_trends(
    store: State<'_, UsageStatsStore>,
    start: String,
    end: String,
) -> Result<Vec<TrendItem>, String> {
    let start = parse_date(&start, "start")?;
    let end = parse_date(&end, "end")?;
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.trends_for_range(start, end))
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn usage_stats_top_apps(
    store: State<'_, UsageStatsStore>,
    start: String,
    end: String,
    limit: Option<usize>,
) -> Result<Vec<TopAppItem>, String> {
    let start = parse_date(&start, "start")?;
    let end = parse_date(&end, "end")?;
    let limit = limit.unwrap_or(10);
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.top_apps_for_range(start, end, limit))
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn usage_stats_heatmap(
    store: State<'_, UsageStatsStore>,
    start: String,
    end: String,
) -> Result<Vec<HeatmapCell>, String> {
    let start = parse_date(&start, "start")?;
    let end = parse_date(&end, "end")?;
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.hourly_heatmap_for_range(start, end))
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

// ── app_rules CRUD ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn usage_stats_list_app_rules(
    store: State<'_, UsageStatsStore>,
) -> Result<Vec<AppRule>, String> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.list_app_rules())
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn usage_stats_update_app_rule(
    store: State<'_, UsageStatsStore>,
    rule: AppRule,
) -> Result<(), String> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.update_app_rule(&rule))
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn usage_stats_delete_app_rule(
    store: State<'_, UsageStatsStore>,
    exe_path: String,
) -> Result<(), String> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.delete_app_rule(&exe_path))
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

// ── categories CRUD ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn usage_stats_list_categories(
    store: State<'_, UsageStatsStore>,
) -> Result<Vec<Category>, String> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.list_categories())
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn usage_stats_create_category(
    store: State<'_, UsageStatsStore>,
    name: String,
    color: Option<String>,
) -> Result<i64, String> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.create_category(&name, color.as_deref()))
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn usage_stats_delete_category(
    store: State<'_, UsageStatsStore>,
    id: i64,
) -> Result<(), String> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.delete_category(id))
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn usage_stats_update_category(
    store: State<'_, UsageStatsStore>,
    id: i64,
    name: Option<String>,
    color: Option<Option<String>>,
) -> Result<(), String> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || {
        store.update_category(id, name.as_deref(), color.as_ref().map(|c| c.as_deref()))
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
    .map_err(|e| e.to_string())
}
