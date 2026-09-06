#!/usr/bin/env node

/**
 * Agent versions generator — SINGLE SOURCE OF TRUTH: packages/shared/agent-versions.json
 *
 * dsh agent 运行环境版本（node / dsh / 内置插件清单）统一以
 * `packages/shared/agent-versions.json` 为唯一来源。本脚本从该 JSON 生成：
 *   1. TS 侧：`packages/shared/src/agentVersions.ts`
 *   2. Rust 侧：`src/apps/desktop/src/dsh_versions.gen.rs`
 *
 * 用法：`pnpm run generate-agent-versions`
 * 消费方：`src/apps/desktop/src/dsh_manager.rs`（sidecar 安装链）与
 * `scripts/dsh-plugin-check.mjs`（检测流水线，直接读 JSON）。
 * 消除历史漂移 bug：check 脚本曾硬编码 node v22.23.2 而运行时是 v24.20.0。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSON_SRC = path.join(ROOT, 'packages', 'shared', 'agent-versions.json');
const TS_OUT = path.join(ROOT, 'packages', 'shared', 'src', 'agentVersions.ts');
const RUST_OUT = path.join(ROOT, 'src', 'apps', 'desktop', 'src', 'dsh_versions.gen.rs');

const src = JSON.parse(fs.readFileSync(JSON_SRC, 'utf8'));

// ---- TS 产物 ----
const tsPlugins = src.bundledPlugins
  .map((p) => `  { dir: '${p.dir}', npmName: '${p.npmName}' },`)
  .join('\n');
const ts = `/**
 * dsh agent 运行环境版本常量（唯一来源：packages/shared/agent-versions.json）
 *
 * 由 \`scripts/generate-agent-versions.cjs\` 自动生成。禁止手动修改本文件；
 * 修改版本请编辑 JSON 源文件后运行 \`pnpm run generate-agent-versions\`。
 */

/** dsh 0.1.x 要求 ^22.19 || >=24；选 24 LTS 官方 CI 主力线 */
export const AGENT_NODE_VERSION = '${src.nodeVersion}';

/** 钉死的 dsh npm 版本（锁版本升级走受控机制） */
export const AGENT_DSH_NPM_SPEC = '${src.dshNpmSpec}';

/** dsh NPM 镜像（国内加速） */
export const AGENT_NPM_REGISTRY = '${src.npmRegistry}';

/** 随客户端分发的 dsh 插件清单：(目录名, npm 包名)。 */
export const AGENT_BUNDLED_PLUGINS: ReadonlyArray<{ dir: string; npmName: string }> = [
${tsPlugins}
];
`;

// ---- Rust 产物 ----
const rustPlugins = src.bundledPlugins
  .map((p) => `    ("${p.dir}", "${p.npmName}"),`)
  .join('\n');
const rust = `//! dsh agent 运行环境版本常量（唯一来源：packages/shared/agent-versions.json）
//!
//! 由 \`scripts/generate-agent-versions.cjs\` 自动生成。禁止手动修改本文件；
//! 修改版本请编辑 JSON 源文件后运行 \`pnpm run generate-agent-versions\`。

/// dsh 0.1.x 要求 ^22.19 || >=24；选 24 LTS 官方 CI 主力线。
pub const NODE_VERSION: &str = "${src.nodeVersion}";

/// 钉死的 dsh npm 版本（锁版本升级走 D5 受控机制）。
pub const DSH_NPM_SPEC: &str = "${src.dshNpmSpec}";

/// dsh NPM 镜像（国内加速；与 resource_manager 多主机测速体系后续对齐）。
pub const NPM_REGISTRY: &str = "${src.npmRegistry}";

/// 随客户端分发的 dsh 插件清单：(子目录, npm 包名)。
pub const BUNDLED_PLUGINS: &[(&str, &str)] = &[
${rustPlugins}
];
`;

fs.writeFileSync(TS_OUT, ts);
fs.writeFileSync(RUST_OUT, rust);
console.log(`[generate-agent-versions] wrote ${path.relative(ROOT, TS_OUT)}`);
console.log(`[generate-agent-versions] wrote ${path.relative(ROOT, RUST_OUT)}`);
