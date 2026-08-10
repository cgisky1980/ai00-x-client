use super::{ListChangedKind, MCPServerManager};
use std::time::Duration;

#[test]
fn backoff_delay_grows_exponentially_and_caps() {
    let base = Duration::from_secs(2);
    let max = Duration::from_secs(60);

    assert_eq!(
        MCPServerManager::compute_backoff_delay(base, max, 1),
        Duration::from_secs(2)
    );
    assert_eq!(
        MCPServerManager::compute_backoff_delay(base, max, 2),
        Duration::from_secs(4)
    );
    assert_eq!(
        MCPServerManager::compute_backoff_delay(base, max, 5),
        Duration::from_secs(32)
    );
    assert_eq!(
        MCPServerManager::compute_backoff_delay(base, max, 10),
        Duration::from_secs(60)
    );
}

#[test]
fn detect_list_changed_kind_supports_three_catalogs() {
    assert_eq!(
        MCPServerManager::detect_list_changed_kind("notifications/tools/list_changed"),
        Some(ListChangedKind::Tools)
    );
    assert_eq!(
        MCPServerManager::detect_list_changed_kind("notifications/prompts/list_changed"),
        Some(ListChangedKind::Prompts)
    );
    assert_eq!(
        MCPServerManager::detect_list_changed_kind("notifications/resources/list_changed"),
        Some(ListChangedKind::Resources)
    );
    assert_eq!(
        MCPServerManager::detect_list_changed_kind("notifications/unknown"),
        None
    );
}
