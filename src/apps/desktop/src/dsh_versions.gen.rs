//! dsh agent 运行环境版本常量（唯一来源：packages/shared/agent-versions.json）
//!
//! 由 `scripts/generate-agent-versions.cjs` 自动生成。禁止手动修改本文件；
//! 修改版本请编辑 JSON 源文件后运行 `pnpm run generate-agent-versions`。

/// dsh 0.1.x 要求 ^22.19 || >=24；选 24 LTS 官方 CI 主力线。
pub const NODE_VERSION: &str = "24.20.0";

/// 钉死的 dsh npm 版本（锁版本升级走 D5 受控机制）。
pub const DSH_NPM_SPEC: &str = "@deepseek-ai/dsh@0.1.1-rc.2";

/// dsh NPM 镜像（国内加速；与 resource_manager 多主机测速体系后续对齐）。
pub const NPM_REGISTRY: &str = "https://registry.npmmirror.com";

/// 随客户端分发的 dsh 插件清单：(子目录, npm 包名)。
pub const BUNDLED_PLUGINS: &[(&str, &str)] = &[
    ("ai-bridge", "@ai00-x/dsh-ai-bridge"),
    ("tools", "@ai00-x/dsh-tools"),
];
