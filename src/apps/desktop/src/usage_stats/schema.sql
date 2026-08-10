-- Software usage statistics schema.
--
-- Embedded at compile time via include_str! and executed on startup by
-- `UsageStatsStore::open()`. All statements are idempotent
-- (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`).

-- App rule table (user-editable: rename / categorize / color / exclude / title capture).
CREATE TABLE IF NOT EXISTS app_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exe_path TEXT NOT NULL UNIQUE,
    process_name TEXT NOT NULL,
    display_name TEXT,
    category_id INTEGER,
    color TEXT,
    exclude_from_stats INTEGER NOT NULL DEFAULT 0,
    capture_title INTEGER NOT NULL DEFAULT 1,
    icon TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

-- Category table.
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Foreground activity segment (a contiguous period with one app in foreground).
CREATE TABLE IF NOT EXISTS activity_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    exe_path TEXT NOT NULL,
    process_name TEXT NOT NULL,
    window_title TEXT,
    process_id INTEGER,
    bundle_id TEXT,
    duration_secs INTEGER NOT NULL,
    is_afk INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL,
    FOREIGN KEY (exe_path) REFERENCES app_rules(exe_path) ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_segments_started ON activity_segments(started_at);
CREATE INDEX IF NOT EXISTS idx_segments_exe ON activity_segments(exe_path);
CREATE INDEX IF NOT EXISTS idx_segments_session ON activity_segments(session_id);

-- Usage session (boot-to-shutdown / unlock-to-lock span).
CREATE TABLE IF NOT EXISTS usage_sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT,
    total_active_secs INTEGER NOT NULL DEFAULT 0,
    total_afk_secs INTEGER NOT NULL DEFAULT 0
);

-- Settings (key-value).
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Backup history metadata.
CREATE TABLE IF NOT EXISTS backup_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    segments_count INTEGER
);
