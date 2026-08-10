//! SQLite storage for usage statistics.
//!
//! Uses `r2d2` connection pool with `r2d2_sqlite` (bundled rusqlite). The
//! schema is embedded at compile time from `schema.sql` and executed
//! idempotently on [`UsageStatsStore::open`].

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// SQLite schema, embedded at compile time.
const SCHEMA_SQL: &str = include_str!("schema.sql");

/// Connection pool type alias.
pub type Pool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;

/// Background segment record (row in `activity_segments`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivitySegment {
    pub id: Option<i64>,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub exe_path: String,
    pub process_name: String,
    pub window_title: Option<String>,
    pub process_id: Option<u32>,
    pub bundle_id: Option<String>,
    pub duration_secs: i64,
    pub is_afk: bool,
    pub session_id: String,
}

/// App rule (row in `app_rules`), auto-discovered and user-editable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppRule {
    pub id: Option<i64>,
    pub exe_path: String,
    pub process_name: String,
    pub display_name: Option<String>,
    pub category_id: Option<i64>,
    pub color: Option<String>,
    pub exclude_from_stats: bool,
    pub capture_title: bool,
    /// Base64 PNG data URL (`data:image/png;base64,...`) extracted from the
    /// exe's icon resource. `None` when the exe has no icon or extraction
    /// has not yet run.
    pub icon: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// In-progress or completed usage session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSession {
    pub id: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub end_reason: Option<String>,
    pub total_active_secs: i64,
    pub total_afk_secs: i64,
}

/// Store handle (clonable, cheap — wraps an `Arc<Pool>`).
#[derive(Clone)]
pub struct UsageStatsStore {
    pool: Arc<Pool>,
    /// Path to the SQLite file, used for `VACUUM INTO` backups (Phase 5).
    #[allow(dead_code)]
    db_path: PathBuf,
}

