//! Aggregation queries + app_rules/categories CRUD for [`UsageStatsStore`].
//!
//! Lives in a separate file from `storage.rs` to keep the base CRUD module
//! readable; Rust permits `impl` blocks to span files within the same crate
//! as long as both the type and the impl are in the same crate.
//!
//! All queries group results by `exe_path` (the canonical app identity) and
//! join against `app_rules` so the frontend receives display name / color /
//! category info in a single round-trip.

use chrono::{Local, NaiveDate, Offset, TimeZone, Utc};
use rusqlite::params;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::storage::{parse_ts, AppRule, UsageStatsStore};

// ── Query result types ──────────────────────────────────────────────────

/// Today (or any single day) summary card.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaySummary {
    /// Total active (non-AFK) seconds.
    pub total_active_secs: i64,
    /// Total AFK seconds (Phase 2; always 0 in Phase 1).
    pub total_afk_secs: i64,
    /// Distinct apps used today.
    pub app_count: i64,
    /// Number of activity segments recorded.
    pub segment_count: i64,
    /// Longest single contiguous segment (seconds).
    pub longest_segment_secs: i64,
}

/// Single bar in the per-hour timeline (one row per `(hour, exe_path)`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineItem {
    /// Hour of day (0..=23) in the user's LOCAL timezone. The UTC RFC3339
    /// `started_at` is shifted by `local_utc_offset_secs()` inside SQL before
    /// `strftime('%H', ...)` extracts the hour, so this matches wall clock.
    pub hour: i32,
    pub exe_path: String,
    pub process_name: String,
    pub display_name: Option<String>,
    pub color: Option<String>,
    pub category_id: Option<i64>,
    /// Base64 PNG data URL extracted from the exe's icon resource.
    pub icon: Option<String>,
    pub duration_secs: i64,
    pub is_afk: bool,
}

/// One day in a trends chart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrendItem {
    /// "YYYY-MM-DD" (truncated from RFC3339).
    pub date: String,
    pub total_active_secs: i64,
    pub total_afk_secs: i64,
    pub app_count: i64,
}

/// Top-app ranking entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopAppItem {
    pub exe_path: String,
    pub process_name: String,
    pub display_name: Option<String>,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub color: Option<String>,
    /// Base64 PNG data URL extracted from the exe's icon resource.
    pub icon: Option<String>,
    pub total_secs: i64,
    pub segment_count: i64,
    /// Share of total active time (0.0..=1.0).
    pub percentage: f64,
}

/// Heatmap cell (day-of-week × hour-of-day).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeatmapCell {
    /// Day of week (0 = Sunday, SQLite `strftime('%w', ...)` convention).
    pub day_of_week: i32,
    /// Hour of day (0..=23).
    pub hour: i32,
    pub total_secs: i64,
}

/// Category row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i32,
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Convert a `NaiveDate` to the RFC3339 UTC timestamp marking day-start.
/// Convert a `NaiveDate` (interpreted in the user's local timezone) to the
/// RFC3339 UTC timestamp marking local midnight (start of that local day).
fn day_start_rfc3339(date: NaiveDate) -> String {
    let local_midnight = date.and_hms_opt(0, 0, 0).expect("valid hms");
    Local
        .from_local_datetime(&local_midnight)
        .single()
        .expect("valid local time")
        .with_timezone(&Utc)
        .to_rfc3339()
}

/// Convert a `NaiveDate` to the RFC3339 UTC timestamp marking the start of
/// the next local day (exclusive upper bound).
fn next_day_start_rfc3339(date: NaiveDate) -> String {
    let next = date.succ_opt().expect("valid date");
    let local_midnight = next.and_hms_opt(0, 0, 0).expect("valid hms");
    Local
        .from_local_datetime(&local_midnight)
        .single()
        .expect("valid local time")
        .with_timezone(&Utc)
        .to_rfc3339()
}

/// Return the user's local timezone offset from UTC, in seconds.
/// E.g. UTC+8 → 28800, UTC-5 → -18000. Used to shift UTC RFC3339
/// timestamps into local time inside SQL queries so that GROUP BY hour /
/// date / day-of-week reflects the user's wall clock rather than UTC.
fn local_utc_offset_secs() -> i64 {
    // `Local::now()` returns a `DateTime<Local>` whose `.offset()` carries
    // the civil offset (including DST at the current moment).
    i64::from(Local::now().offset().fix().local_minus_utc())
}

