#!/usr/bin/env node

/**
 * App windows generator — SINGLE SOURCE OF TRUTH: packages/shared/app-windows.json
 *
 * 所有「标准应用窗口」（有边框、可缩放、可居中的普通窗口）统一以
 * `packages/shared/app-windows.json` 为唯一来源。本脚本从该 JSON 生成：
 *   1. Rust 侧：`src/apps/desktop/src/window_registry.rs`（APP_WINDOWS 常量表）
 *   2. TS 侧：`src/web-ui/src/infrastructure/windows/windowRegistry.ts`
 *
 * 为什么需要它：新增一个窗口原本要手改 4 处（建窗模块、命令注册、vite input、
 * capabilities），且 Rust 与 TS 两侧的 label/page 容易写漂移。改为「JSON 加一条
 * + 生成两侧常量」后，只剩 html/entry 与 vite input 需要手改，并由
 * `scripts/check-app-windows.mjs` 兜底校验。
 *
 * 注意：本表只覆盖「标准应用窗口」。`overlay` / `underlays` / `loader` / `preview`
 * 这类特殊窗口（透明穿透 / 无边框 / 置顶 / 不可缩放）保留各自实现，不进本表。
 *
 * 用法：`pnpm run generate-app-windows`
 * 触发：`pnpm run generate-all`（prebuild 链路）会自动执行。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSON_SRC = path.join(ROOT, 'packages/shared/app-windows.json');
const RUST_OUT = path.join(ROOT, 'src/apps/desktop/src/window_registry.rs');
const TS_OUT = path.join(ROOT, 'src/web-ui/src/infrastructure/windows/windowRegistry.ts');

/** Rust 字符串字面量（转义反斜杠与双引号） */
function rustStr(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** TS 单引号字符串字面量 */
function tsStr(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** 数值字段校验：必须是有限数字 */
function num(w, key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`[generate-app-windows] window "${w.id}": field "${key}" must be a finite number`);
  }
  return value;
}

/** 布尔字段校验 */
function bool(w, key, value) {
  if (typeof value !== 'boolean') {
    throw new Error(`[generate-app-windows] window "${w.id}": field "${key}" must be a boolean`);
  }
  return value;
}

