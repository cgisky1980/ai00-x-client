//! DSH 插件 scope 授权命令（grants）。
//!
//! 2026-09-19 agent-host crate 切分：以下三个命令依赖 desktop 的
//! internal_api（grants 文件与 scope 白名单），随宿主侧留在这里；
//! 引擎安装/生命周期/插件管理本体已平移至 `crates/agent-host`。
//! 命令名不变，前端 invoke 调用零改动。

use serde::Serialize;

use crate::dsh_manager::dsh_versions_gen::BUNDLED_PLUGINS;

/// 插件 scope 授权条目（grants 文件 + bundled 全量视图）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshPluginGrants {
    pub plugin_id: String,
    pub scopes: Vec<String>,
    /// bundled 插件全量放行（grants 文件不存储）。
    pub bundled: bool,
}

/// 列出插件 scope 授权视图：bundled 插件 = 全 scope；其余来自 grants 文件。
#[tauri::command]
pub async fn dsh_plugin_grants_list() -> Result<Vec<DshPluginGrants>, String> {
    use crate::internal_api::ALL_SCOPES;
    let mut out: Vec<DshPluginGrants> = BUNDLED_PLUGINS
        .iter()
        .map(|(_, pkg)| DshPluginGrants {
            plugin_id: pkg.to_string(),
            scopes: ALL_SCOPES.iter().map(|s| s.to_string()).collect(),
            bundled: true,
        })
        .collect();
    for (plugin_id, scopes) in crate::internal_api::read_grants() {
        if scopes.is_empty() {
            continue;
        }
        out.push(DshPluginGrants {
            plugin_id,
            scopes,
            bundled: false,
        });
    }
    out.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id));
    Ok(out)
}

/// 授予第三方插件一个 scope（授权卡 / 插件设置页）。
#[tauri::command]
pub async fn dsh_plugin_grant(plugin_id: String, scope: String) -> Result<(), String> {
    crate::internal_api::mutate_grant(&plugin_id, &scope, true)
}

/// 回收第三方插件的一个 scope。
#[tauri::command]
pub async fn dsh_plugin_revoke(plugin_id: String, scope: String) -> Result<(), String> {
    crate::internal_api::mutate_grant(&plugin_id, &scope, false)
}
