//! agent-host — dsh 引擎宿主层：sidecar 自动安装链、守护重启、同源反代。
//!
//! 2026-09-19 自 `apps/desktop` 平移（笔阵 P0-2）：desktop 经再导出零路径改动消费；
//! `marketing/mkt-agent` 以本 crate 为地基复用同一套引擎宿主能力。
//! 插件 scope 授权命令依赖 desktop 的 internal_api（grants），留在 desktop `dsh_grants`。

pub mod checkpoint;
pub mod dsh_manager;
pub mod dsh_proxy;