impl UsageStatsStore {
    /// Open (or create) the SQLite database at `db_path`, run the schema,
    /// and seal any sessions left open by a previous crash.
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create db dir {:?}", parent))?;
        }
        let manager = r2d2_sqlite::SqliteConnectionManager::file(db_path);
        let pool = Pool::builder()
            .max_size(5)
            .build(manager)
            .with_context(|| format!("build sqlite pool at {:?}", db_path))?;

        let store = Self {
            pool: Arc::new(pool),
            db_path: db_path.to_path_buf(),
        };
        store.run_schema()?;
        store.migrate_add_icon_column()?;
        store.seal_crashed_sessions()?;
        Ok(store)
    }

    /// Execute the embedded schema SQL.
    fn run_schema(&self) -> Result<()> {
        let conn = self.pool.get().context("acquire schema conn")?;
        conn.execute_batch(SCHEMA_SQL)
            .context("execute usage_stats schema")?;
        Ok(())
    }

    /// Seal all sessions left open (`ended_at IS NULL`) by a previous crash
    /// with `end_reason = 'crash_recovery'`. Called once on startup.
    fn seal_crashed_sessions(&self) -> Result<()> {
        let conn = self.pool.get().context("acquire seal conn")?;
        let now = Utc::now().to_rfc3339();
        let affected = conn.execute(
            "UPDATE usage_sessions SET ended_at = ?1, end_reason = 'crash_recovery' \
             WHERE ended_at IS NULL",
            params![now],
        )?;
        if affected > 0 {
            log::info!(
                "usage_stats: sealed {} session(s) left open by a previous crash",
                affected
            );
        }
        Ok(())
    }

    /// Add the `icon` column to `app_rules` if it is missing (older databases
    /// created before icon support). SQLite has no `ADD COLUMN IF NOT EXISTS`,
    /// so we check `PRAGMA table_info` first. Idempotent.
    fn migrate_add_icon_column(&self) -> Result<()> {
        let conn = self.pool.get().context("acquire migrate conn")?;
        let mut stmt = conn.prepare("PRAGMA table_info(app_rules)")?;
        let has_icon: bool = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|col| col == "icon");
        if !has_icon {
            conn.execute("ALTER TABLE app_rules ADD COLUMN icon TEXT", [])
                .context("alter app_rules add icon")?;
            log::info!("usage_stats: migrated app_rules — added icon column");
        }
        Ok(())
    }

    /// Update the `icon` (base64 PNG data URL) for an app rule matched by
    /// `exe_path`. Called by the collector after extracting the icon from
    /// the executable's icon resource. No-op when the exe_path is unknown.
    pub fn update_app_icon(&self, exe_path: &str, icon: &str) -> Result<()> {
        let conn = self.pool.get().context("acquire update_icon conn")?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE app_rules SET icon = ?1, updated_at = ?2 WHERE exe_path = ?3",
            params![icon, now, exe_path],
        )
        .context("update_app_icon")?;
        Ok(())
    }

    /// Insert (or reuse) an `app_rules` row for the given exe_path. Returns
    /// the canonical `AppRule`. Auto-discovery writes the default rule on
    /// first sighting.
    pub fn ensure_app_rule(&self, exe_path: &str, process_name: &str) -> Result<AppRule> {
        let conn = self.pool.get().context("acquire app_rule conn")?;
        let now = Utc::now().to_rfc3339();
        // Insert if absent.
        conn.execute(
            "INSERT OR IGNORE INTO app_rules \
             (exe_path, process_name, display_name, exclude_from_stats, capture_title, \
              created_at, updated_at) VALUES (?1, ?2, NULL, 0, 1, ?3, ?3)",
            params![exe_path, process_name, now],
        )?;
        // Read back the canonical row.
        let rule = conn
            .query_row(
                "SELECT id, exe_path, process_name, display_name, category_id, color, \
                 exclude_from_stats, capture_title, icon, created_at, updated_at \
                 FROM app_rules WHERE exe_path = ?1",
                params![exe_path],
                |row| {
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
                },
            )
            .context("read back app_rule")?;
        Ok(rule)
    }

    /// Insert a new `activity_segment` row. Returns the rowid.
    pub fn insert_segment(&self, seg: &ActivitySegment) -> Result<i64> {
        let conn = self.pool.get().context("acquire segment conn")?;
        let title = if seg.is_afk {
            None
        } else {
            seg.window_title.as_deref()
        };
        conn.execute(
            "INSERT INTO activity_segments \
             (started_at, ended_at, exe_path, process_name, window_title, process_id, \
              bundle_id, duration_secs, is_afk, session_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                seg.started_at.to_rfc3339(),
                seg.ended_at.to_rfc3339(),
                seg.exe_path,
                seg.process_name,
                title,
                seg.process_id.map(|p| p as i64),
                seg.bundle_id,
                seg.duration_secs,
                seg.is_afk as i64,
                seg.session_id,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Create a new `usage_session` row and return its id (UUID).
    pub fn start_session(&self) -> Result<String> {
        let conn = self.pool.get().context("acquire start_session conn")?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO usage_sessions (id, started_at, total_active_secs, total_afk_secs) \
             VALUES (?1, ?2, 0, 0)",
            params![id, now],
        )?;
        Ok(id)
    }

    /// Close a `usage_session` with the given `end_reason`.
    pub fn end_session(&self, session_id: &str, end_reason: &str) -> Result<()> {
        let conn = self.pool.get().context("acquire end_session conn")?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE usage_sessions SET ended_at = ?1, end_reason = ?2 WHERE id = ?3",
            params![now, end_reason, session_id],
        )?;
        Ok(())
    }

    /// Acquire a pooled connection with a labeled context message.
    /// Used by `queries.rs` extension impl to keep error messages traceable.
    pub(crate) fn pool_get_conn(
        &self,
        label: &'static str,
    ) -> Result<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>> {
        self.pool.get().context(label)
    }
}

/// Parse an RFC3339 timestamp into `DateTime<Utc>`. Falls back to `Utc::now()`
/// on parse failure (defensive — DB rows are written by this module).
pub(crate) fn parse_ts(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}
