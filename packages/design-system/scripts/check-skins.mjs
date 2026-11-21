#!/usr/bin/env node
/**
 * @ai00-x/design-system 皮肤契约校验（在 build-tokens.mjs 之后运行）
 *   1) 产物齐备
 *   2) tokens.css 里引用的每个 --skin-* 变量，每个内置皮肤的明暗两档都给出了（否则该皮肤下 token 失效）
 *   3) 每个皮肤 × 明暗两档对比度体检（error 阻断，warn 打印）
 *   4) 运行时用户皮肤同样走 core.js checkSkin，故本脚本与设置页编辑器判据一致
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSkin, MODES, skinVars } from '../src/skin/core.js';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fail = [];
for (const f of ['css/tokens.css', 'css/skins.css', 'css/index.css', 'css/fonts.css', 'src/skins.ts'])
  if (!existsSync(join(pkgRoot, f))) fail.push(`缺少产物 ${f}`);

const tokensCss = readFileSync(join(pkgRoot, 'css', 'tokens.css'), 'utf8');
const used = new Set([...tokensCss.matchAll(/var\((--skin-[\w-]+)/g)].map((m) => m[1]));

const src = readFileSync(join(pkgRoot, 'src', 'skins.ts'), 'utf8');
const skins = JSON.parse(src.slice(src.indexOf('= [') + 2, src.lastIndexOf('] as const') + 1));

let warns = 0;
for (const skin of skins) {
  for (const mode of MODES) {
    const vars = skinVars(skin, mode);
    for (const v of used) if (!(v in vars)) fail.push(`${skin.id}/${mode} 未给出 ${v}`);
  }
  for (const i of checkSkin(skin)) {
    const line = `${skin.id}/${i.mode} ${i.label} ${i.ratio.toFixed(2)} < ${i.min}`;
    if (i.level === 'error') fail.push(line);
    else {
      warns += 1;
      console.warn(`[skins] ⚠️ ${line}`);
    }
  }
}

if (fail.length) {
  console.error(`[skins] ✗ 契约校验失败：\n  ${fail.join('\n  ')}`);
  process.exit(1);
}
console.log(`[skins] ✓ ${skins.length} 个皮肤 × 明暗两档：契约 ${used.size} 个种子变量齐备，对比度合格（警告 ${warns}）`);
