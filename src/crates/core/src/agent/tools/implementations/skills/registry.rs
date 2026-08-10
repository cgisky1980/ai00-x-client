//! Skill registry
//!
//! Manages skill discovery, loading, and smart matching.

use super::builtin::{
    builtin_skill_group_key, ensure_builtin_skills_installed, is_builtin_skill_dir_name,
};
use super::hybrid_search::HybridSkillSearch;
use super::types::{SkillData, SkillInfo, SkillLocation};
use crate::agent::workspace::WorkspaceFileSystem;
use crate::infrastructure::get_path_manager_arc;
use crate::util::errors::{Ai00XError, Ai00XResult};
use log::{debug, error};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::fs;
use tokio::sync::RwLock;

/// Global Skill registry instance
static SKILL_REGISTRY: OnceLock<SkillRegistry> = OnceLock::new();

const USER_PREFIX: &str = "user";
const PROJECT_PREFIX: &str = "project";

/// Project-level skill roots under a workspace.
const PROJECT_SKILL_SLOTS: &[(&str, &str, &str)] = &[
    (".ai00-x", "skills", "ai00-x"),
    (".claude", "skills", "claude"),
    (".codex", "skills", "codex"),
    (".cursor", "skills", "cursor"),
    (".opencode", "skills", "opencode"),
    (".agents", "skills", "agents"),
];

/// Home-directory based user-level skill roots.
const USER_HOME_SKILL_SLOTS: &[(&str, &str, &str)] = &[
    (".claude", "skills", "home.claude"),
    (".codex", "skills", "home.codex"),
    (".cursor", "skills", "home.cursor"),
    (".agents", "skills", "home.agents"),
];

/// Config-directory based user-level skill roots.
const USER_CONFIG_SKILL_SLOTS: &[(&str, &str, &str)] = &[
    ("opencode", "skills", "config.opencode"),
    ("agents", "skills", "config.agents"),
];

#[derive(Debug, Clone)]
struct SkillRootEntry {
    path: PathBuf,
    level: SkillLocation,
    slot: &'static str,
    priority: usize,
}

#[derive(Debug, Clone)]
struct RemoteSkillRootEntry {
    path: String,
    slot: &'static str,
    priority: usize,
}

#[derive(Debug, Clone)]
struct SkillCandidate {
    info: SkillInfo,
    priority: usize,
}

impl SkillCandidate {
    fn from_data(mut data: SkillData, slot: &str, key_prefix: &str, priority: usize) -> Self {
        data.source_slot = slot.to_string();
        data.key = build_skill_key(key_prefix, slot, &data.dir_name);
        let is_builtin = data.location == SkillLocation::User
            && slot == "ai00-x"
            && is_builtin_skill_dir_name(&data.dir_name);
        let group_key = if is_builtin {
            builtin_skill_group_key(&data.dir_name).map(str::to_string)
        } else {
            None
        };

        Self {
            info: SkillInfo {
                key: data.key,
                name: data.name,
                description: data.description,
                path: data.path,
                level: data.location,
                source_slot: data.source_slot,
                dir_name: data.dir_name,
                is_builtin,
                group_key,
                keywords: data.keywords,
                when_to_use: data.when_to_use,
            },
            priority,
        }
    }
}

fn build_skill_key(prefix: &str, slot: &str, dir_name: &str) -> String {
    format!("{}::{}::{}", prefix, slot, dir_name)
}

fn normalize_dir_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_remote_dir_name(path: &str) -> Option<String> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn sort_skills(mut skills: Vec<SkillInfo>) -> Vec<SkillInfo> {
    skills.sort_by(|a, b| {
        let level_order = match a.level {
            SkillLocation::Project => 0,
            SkillLocation::User => 1,
        }
        .cmp(&match b.level {
            SkillLocation::Project => 0,
            SkillLocation::User => 1,
        });

        level_order
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.key.cmp(&b.key))
    });
    skills
}

fn resolve_visible_skills(candidates: Vec<SkillCandidate>) -> Vec<SkillInfo> {
    let mut by_name: HashMap<String, SkillCandidate> = HashMap::new();
    for candidate in candidates {
        match by_name.get(&candidate.info.name) {
            Some(existing) if existing.priority <= candidate.priority => {}
            _ => {
                by_name.insert(candidate.info.name.clone(), candidate);
            }
        }
    }

    let mut resolved: Vec<SkillCandidate> = by_name.into_values().collect();
    resolved.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.info.name.to_lowercase().cmp(&b.info.name.to_lowercase()))
    });
    resolved
        .into_iter()
        .map(|candidate| candidate.info)
        .collect()
}

/// Skill registry
pub struct SkillRegistry {
    cache: RwLock<Vec<SkillInfo>>,
    hybrid_searcher: RwLock<HybridSkillSearch>,
}