/** 字符串字段校验（非空） */
function str(w, key, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[generate-app-windows] window "${w.id}": field "${key}" must be a non-empty string`);
  }
  return value;
}

function validate(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error('[generate-app-windows] app-windows.json must be a non-empty array');
  }
  const ids = new Set();
  const labels = new Set();
  for (const w of windows) {
    if (!w || typeof w !== 'object') {
      throw new Error('[generate-app-windows] every entry must be an object');
    }
    const id = str(w, 'id', w.id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`[generate-app-windows] window id "${id}" must be lowercase kebab-case`);
    }
    if (ids.has(id)) throw new Error(`[generate-app-windows] duplicate window id: ${id}`);
    ids.add(id);

    const label = str(w, 'label', w.label);
    if (labels.has(label)) throw new Error(`[generate-app-windows] duplicate window label: ${label}`);
    labels.add(label);

    const page = str(w, 'page', w.page);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(page)) {
      throw new Error(`[generate-app-windows] window "${id}": page "${page}" must be a kebab-case file stem`);
    }

    str(w, 'title', w.title);
    for (const key of ['width', 'height', 'minWidth', 'minHeight']) num(w, key, w[key]);
    for (const key of ['resizable', 'center', 'decorations', 'transparent', 'alwaysOnTop', 'skipTaskbar', 'injectTheme']) {
      bool(w, key, w[key]);
    }
  }
}


function rustLiteral(w) {
  return [
    '    AppWindowSpec {',
    `        id: ${rustStr(w.id)},`,
    `        label: ${rustStr(w.label)},`,
    `        title: ${rustStr(w.title)},`,
    `        page: ${rustStr(w.page)},`,
    `        width: ${w.width}.0,`,
    `        height: ${w.height}.0,`,
    `        min_width: ${w.minWidth}.0,`,
    `        min_height: ${w.minHeight}.0,`,
    `        resizable: ${w.resizable},`,
    `        center: ${w.center},`,
    `        decorations: ${w.decorations},`,
    `        transparent: ${w.transparent},`,
    `        always_on_top: ${w.alwaysOnTop},`,
    `        skip_taskbar: ${w.skipTaskbar},`,
    `        inject_theme: ${w.injectTheme},`,
    '    },',
  ].join('\n');
}

function tsLiteral(w) {
  return [
    `  ${tsStr(w.id)}: {`,
    `    id: ${tsStr(w.id)},`,
    `    label: ${tsStr(w.label)},`,
    `    title: ${tsStr(w.title)},`,
    `    page: ${tsStr(w.page)},`,
    `    width: ${w.width},`,
    `    height: ${w.height},`,
    `  },`,
  ].join('\n');
}

function generateRust(windows) {
  return `//! 应用窗口注册表（唯一来源）
//!
//! 由 \`scripts/generate-app-windows.cjs\` 从 \`packages/shared/app-windows.json\` 自动生成。
//! 禁止手动修改本文件；新增/调整窗口请编辑 JSON 源文件后运行
//! \`pnpm run generate-app-windows\`。
//! 前端 TS 侧对应 \`src/web-ui/src/infrastructure/windows/windowRegistry.ts\`。
//!
//! 只覆盖「标准应用窗口」。overlay / underlays / loader / preview 这类特殊窗口
//! （透明穿透 / 无边框 / 置顶 / 不可缩放）保留各自实现，不进本表。

/// 一个标准应用窗口的静态描述。
///
/// 窗口属性全部由本表锁死：前端只能凭 \`id\` 请求开窗，无法指定 URL、尺寸或
/// 是否置顶，避免任意字符串建窗带来的注入面。
#[derive(Debug, Clone, Copy)]
pub struct AppWindowSpec {
    /// 前端使用的白名单 id（\`open_app_window\` 的参数）
    pub id: &'static str,
    /// Tauri 窗口 label
    pub label: &'static str,
    /// 原生标题栏标题
    pub title: &'static str,
    /// \`dist/main\` 下的页面名，对应 \`<page>.html\`
    pub page: &'static str,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub resizable: bool,
    pub center: bool,
    pub decorations: bool,
    pub transparent: bool,
    pub always_on_top: bool,
    pub skip_taskbar: bool,
    /// 建窗时注入主题首帧脚本（避免首帧闪白）
    pub inject_theme: bool,
}

/// 全部标准应用窗口
pub const APP_WINDOWS: &[AppWindowSpec] = &[
${windows.map(rustLiteral).join('\n')}
];
`;
}

function generateTs(windows) {
  const union = windows.map((w) => tsStr(w.id)).join(' | ');
  const ids = windows.map((w) => tsStr(w.id)).join(', ');
  return `/**
 * 应用窗口注册表（唯一来源）
 *
 * 由 \`scripts/generate-app-windows.cjs\` 从 \`packages/shared/app-windows.json\` 自动生成。
 * 禁止手动修改本文件；新增/调整窗口请编辑 JSON 源文件后运行
 * \`pnpm run generate-app-windows\`。
 * Rust 侧对应 \`src/apps/desktop/src/window_registry.rs\`。
 *
 * 窗口的真实属性（尺寸 / URL / decorations / 是否置顶）以 Rust 侧注册表为准，
 * 本表只用于前端类型约束与展示信息（如标题）。
 */

export type AppWindowId = ${union}

export interface AppWindowDef {
  id: AppWindowId
  /** Tauri 窗口 label */
  label: string
  /** 原生标题栏标题 */
  title: string
  /** \`dist/main\` 下的页面名 */
  page: string
  width: number
  height: number
}

export const APP_WINDOW_REGISTRY: Record<AppWindowId, AppWindowDef> = {
${windows.map(tsLiteral).join('\n')}
}

export const APP_WINDOW_IDS: readonly AppWindowId[] = [${ids}]
`;
}

function main() {
  const windows = JSON.parse(fs.readFileSync(JSON_SRC, 'utf-8'));
  validate(windows);

  fs.mkdirSync(path.dirname(RUST_OUT), { recursive: true });
  fs.mkdirSync(path.dirname(TS_OUT), { recursive: true });
  fs.writeFileSync(RUST_OUT, generateRust(windows));
  fs.writeFileSync(TS_OUT, generateTs(windows));

  console.log(`[generate-app-windows] Wrote ${path.relative(ROOT, RUST_OUT)}`);
  console.log(`[generate-app-windows] Wrote ${path.relative(ROOT, TS_OUT)}`);
  console.log(`[generate-app-windows] Done. ${windows.length} window(s): ${windows.map((w) => w.id).join(', ')}`);
}

main();
