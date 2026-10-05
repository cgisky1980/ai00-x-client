#!/usr/bin/env node
/**
 * @ai00-x/design-system 风格包契约校验（规范第九节 9.2/9.5/9.6）
 *
 * 在 build-tokens.mjs 之后运行（package.json 的 build 链）。与构建期校验的分工：
 *   构建期（build-tokens.mjs）：id 一致 / 顶层只允许 base·light·dark·alias /
 *                              覆盖路径必须已存在 / 恰一个默认包
 *   本脚本（契约层）：          产物齐备 / 明暗分档变量名一致 / 形态变量契约完整 /
 *                              每个包都能被 ThemeService 识别（注册表齐全）
 *
 * 用法：pnpm build（自动串在 token 构建之后）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stylesDir = join(pkgRoot, 'styles');
const MODE_KEYS = ['base', 'light', 'dark'];

/** 形态变量契约（规范 9.4）：必须由基座给出默认值，风格包按需覆盖 */
const CONTRACT_VARS = ['--style-stroke-width', '--style-focus-ring'];

const fail = [];
const note = (msg) => fail.push(msg);

// ---------- 基座 token 变量名（从生成产物读，避免与构建逻辑重复实现） ----------
const tokensCss = readFileSync(join(pkgRoot, 'css', 'tokens.css'), 'utf8');
const rootBlock = tokensCss.slice(tokensCss.indexOf(':root {'), tokensCss.indexOf("html[data-theme-type='light']"));
const baseVars = new Set(
  [...rootBlock.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]),
);

for (const v of CONTRACT_VARS) {
  if (!baseVars.has(v)) note(`基座缺少形态变量契约 ${v}（应为 tokens/primitives.json 的 style.* 默认值）`);
}

// ---------- 逐个风格包 ----------
if (!existsSync(stylesDir)) {
  console.log('[style-packs] 未发现 styles/ 目录（无风格包，跳过）');
  process.exit(0);
}

const registrySrc = readFileSync(join(pkgRoot, 'src', 'stylePacks.ts'), 'utf8');
const ids = readdirSync(stylesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let defaults = 0;

for (const id of ids) {
  const dir = join(stylesDir, id);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.id !== id) note(`风格包 ${id}: manifest.id (${manifest.id}) 与目录名不一致`);
  if (manifest.default === true) defaults += 1;
  for (const k of ['name', 'description']) {
    if (!manifest[k]) note(`风格包 ${id}: manifest.${k} 缺失`);
  }

  // 产物齐备
  if (!existsSync(join(pkgRoot, 'css', 'style-packs', `${id}.css`)))
    note(`风格包 ${id}: 缺少生成产物 css/style-packs/${id}.css`);
  if (!registrySrc.includes(`"${id}"`)) note(`风格包 ${id}: src/stylePacks.ts 注册表缺失该 id`);

  const tokensPath = join(dir, 'tokens.json');
  if (!existsSync(tokensPath)) continue;
  const raw = JSON.parse(readFileSync(tokensPath, 'utf8'));

  // 明暗分档变量名一致（两档若都写，应覆盖同一批变量——不一致多半是漏改）
  const namesOf = (node) => {
    if (!node) return null;
    const out = new Set();
    const walk = (o, prefix) => {
      for (const [k, v] of Object.entries(o)) {
        if (k.startsWith('$')) continue;
        if (k === 'alias') {
          for (const ak of Object.keys(v)) if (!ak.startsWith('$')) out.add(ak);
          continue;
        }
        const path = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && Object.hasOwn(v, '$value')) out.add(path);
        else if (v && typeof v === 'object') walk(v, path);
      }
    };
    walk(node, '');
    return out;
  };

  const light = namesOf(raw.light);
  const dark = namesOf(raw.dark);
  if (light && dark) {
    const missDark = [...light].filter((k) => !dark.has(k));
    const missLight = [...dark].filter((k) => !light.has(k));
    if (missDark.length || missLight.length)
      note(
        `风格包 ${id}: 明暗分档变量名不一致 — 仅亮档: ${missDark.join(', ') || '无'}; 仅暗档: ${missLight.join(', ') || '无'}`,
      );
  }

  // 覆盖路径必须已存在（再做一次，防止手改产物绕过构建）
  const covered = [];
  for (const key of MODE_KEYS) {
    const node = raw[key];
    if (!node) continue;
    const walk = (o, prefix) => {
      for (const [k, v] of Object.entries(o)) {
        if (k.startsWith('$')) continue;
        if (k === 'alias') {
          for (const ak of Object.keys(v)) if (!ak.startsWith('$')) covered.push(ak);
          continue;
        }
        const path = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && Object.hasOwn(v, '$value')) covered.push(path);
        else if (v && typeof v === 'object') walk(v, path);
      }
    };
    walk(node, '');
  }
  for (const [k, v] of Object.entries(raw.alias ?? {})) if (!k.startsWith('$')) covered.push(k);

  const toVar = (p) => `--${p.replace(/\./g, '-')}`;
  const unknown = covered.filter((p) => !baseVars.has(toVar(p)));
  if (unknown.length) note(`风格包 ${id}: 覆盖了不存在的 token 路径 — ${unknown.join(', ')}`);
}

if (defaults !== 1) note(`风格包必须恰有一个 default:true（当前 ${defaults} 个）`);

if (fail.length) {
  console.error('[style-packs] 契约校验失败：');
  for (const m of fail) console.error(`  ✗ ${m}`);
  process.exit(1);
}
console.log(
  `[style-packs] 契约校验通过：${ids.length} 个风格包` +
    `（${ids.join(', ')}）；形态变量契约 ${CONTRACT_VARS.length} 项；基座 ${baseVars.size} 个变量`,
);