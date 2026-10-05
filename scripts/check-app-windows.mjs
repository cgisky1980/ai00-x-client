#!/usr/bin/env node

/**
 * 窗口注册表防漂移校验。
 *
 * `packages/shared/app-windows.json` 是标准应用窗口的唯一真源，但它管不到两件事：
 *   1. `dist/main` 里到底有没有对应的 `<page>.html`；
 *   2. `vite.config.ts` 的 `rollupOptions.input` 有没有把该页面纳入构建。
 * 少了任一项，窗口会「建得出来但打开是 404/白屏」，而且编译器不会报错。
 * 本脚本把这两个断链点变成硬失败。
 *
 * 反向也查一次：`src/web-ui` 下除白名单外的 html 都必须登记进注册表，
 * 避免新增页面时忘了登记（那时会静默地退化成"只有 rust 手写建窗才能打开"）。
 *
 * 用法：`pnpm run check:windows`（已挂在 desktop:build 前置链路）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_SRC = path.join(ROOT, 'packages/shared/app-windows.json');
const VITE_CONF = path.join(ROOT, 'src/web-ui/vite.config.ts');
const WEB_UI_DIR = path.join(ROOT, 'src/web-ui');

/**
 * 不登记进注册表的 html：
 * - index.html   主壳（overlay 窗口承载，特殊窗口）
 * - design.html  设计系统展示页（非应用窗口）
 * - preview.html 预览窗（无边框/不可缩放的特殊窗口，保留各自实现）
 */
const UNREGISTERED_HTML_ALLOWLIST = new Set(['index.html', 'design.html', 'preview.html']);

const errors = [];

function fail(message) {
  errors.push(message);
}

function main() {
  const windows = JSON.parse(fs.readFileSync(JSON_SRC, 'utf-8'));
  const viteConf = fs.readFileSync(VITE_CONF, 'utf-8');

  // vite.config.ts 的 rollupOptions.input 里登记的 html（形如 path.resolve(__dirname, 'x.html')）
  const viteInputs = new Set();
  const inputRe = /path\.resolve\(\s*__dirname\s*,\s*'([^']+\.html)'\s*\)/g;
  for (const m of viteConf.matchAll(inputRe)) {
    viteInputs.add(m[1]);
  }
  if (viteInputs.size === 0) {
    fail(`未能从 ${path.relative(ROOT, VITE_CONF)} 解析出任何 rollupOptions.input，请检查该文件是否被重构`);
  }

  const registeredHtml = new Set();

  for (const w of windows) {
    const htmlFile = `${w.page}.html`;
    registeredHtml.add(htmlFile);

    const htmlPath = path.join(WEB_UI_DIR, htmlFile);
    if (!fs.existsSync(htmlPath)) {
      fail(`窗口 "${w.id}" 声明 page="${w.page}"，但 ${path.relative(ROOT, htmlPath)} 不存在`);
      continue;
    }

    if (!viteInputs.has(htmlFile)) {
      fail(
        `窗口 "${w.id}" 的 ${htmlFile} 未登记进 vite.config.ts 的 rollupOptions.input ` +
          `（会导致该窗口打开为 404/白屏）`
      );
    }
  }

  // 反向校验：新增 html 忘了登记
  for (const entry of fs.readdirSync(WEB_UI_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    if (UNREGISTERED_HTML_ALLOWLIST.has(entry.name)) continue;
    if (!registeredHtml.has(entry.name)) {
      fail(
        `src/web-ui/${entry.name} 既未登记进 app-windows.json，也不在特殊页白名单里。` +
          `若是标准应用窗口请补一条注册表条目；若是有意为之请加入 UNREGISTERED_HTML_ALLOWLIST`
      );
    }
  }

  if (errors.length > 0) {
    console.error('[check-app-windows] 校验失败：');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `[check-app-windows] OK — ${windows.length} 个标准窗口（${windows.map((w) => w.id).join(', ') || '无'}）` +
      `，vite input ${viteInputs.size} 个页面`
  );
}

main();