/// Build a SQLite expression that converts the UTC RFC3339 `started_at`
/// column into a local civil datetime string suitable for `strftime`.
///
/// SQLite's `datetime()` cannot parse the `+00:00` suffix in RFC3339, so we
/// strip to `YYYY-MM-DD HH:MM:SS` (replacing the `T` separator with a space)
/// and apply the local UTC offset as a `'NNN seconds'` modifier. The result
/// is a `YYYY-MM-DD HH:MM:SS` string in local civil time.
///
/// Uses the explicit `?3` bind placeholder (must be the 3rd param in the
/// calling query, after `?1` = day-start and `?2` = day-end). A single
/// `?3` can be referenced multiple times within one statement.
fn local_dt_expr() -> &'static str {
    "datetime(substr(started_at, 1, 10) || ' ' || substr(started_at, 12, 8), '+' || ?3 || ' seconds')"
}

// ── Query methods (impl UsageStatsStore extension) ──────────────────────

impl UsageStatsStore {
    /// Return the day summary for a given date (UTC bounds).
    pub fn day_summary(&self, date: NaiveDate) -> Result<DaySummary> {
        let conn = self.pool_get_conn("day_summary")?;
        let start = day_start_rfc3339(date);
        let end = next_day_start_rfc3339(date);
        let mut stmt = conn.prepare(
            "SELECT \
               COALESCE(SUM(CASE WHEN is_afk = 0 THEN duration_secs ELSE 0 END), 0), \
               COALESCE(SUM(CASE WHEN is_afk = 1 THEN duration_secs ELSE 0 END), 0), \
               COUNT(DISTINCT exe_path), \
               COUNT(*), \
               COALESCE(MAX(duration_secs), 0) \
             FROM activity_segments \
             WHERE started_at >= ?1 AND started_at < ?2",
        )?;
        let row = stmt.query_row(params![start, end], |r| {
            Ok(DaySummary {
                total_active_secs: r.get(0)?,
                total_afk_secs: r.get(1)?,
                app_count: r.get(2)?,
                segment_count: r.get(3)?,
                longest_segment_secs: r.get(4)?,
            })
        })?;
        Ok(row)
    }

