//! Wallpaper types — project model and metadata.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A wallpaper project stored on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperProject {
    /// Directory name (also used as ID).
    pub id: String,
    /// Human-readable project name.
    pub name: String,
    /// Short description (from meta.json).
    pub description: String,
    /// Tags for categorization.
    pub tags: Vec<String>,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Last modification timestamp.
    pub updated_at: DateTime<Utc>,
    /// Absolute filesystem path to the project directory (only for workspace projects).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

/// Metadata stored in each project's `meta.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperMeta {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Result of creating a new project from the preview directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectResult {
    pub project: WallpaperProject,
    /// URL path the HTTP server can serve at.
    pub serve_path: String,
    /// Absolute filesystem path to the project directory.
    pub project_path: String,
}