impl SkillRegistry {
    fn new() -> Self {
        Self {
            cache: RwLock::new(Vec::new()),
            hybrid_searcher: RwLock::new(HybridSkillSearch::new()),
        }
    }

    pub fn global() -> &'static Self {
        SKILL_REGISTRY.get_or_init(Self::new)
    }

    pub async fn get_hybrid_searcher(&self) -> &RwLock<HybridSkillSearch> {
        &self.hybrid_searcher
    }

    fn get_possible_paths_for_workspace(workspace_root: Option<&Path>) -> Vec<SkillRootEntry> {
        let mut entries = Vec::new();
        let mut priority = 0usize;

        if let Some(workspace_path) = workspace_root {
            for (parent, sub, slot) in PROJECT_SKILL_SLOTS {
                let path = workspace_path.join(parent).join(sub);
                if path.exists() && path.is_dir() {
                    entries.push(SkillRootEntry {
                        path,
                        level: SkillLocation::Project,
                        slot,
                        priority,
                    });
                }
                priority += 1;
            }
        }

        let path_manager = get_path_manager_arc();
        let ai00x_skills = path_manager.user_skills_dir();
        if ai00x_skills.exists() && ai00x_skills.is_dir() {
            entries.push(SkillRootEntry {
                path: ai00x_skills,
                level: SkillLocation::User,
                slot: "ai00-x",
                priority,
            });
        }
        priority += 1;

        if let Some(home) = dirs::home_dir() {
            for (parent, sub, slot) in USER_HOME_SKILL_SLOTS {
                let path = home.join(parent).join(sub);
                if path.exists() && path.is_dir() {
                    entries.push(SkillRootEntry {
                        path,
                        level: SkillLocation::User,
                        slot,
                        priority,
                    });
                }
                priority += 1;
            }
        }

        if let Some(config_dir) = dirs::config_dir() {
            for (parent, sub, slot) in USER_CONFIG_SKILL_SLOTS {
                let path = config_dir.join(parent).join(sub);
                if path.exists() && path.is_dir() {
                    entries.push(SkillRootEntry {
                        path,
                        level: SkillLocation::User,
                        slot,
                        priority,
                    });
                }
                priority += 1;
            }
        }

        entries
    }

    async fn scan_skills_in_dir(entry: &SkillRootEntry) -> Vec<SkillCandidate> {
        let mut skills = Vec::new();
        if !entry.path.exists() {
            return skills;
        }

        let Ok(mut read_dir) = fs::read_dir(&entry.path).await else {
            return skills;
        };

        while let Ok(Some(item)) = read_dir.next_entry().await {
            let path = item.path();
            if !path.is_dir() {
                continue;
            }

            let Some(dir_name) = normalize_dir_name(&path) else {
                continue;
            };

            let skill_md_path = path.join("SKILL.md");
            if !skill_md_path.exists() {
                continue;
            }

            match fs::read_to_string(&skill_md_path).await {
                Ok(content) => match SkillData::from_markdown(
                    path.to_string_lossy().to_string(),
                    &content,
                    entry.level,
                    false,
                ) {
                    Ok(mut skill_data) => {
                        skill_data.dir_name = dir_name;
                        let key_prefix = match entry.level {
                            SkillLocation::User => USER_PREFIX,
                            SkillLocation::Project => PROJECT_PREFIX,
                        };
                        skills.push(SkillCandidate::from_data(
                            skill_data,
                            entry.slot,
                            key_prefix,
                            entry.priority,
                        ));
                    }
                    Err(error) => {
                        error!("Failed to parse SKILL.md in {}: {}", path.display(), error);
                    }
                },
                Err(error) => {
                    debug!("Failed to read {}: {}", skill_md_path.display(), error);
                }
            }
        }

        skills
    }

    async fn scan_skill_candidates_for_workspace(
        &self,
        workspace_root: Option<&Path>,
    ) -> Vec<SkillCandidate> {
        if let Err(error) = ensure_builtin_skills_installed().await {
            debug!("Failed to install built-in skills: {}", error);
        }

        let mut skills = Vec::new();
        for entry in Self::get_possible_paths_for_workspace(workspace_root) {
            let mut part = Self::scan_skills_in_dir(&entry).await;
            skills.append(&mut part);
        }
        skills
    }

    async fn scan_remote_project_skills(
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
    ) -> Vec<SkillCandidate> {
        let mut roots = Vec::new();
        let root = remote_root.trim_end_matches('/');
        for (priority, (parent, sub, slot)) in PROJECT_SKILL_SLOTS.iter().enumerate() {
            let path = format!("{}/{}/{}", root, parent, sub);
            if fs.is_dir(&path).await.unwrap_or(false) {
                roots.push(RemoteSkillRootEntry {
                    path,
                    slot,
                    priority,
                });
            }
        }

        let mut skills = Vec::new();
        for entry in roots {
            let entries = match fs.read_dir(&entry.path).await {
                Ok(value) => value,
                Err(_) => continue,
            };

            for item in entries {
                if !item.is_dir || item.is_symlink {
                    continue;
                }

                let Some(dir_name) = normalize_remote_dir_name(&item.path) else {
                    continue;
                };
                let skill_md_path = format!("{}/SKILL.md", item.path.trim_end_matches('/'));
                if !fs.is_file(&skill_md_path).await.unwrap_or(false) {
                    continue;
                }

                match fs.read_file_text(&skill_md_path).await {
                    Ok(content) => match SkillData::from_markdown(
                        item.path.clone(),
                        &content,
                        SkillLocation::Project,
                        false,
                    ) {
                        Ok(mut skill_data) => {
                            skill_data.dir_name = dir_name;
                            skills.push(SkillCandidate::from_data(
                                skill_data,
                                entry.slot,
                                PROJECT_PREFIX,
                                entry.priority,
                            ));
                        }
                        Err(error) => {
                            error!("Failed to parse SKILL.md in {}: {}", item.path, error);
                        }
                    },
                    Err(error) => {
                        debug!("Failed to read {}: {}", skill_md_path, error);
                    }
                }
            }
        }

        skills
    }

    async fn scan_skill_candidates_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
    ) -> Vec<SkillCandidate> {
        let mut skills = self.scan_skill_candidates_for_workspace(None).await;
        skills.extend(Self::scan_remote_project_skills(fs, remote_root).await);
        skills
    }

    async fn ensure_loaded(&self) {
        let cache = self.cache.read().await;
        if cache.is_empty() {
            drop(cache);
            self.refresh().await;
        }
    }

    pub async fn refresh(&self) {
        let skills = sort_skills(
            self.scan_skill_candidates_for_workspace(None)
                .await
                .into_iter()
                .map(|candidate| candidate.info)
                .collect(),
        );

        self.rebuild_indices(&skills).await;

        let mut cache = self.cache.write().await;
        *cache = skills;
    }

    async fn rebuild_indices(&self, skills: &[SkillInfo]) {
        let index_inputs: Vec<(String, String, Vec<String>, String)> =
            skills.iter().map(|s| s.to_index_input()).collect();

        {
            let mut searcher = self.hybrid_searcher.write().await;
            searcher.build_keyword_index(&index_inputs);
        }

        {
            let mut searcher = self.hybrid_searcher.write().await;
            searcher.build_vector_index(&index_inputs).await;
        }
    }

    pub async fn refresh_for_workspace(&self, _workspace_root: Option<&Path>) {
        self.refresh().await;
    }

    pub async fn get_all_skills(&self) -> Vec<SkillInfo> {
        self.ensure_loaded().await;
        let cache = self.cache.read().await;
        cache.clone()
    }

    pub async fn list_skills_missing_metadata(&self) -> Vec<SkillInfo> {
        self.ensure_loaded().await;
        let cache = self.cache.read().await;
        cache
            .iter()
            .filter(|s| s.needs_enhancement())
            .cloned()
            .collect()
    }

    pub async fn get_all_skills_for_workspace(
        &self,
        workspace_root: Option<&Path>,
    ) -> Vec<SkillInfo> {
        sort_skills(
            self.scan_skill_candidates_for_workspace(workspace_root)
                .await
                .into_iter()
                .map(|candidate| candidate.info)
                .collect(),
        )
    }

    pub async fn get_all_skills_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
    ) -> Vec<SkillInfo> {
        sort_skills(
            self.scan_skill_candidates_for_remote_workspace(fs, remote_root)
                .await
                .into_iter()
                .map(|candidate| candidate.info)
                .collect(),
        )
    }

    pub async fn get_resolved_skills_for_workspace(
        &self,
        workspace_root: Option<&Path>,
        _agent_type: Option<&str>,
    ) -> Vec<SkillInfo> {
        let candidates = self
            .scan_skill_candidates_for_workspace(workspace_root)
            .await;
        resolve_visible_skills(candidates)
    }

    pub async fn get_resolved_skills_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        _agent_type: Option<&str>,
    ) -> Vec<SkillInfo> {
        let candidates = self
            .scan_skill_candidates_for_remote_workspace(fs, remote_root)
            .await;
        resolve_visible_skills(candidates)
    }

    pub async fn get_skill_catalog(
        &self,
        workspace_root: Option<&Path>,
    ) -> Vec<(String, String, bool)> {
        let skills = self
            .get_resolved_skills_for_workspace(workspace_root, None)
            .await;
        skills
            .into_iter()
            .map(|s| {
                let needs = s.needs_enhancement();
                (s.name, s.description, needs)
            })
            .collect()
    }

    pub async fn match_by_keywords(
        &self,
        workspace_root: Option<&Path>,
        query: &str,
    ) -> Vec<String> {
        let skills = self
            .get_resolved_skills_for_workspace(workspace_root, None)
            .await;
        let query_lower = query.to_lowercase();
        skills
            .into_iter()
            .filter(|s| {
                let name_lower = s.name.to_lowercase();
                let desc_lower = s.description.to_lowercase();
                query_lower.contains(&name_lower)
                    || name_lower.contains(&query_lower)
                    || desc_lower.contains(&query_lower)
            })
            .map(|s| s.name)
            .collect()
    }

    pub async fn find_skill_by_key_for_workspace(
        &self,
        skill_key: &str,
        workspace_root: Option<&Path>,
    ) -> Option<SkillInfo> {
        self.get_all_skills_for_workspace(workspace_root)
            .await
            .into_iter()
            .find(|skill| skill.key == skill_key)
    }

    pub async fn find_skill_by_key_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        skill_key: &str,
    ) -> Option<SkillInfo> {
        self.get_all_skills_for_remote_workspace(fs, remote_root)
            .await
            .into_iter()
            .find(|skill| skill.key == skill_key)
    }

    pub async fn find_and_load_skill_for_workspace(
        &self,
        skill_name: &str,
        workspace_root: Option<&Path>,
        _agent_type: Option<&str>,
    ) -> Ai00XResult<SkillData> {
        let info = self
            .get_resolved_skills_for_workspace(workspace_root, None)
            .await
            .into_iter()
            .find(|skill| skill.name == skill_name)
            .ok_or_else(|| Ai00XError::tool(format!("Skill '{}' not found", skill_name)))?;

        let skill_md_path = PathBuf::from(&info.path).join("SKILL.md");
        let content = fs::read_to_string(&skill_md_path)
            .await
            .map_err(|error| Ai00XError::tool(format!("Failed to read skill file: {}", error)))?;

        let mut data = SkillData::from_markdown(info.path.clone(), &content, info.level, true)?;
        data.key = info.key;
        data.source_slot = info.source_slot;
        data.dir_name = info.dir_name;
        Ok(data)
    }

    pub async fn find_and_load_skill_for_remote_workspace(
        &self,
        skill_name: &str,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        _agent_type: Option<&str>,
    ) -> Ai00XResult<SkillData> {
        let info = self
            .get_resolved_skills_for_remote_workspace(fs, remote_root, None)
            .await
            .into_iter()
            .find(|skill| skill.name == skill_name)
            .ok_or_else(|| Ai00XError::tool(format!("Skill '{}' not found", skill_name)))?;

        let content = Self::read_skill_md_for_remote_merge(&info, fs).await?;
        let mut data = SkillData::from_markdown(info.path.clone(), &content, info.level, true)?;
        data.key = info.key;
        data.source_slot = info.source_slot;
        data.dir_name = info.dir_name;
        Ok(data)
    }

    pub async fn get_resolved_skills_xml_for_workspace(
        &self,
        workspace_root: Option<&Path>,
        agent_type: Option<&str>,
    ) -> Vec<String> {
        self.get_resolved_skills_for_workspace(workspace_root, agent_type)
            .await
            .into_iter()
            .map(|skill| skill.to_xml_desc())
            .collect()
    }

    pub async fn get_resolved_skills_xml_for_remote_workspace(
        &self,
        fs: &dyn WorkspaceFileSystem,
        remote_root: &str,
        agent_type: Option<&str>,
    ) -> Vec<String> {
        self.get_resolved_skills_for_remote_workspace(fs, remote_root, agent_type)
            .await
            .into_iter()
            .map(|skill| skill.to_xml_desc())
            .collect()
    }

    async fn read_skill_md_for_remote_merge(
        info: &SkillInfo,
        remote_fs: &dyn WorkspaceFileSystem,
    ) -> Ai00XResult<String> {
        match info.level {
            SkillLocation::User => {
                let skill_md_path = PathBuf::from(&info.path).join("SKILL.md");
                fs::read_to_string(&skill_md_path).await.map_err(|error| {
                    Ai00XError::tool(format!("Failed to read skill file: {}", error))
                })
            }
            SkillLocation::Project => {
                let skill_md_path = format!("{}/SKILL.md", info.path.trim_end_matches('/'));
                remote_fs
                    .read_file_text(&skill_md_path)
                    .await
                    .map_err(|error| {
                        Ai00XError::tool(format!("Failed to read skill file: {}", error))
                    })
            }
        }
    }
}