    /// Per-hour timeline for a given date. Returns one row per
    /// `(hour, exe_path)` pair, ordered by hour then duration desc.
    pub fn timeline_for_date(&self, date: NaiveDate) -> Result<Vec<TimelineItem>> {
        let conn = self.pool_get_conn("timeline_for_date")?;
        let start = day_start_rfc3339(date);
        let end = next_day_start_rfc3339(date);
        let offset_secs = local_utc_offset_secs();
        // Extract hour from the LOCAL civil datetime (UTC timestamp + local
        // offset), not the raw UTC hour. SQLite's `strftime('%H', datetime(...))`
        // returns the hour in the shifted civil time.
        let mut stmt = conn.prepare(&format!(
            "SELECT \
               CAST(strftime('%H', {}) AS INTEGER) AS hour, \
               seg.exe_path, seg.process_name, \
               ar.display_name, ar.color, ar.category_id, ar.icon, \
               SUM(seg.duration_secs) AS duration, \
               seg.is_afk \
             FROM activity_segments seg \
             LEFT JOIN app_rules ar ON ar.exe_path = seg.exe_path \
             WHERE seg.started_at >= ?1 AND seg.started_at < ?2 \
             GROUP BY hour, seg.exe_path, seg.is_afk \
             ORDER BY hour, duration DESC",
            local_dt_expr()
        ))?;
        let rows = stmt.query_map(params![start, end, offset_secs], |r| {
            Ok(TimelineItem {
                hour: r.get::<_, i64>(0)? as i32,
                exe_path: r.get(1)?,
                process_name: r.get(2)?,
                display_name: r.get(3)?,
                color: r.get(4)?,
                category_id: r.get(5)?,
                icon: r.get(6)?,
                duration_secs: r.get(7)?,
                is_afk: r.get::<_, i64>(8)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Daily trend items for a date range (inclusive both ends).
    pub fn trends_for_range(&self, start: NaiveDate, end: NaiveDate) -> Result<Vec<TrendItem>> {
        let conn = self.pool_get_conn("trends_for_range")?;
        let start_str = day_start_rfc3339(start);
        // `end` is inclusive — exclusive upper bound is start of day after `end`.
        let end_str = next_day_start_rfc3339(end);
        let offset_secs = local_utc_offset_secs();
        // Group by LOCAL date (UTC timestamp + local offset), not the raw
        // UTC date. Otherwise a UTC+8 user's "7/2 00:30" activity would be
        // bucketed under "7/1" (UTC 16:30 on the prior day).
        let mut stmt = conn.prepare(&format!(
            "SELECT \
               strftime('%Y-%m-%d', {}) AS date, \
               COALESCE(SUM(CASE WHEN is_afk = 0 THEN duration_secs ELSE 0 END), 0), \
               COALESCE(SUM(CASE WHEN is_afk = 1 THEN duration_secs ELSE 0 END), 0), \
               COUNT(DISTINCT exe_path) \
             FROM activity_segments \
             WHERE started_at >= ?1 AND started_at < ?2 \
             GROUP BY date \
             ORDER BY date",
            local_dt_expr()
        ))?;
        let rows = stmt.query_map(params![start_str, end_str, offset_secs], |r| {
            Ok(TrendItem {
                date: r.get(0)?,
                total_active_secs: r.get(1)?,
                total_afk_secs: r.get(2)?,
                app_count: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Top apps by total active time in a date range (inclusive both ends).
    /// `limit` caps the result count.
    pub fn top_apps_for_range(
        &self,
        start: NaiveDate,
        end: NaiveDate,
        limit: usize,
    ) -> Result<Vec<TopAppItem>> {
        let conn = self.pool_get_conn("top_apps_for_range")?;
        let start_str = day_start_rfc3339(start);
        let end_str = next_day_start_rfc3339(end);
        let mut stmt = conn.prepare(
            "SELECT \
               ar.exe_path, ar.process_name, ar.display_name, \
               ar.category_id, c.name, ar.color, ar.icon, \
               SUM(seg.duration_secs) AS total, \
               COUNT(*) AS segments \
             FROM activity_segments seg \
             LEFT JOIN app_rules ar ON ar.exe_path = seg.exe_path \
             LEFT JOIN categories c ON c.id = ar.category_id \
             WHERE seg.started_at >= ?1 AND seg.started_at < ?2 \
               AND seg.is_afk = 0 \
             GROUP BY ar.exe_path \
             ORDER BY total DESC \
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![start_str, end_str, limit as i64], |r| {
            Ok(TopAppItem {
                exe_path: r.get(0)?,
                process_name: r.get(1)?,
                display_name: r.get(2)?,
                category_id: r.get(3)?,
                category_name: r.get(4)?,
                color: r.get(5)?,
                icon: r.get(6)?,
                total_secs: r.get(7)?,
                segment_count: r.get(8)?,
                percentage: 0.0, // populated below
            })
        })?;
        let mut out: Vec<TopAppItem> = Vec::new();
        for row in rows {
            out.push(row?);
        }
        // Compute percentages against total.
        let total: i64 = out.iter().map(|x| x.total_secs).sum();
        if total > 0 {
            for item in out.iter_mut() {
                item.percentage = item.total_secs as f64 / total as f64;
            }
        }
        Ok(out)
    }

    /// 7×24 heatmap (day-of-week × hour-of-day) for a date range.
    pub fn hourly_heatmap_for_range(
        &self,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<HeatmapCell>> {
        let conn = self.pool_get_conn("hourly_heatmap_for_range")?;
        let start_str = day_start_rfc3339(start);
        let end_str = next_day_start_rfc3339(end);
        let offset_secs = local_utc_offset_secs();
        // Both day-of-week and hour must be derived from LOCAL civil time;
        // otherwise cells shift by the timezone offset (e.g. UTC+8 puts
        // 8am-UTC activity in the 4pm-local cell).
        let mut stmt = conn.prepare(&format!(
            "SELECT \
               CAST(strftime('%w', {}) AS INTEGER) AS dow, \
               CAST(strftime('%H', {}) AS INTEGER) AS hour, \
               SUM(duration_secs) AS total \
             FROM activity_segments \
             WHERE started_at >= ?1 AND started_at < ?2 AND is_afk = 0 \
             GROUP BY dow, hour",
            local_dt_expr(),
            local_dt_expr(),
        ))?;
        let rows = stmt.query_map(params![start_str, end_str, offset_secs], |r| {
            Ok(HeatmapCell {
                day_of_week: r.get::<_, i64>(0)? as i32,
                hour: r.get::<_, i64>(1)? as i32,
                total_secs: r.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    // ── app_rules CRUD ──────────────────────────────────────────────────

    /// List all app rules, ordered by process_name.
    pub fn list_app_rules(&self) -> Result<Vec<AppRule>> {
        let conn = self.pool_get_conn("list_app_rules")?;
        let mut stmt = conn.prepare(
            "SELECT id, exe_path, process_name, display_name, category_id, color, \
                    exclude_from_stats, capture_title, icon, created_at, updated_at \
             FROM app_rules ORDER BY process_name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(AppRule {
                id: row.get::<_, Option<i64>>(0)?,
                exe_path: row.get(1)?,
                process_name: row.get(2)?,
                display_name: row.get(3)?,
                category_id: row.get(4)?,
                color: row.get(5)?,
                exclude_from_stats: row.get::<_, i64>(6)? != 0,
                capture_title: row.get::<_, i64>(7)? != 0,
                icon: row.get::<_, Option<String>>(8)?,
                created_at: parse_ts(&row.get::<_, String>(9)?),
                updated_at: parse_ts(&row.get::<_, String>(10)?),
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Update an existing app rule (matched by `id`).
    pub fn update_app_rule(&self, rule: &AppRule) -> Result<()> {
        let conn = self.pool_get_conn("update_app_rule")?;
        let now = Utc::now().to_rfc3339();
        let id = rule.id.context("app_rule.id must be Some for update")?;
        conn.execute(
            "UPDATE app_rules SET \
               display_name = ?1, category_id = ?2, color = ?3, \
               exclude_from_stats = ?4, capture_title = ?5, updated_at = ?6 \
             WHERE id = ?7",
            params![
                rule.display_name,
                rule.category_id,
                rule.color,
                rule.exclude_from_stats as i64,
                rule.capture_title as i64,
                now,
                id,
            ],
        )?;
        Ok(())
    }

    /// Delete an app rule by `exe_path`. The activity_segments rows
    /// referencing this exe_path are kept (FK ON DELETE SET NULL would only
    /// apply if we had FKs enforced; we don't, so segments persist).
    pub fn delete_app_rule(&self, exe_path: &str) -> Result<()> {
        let conn = self.pool_get_conn("delete_app_rule")?;
        conn.execute(
            "DELETE FROM app_rules WHERE exe_path = ?1",
            params![exe_path],
        )?;
        Ok(())
    }

    // ── categories CRUD ──────────────────────────────────────────────────

    /// List all categories ordered by sort_order then name.
    pub fn list_categories(&self) -> Result<Vec<Category>> {
        let conn = self.pool_get_conn("list_categories")?;
        let mut stmt = conn.prepare(
            "SELECT id, name, color, sort_order FROM categories \
             ORDER BY sort_order, name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                sort_order: r.get::<_, i64>(3)? as i32,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Create a new category. Returns the rowid.
    pub fn create_category(&self, name: &str, color: Option<&str>) -> Result<i64> {
        let conn = self.pool_get_conn("create_category")?;
        conn.execute(
            "INSERT INTO categories (name, color, sort_order) VALUES (?1, ?2, 0)",
            params![name, color],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Update a category's name and/or color. `None` fields are left unchanged.
    pub fn update_category(
        &self,
        id: i64,
        name: Option<&str>,
        color: Option<Option<&str>>,
    ) -> Result<()> {
        let conn = self.pool_get_conn("update_category")?;
        // Build SET clause dynamically based on which fields were provided.
        let mut sql = String::from("UPDATE categories SET ");
        let mut parts: Vec<&str> = Vec::new();
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(n) = name {
            parts.push("name = ?");
            params_vec.push(Box::new(n.to_string()));
        }
        if let Some(c) = color {
            parts.push("color = ?");
            params_vec.push(Box::new(c.map(|s| s.to_string())));
        }
        if parts.is_empty() {
            return Ok(());
        }
        sql.push_str(&parts.join(", "));
        sql.push_str(" WHERE id = ?");
        params_vec.push(Box::new(id));
        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
        conn.execute(&sql, param_refs.as_slice())?;
        Ok(())
    }

    /// Delete a category by id. app_rules referencing it are SET NULL via FK.
    pub fn delete_category(&self, id: i64) -> Result<()> {
        let conn = self.pool_get_conn("delete_category")?;
        conn.execute("DELETE FROM categories WHERE id = ?1", params![id])?;
        Ok(())
    }
}

// ── Private helpers ────────────────────────────────────────────────────
//
// `pool_get_conn` lives in `storage.rs` as a `pub(crate)` method on
// `UsageStatsStore` so it can access the private `pool` field. The `parse_ts`
// helper is also re-exported from `storage.rs` (also `pub(crate)`).
