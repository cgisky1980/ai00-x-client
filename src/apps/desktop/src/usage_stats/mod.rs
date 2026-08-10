//! Software usage statistics module.
//!
//! Cross-platform (Windows / macOS / Linux) foreground application tracking
//! with local SQLite storage. Inspired by Patina
//! <https://github.com/Ceceliaee/patina>.
//!
//! Architecture:
//! - `platform/` — platform-specific foreground window detection
//! - `storage.rs` — SQLite storage (r2d2 connection pool)
//! - `collector.rs` — background polling engine + state machine
//! - `schema.sql` — database schema (embedded at compile time)
//!
//! Future modules (Phase 2+): `afk.rs`, `lifecycle.rs`, `noise_filter.rs`,
//! `app_rules.rs`, `aggregation.rs`, `backup.rs`, `reporter.rs`.

pub mod collector;
pub mod platform;
pub mod queries;
pub mod storage;
