#!/usr/bin/env node
/**
 * Vditor 增量构建守卫。
 *
 * 背景：`pnpm --dir src/web-ui build` = `build:editor && vite build`，而 build:editor
 * 是 webpack 全量重建 524 个源文件 × 4 entry（~23s）。但绝大多数前端改动都不碰
 * packages/vditor/src —— 那 23s 纯属浪费。更糟的是 webpack 的 CleanWebpackPlugin
 * 会先清空 dist/，若构建被中断，dist/js/ 会只剩空目录（387 个文件缺失），
 * 随后 vite 解析 `@ai00-x/vditor/dist/js/lute/lute.min.js?url` 失败，整条构建链挂掉。
 *
 * 本脚本：
 *   1. 比对 src/ 下所有源文件与 dist/index.min.js（webpack 产物）的 mtime
 *   2. 若 dist 缺失关键产物 → 立刻报错（而不是让 vite 在 30s 后给出难懂的 rollup 错误）
 *   3. 若 src 比 dist 新 → 交给 webpack 重建
 *   4. 若 src 比 dist 旧且产物完整 → 跳过（除非 --force）
 *
 * 用法：
 *   node scripts/build-vditor-guard.mjs          # 智能跳过或重建
 *   node scripts/build-vditor-guard.mjs --force  # 强制重建
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkgDir = path.join(root, 'packages', 'vditor');
const srcDir = path.join(pkgDir, 'src');
const distDir = path.join(pkgDir, 'dist');

const force = process.argv.includes('--force');

/** webpack 必产物：缺失即说明上次构建被中断 */
const REQUIRED = [
  'index.js',
  'index.min.js',
  'index.css',
  // CopyPlugin 的目标：这些是运行时按需 fetch 的，缺一个就会在特定场景炸
  'js/lute/lute.min.js',
  'js/mermaid/mermaid.min.js',
  'js/highlight.js/highlight.min.js',
  'js/katex/katex.min.js',
  'js/i18n/zh_CN.js',
];

function latestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(dir);
  return newest;
}

function missingRequired() {
  return REQUIRED.filter((rel) => !fs.existsSync(path.join(distDir, rel)));
}

function runWebpack() {
  console.log('[vditor] 正在重建（webpack）…');
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const r = spawnSync(pnpmCmd, ['exec', 'webpack'], {
    cwd: pkgDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error('[vditor] 重建失败，退出。');
    process.exit(r.status ?? 1);
  }
}

// 1) 产物缺失 → 必须重建；重建后仍缺则报错（防再次静默产出半成品）
const missingBefore = missingRequired();
if (missingBefore.length > 0) {
  console.warn(
    `[vditor] 检测到 ${missingBefore.length} 个关键产物缺失（上次构建可能被中断）：\n  ` +
      missingBefore.join('\n  '),
  );
  runWebpack();

  const missingAfter = missingRequired();
  if (missingAfter.length > 0) {
    console.error(
      `[vditor] 重建后仍缺失 ${missingAfter.length} 个产物，请检查 CopyPlugin / 磁盘权限：\n  ` +
        missingAfter.join('\n  '),
    );
    process.exit(1);
  }
  console.log('[vditor] 重建完成，产物完整。');
  process.exit(0);
}

// 2) 产物存在：比对 src 与 dist 新旧
const distMtime = fs.statSync(path.join(distDir, 'index.min.js')).mtimeMs;
const srcMtime = latestMtime(srcDir);

if (!force && srcMtime <= distMtime) {
  console.log('[vditor] src 无变更，跳过重建（省 ~23s）。强制重建：--force');
  process.exit(0);
}

if (force) console.log('[vditor] --force 指定，强制重建。');
else console.log('[vditor] src 有更新，需要重建。');
runWebpack();
