use std::path::Path;

use super::parser::parse_yaml_adapter;
use super::registry::WebAdapterRegistry;
use super::types::AdapterSource;

pub fn discover_user_adapters(registry: &mut WebAdapterRegistry) -> Result<(), String> {
    let user_dir = dirs::home_dir()
        .map(|p| p.join(".ai00-x").join("web-adapters"))
        .ok_or("Cannot determine home directory")?;

    if !user_dir.exists() {
        log::debug!(
            "User adapters directory does not exist: {}",
            user_dir.display()
        );
        return Ok(());
    }

    log::info!("Scanning user adapters in: {}", user_dir.display());
    let mut count = 0;

    let entries = std::fs::read_dir(&user_dir)
        .map_err(|e| format!("Failed to read user adapters dir: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(sub_entries) = std::fs::read_dir(&path) {
                for sub_entry in sub_entries.flatten() {
                    let sub_path = sub_entry.path();
                    if is_yaml_file(&sub_path) {
                        if let Some(adapter) = load_yaml_adapter(&sub_path, AdapterSource::User) {
                            registry.register(adapter, AdapterSource::User);
                            count += 1;
                        }
                    }
                }
            }
        } else if is_yaml_file(&path) {
            if let Some(adapter) = load_yaml_adapter(&path, AdapterSource::User) {
                registry.register(adapter, AdapterSource::User);
                count += 1;
            }
        }
    }

    log::info!("Loaded {} user adapter(s)", count);
    Ok(())
}

fn is_yaml_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e == "yaml" || e == "yml")
        .unwrap_or(false)
}

fn load_yaml_adapter(path: &Path, source: AdapterSource) -> Option<super::types::WebAdapter> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Failed to read adapter '{}': {}", path.display(), e);
            return None;
        }
    };

    match parse_yaml_adapter(&content) {
        Ok(adapter) => Some(adapter),
        Err(e) => {
            log::warn!(
                "Failed to parse {} adapter '{}': {}",
                match source {
                    AdapterSource::Builtin => "builtin",
                    AdapterSource::User => "user",
                    AdapterSource::Remote => "remote",
                },
                path.display(),
                e
            );
            None
        }
    }
}
