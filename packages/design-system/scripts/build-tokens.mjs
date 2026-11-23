#!/usr/bin/env node
/**
 * @ai00-x/design-system 构建（规范 v1.0：皮肤 = 种子 → 派生）
 *
 * 输入（人只改这里）：
 *   tokens/primitives.json   原子刻度（尺寸/动效/层级；颜色类原子引用 --skin-* 种子）
 *   tokens/semantic.json     语义 token：全部由 --skin-* 种子经 color-mix 派生（明暗共用一套公式）
 *   tokens/aliases.json      兼容名（key 即完整 token 路径）
 *   skins/*.ai00skin.json    内置皮肤（由 scripts/skin-from-taste.mjs 从 taste-skill 发牌生成）
 * 输出：
 *   css/tokens.css           :root 全部 token（值为 var(--skin-*) 派生公式）
 *   css/skins.css            每个内置皮肤的种子块：html[data-skin=id] 暗色 / …[data-theme-type=light] 亮色；
 *                            默认皮肤同时挂 :where(:root) 兜底（无 data-skin 的入口也能显示）
 *   css/tw-theme.css / css/index.css / css/tokens.standalone.css
 *   src/tokens.ts            TS 常量（引用已解析）
 *   src/skins.ts             内置皮肤注册表（Skin 对象，运行时与编辑器共用）
 *
 * 转换规则：JSON 路径 1:1 直出变量名（"." → "-"）；整值 "{a.b}" → var(--a-b)；无映射表。
 * 用法：pnpm build（在 client/packages/design-system 下）
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSkin, parseSkin, skinCss } from '../src/skin/core.js';
import { expandSingleSource } from './derive-skin.mjs';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (...p) => JSON.parse(readFileSync(join(pkgRoot, ...p), 'utf8'));

const primitives = readJson('tokens', 'primitives.json');
const semantic = readJson('tokens', 'semantic.json');
const aliasGroup = readJson('tokens', 'aliases.json').alias;

// ---------- 展开 JSON 树 → { '完整.路径': rawValue } ----------
function flatten(node, prefix, out) {
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && Object.hasOwn(child, '$value')) out[path] = child.$value;
    else if (child && typeof child === 'object') flatten(child, path, out);
  }
  return out;
}

const primVars = flatten(primitives, '', {});
const semVars = flatten(semantic, '', {});
const aliasVars = {};
for (const [key, child] of Object.entries(aliasGroup)) aliasVars[key] = child.$value;

const all = [...Object.keys(primVars), ...Object.keys(semVars), ...Object.keys(aliasVars)];
const dup = all.filter((k, i) => all.indexOf(k) !== i);
if (dup.length) throw new Error(`重复 token 路径: ${dup.join(', ')}`);
const map = { ...primVars, ...semVars, ...aliasVars };

// ---------- 引用解析 ----------
const cssName = (path) => `--${path.replace(/\./g, '-')}`;
const REF = /^\{([^}]+)\}$/;
const refPath = (v) => (typeof v === 'string' ? v.trim().match(REF)?.[1] : undefined);
const cssValue = (v) => {
  const p = refPath(v);
  return p ? `var(${cssName(p)})` : String(v);
};
function resolveLiteral(v, seen = new Set()) {
  const p = refPath(v);
  if (!p) return String(v);
  if (seen.has(p)) throw new Error(`循环引用: ${p}`);
  if (!(p in map)) throw new Error(`未知引用: {${p}}`);
  return resolveLiteral(map[p], new Set([...seen, p]));
}
for (const [k, v] of Object.entries(map)) {
  try {
    resolveLiteral(v);
  } catch (e) {
    throw new Error(`${k}: ${e.message}`);
  }
  if (typeof v === 'string' && v.includes('{') && !refPath(v))
    throw new Error(`${k}: 复合值里的 {…} 不会转成 var()，请写显式 var(--name)：${v}`);
}

// ---------- 内置皮肤 ----------
const skinsDir = join(pkgRoot, 'skins');
const skinFiles = existsSync(skinsDir) ? readdirSync(skinsDir).filter((f) => f.endsWith('.ai00skin.json')).sort() : [];
const skins = skinFiles.map((f) => {
  // 单源皮肤（有 palette）：先派生明暗两档，再走原有 parseSkin 链。
  // 旧格式（用户皮肤 / 未迁移皮肤）原样通过，下游零改动。
  const raw = expandSingleSource(JSON.parse(readFileSync(join(skinsDir, f), 'utf8')));
  const { skin, errors } = parseSkin(raw);
  if (!skin) throw new Error(`skins/${f} 不合法：\n  ${errors.join('\n  ')}`);
  if (`${skin.id}.ai00skin.json` !== f) throw new Error(`skins/${f}: 文件名必须是 <id>.ai00skin.json（id=${skin.id}）`);
  const bad = checkSkin(skin).filter((i) => i.level === 'error');
  if (bad.length)
    throw new Error(`skins/${f} 对比度不合格：${bad.map((i) => `${i.mode} ${i.label} ${i.ratio.toFixed(2)}<${i.min}`).join('; ')}`);
  return skin;
});
const order = readJson('skins', 'order.json');
const DEFAULT_SKIN_ID = order[0];
skins.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const missing = skins.filter((s) => !order.includes(s.id)).map((s) => s.id);
if (missing.length) throw new Error(`skins/order.json 缺少：${missing.join(', ')}`);
if (!skins.some((s) => s.id === DEFAULT_SKIN_ID)) throw new Error(`默认皮肤 ${DEFAULT_SKIN_ID} 不存在`);

// ---------- 产物 1：css/tokens.css ----------
const section = (title, vars) =>
  `  /* ==== ${title} ==== */\n` +
  Object.entries(vars)
    .map(([p, v]) => `  ${cssName(p)}: ${cssValue(v)};`)
    .join('\n');

const tokensCss = `/* ============================================================
 * @ai00-x/design-system tokens — AUTO-GENERATED（pnpm build 产物，勿手改）
 * 源：tokens/{primitives,semantic,aliases}.json
 * 值全部由 --skin-* 种子派生；种子由皮肤给出（css/skins.css 或运行时 <style id="ai00-skin">）。
 * 规范：参考/前端视觉设计规范.md（v1.0 第二节）
 * ============================================================ */
:root {
${section('primitives · 刻度', primVars)}

${section('semantic · 种子派生', semVars)}

${section('alias · 兼容名', aliasVars)}
}
`;

// ---------- 产物 2：css/skins.css ----------
const skinSelector = (skin) =>
  skin.id === DEFAULT_SKIN_ID ? `:where(:root), html[data-skin='${skin.id}']` : `html[data-skin='${skin.id}']`;
const skinsCss = `/* ============================================================
 * @ai00-x/design-system 内置皮肤 — AUTO-GENERATED（勿手改）
 * 源：skins/*.ai00skin.json（taste-skill 发牌生成）｜ 默认：${DEFAULT_SKIN_ID}
 * html[data-skin=<id>] = 暗色档；再加 [data-theme-type='light'] = 亮色档
 * ============================================================ */
${skins.map((s) => `/* ---- ${s.name}（${s.id}） ---- */\n${skinCss(s, skinSelector(s))}`).join('\n')}`;

// ---------- 产物 3：css/tw-theme.css ----------
const twMap = {
  '--color-bg-primary': 'var(--color-bg-primary)',
  '--color-bg-secondary': 'var(--color-bg-secondary)',
  '--color-bg-tertiary': 'var(--color-bg-tertiary)',
  '--color-bg-quaternary': 'var(--color-bg-quaternary)',
  '--color-bg-elevated': 'var(--color-bg-elevated)',
  '--color-bg-workbench': 'var(--color-bg-workbench)',
  '--color-bg-scene': 'var(--color-bg-scene)',
  '--color-bg-card': 'var(--color-bg-card)',
  '--color-bg-overlay': 'var(--color-bg-overlay)',
  '--color-bg-modal': 'var(--color-bg-modal)',
  '--color-text-primary': 'var(--color-text-primary)',
  '--color-text-secondary': 'var(--color-text-secondary)',
  '--color-text-muted': 'var(--color-text-muted)',
  '--color-text-disabled': 'var(--color-text-disabled)',
  '--color-accent': 'var(--color-accent)',
  '--color-accent-300': 'var(--color-accent-300)',
  '--color-accent-400': 'var(--color-accent-400)',
  '--color-accent-500': 'var(--color-accent-500)',
  '--color-accent-600': 'var(--color-accent-600)',
  '--color-success': 'var(--color-success)',
  '--color-warning': 'var(--color-warning)',
  '--color-error': 'var(--color-error)',
  '--color-info': 'var(--color-info)',
  '--color-brand-seal': 'var(--color-brand-seal)',
  '--color-brand-seal-foreground': 'var(--color-brand-seal-foreground)',
  '--color-line-subtle': 'var(--border-subtle)',
  '--color-line-base': 'var(--border-base)',
  '--color-line-medium': 'var(--border-medium)',
  '--color-line-strong': 'var(--border-strong)',
  '--radius-sm': 'var(--size-radius-sm)',
  '--radius-md': 'var(--size-radius-base)',
  '--radius-lg': 'var(--size-radius-lg)',
  '--radius-xl': 'var(--size-radius-xl)',
  '--radius-2xl': 'var(--size-radius-2xl)',
  '--font-sans': 'var(--font-family-sans)',
  '--font-serif': 'var(--font-family-display)',
  '--font-display': 'var(--font-family-display)',
  '--font-mono': 'var(--font-family-mono)',
  // shadcn 语义名
  '--color-background': 'var(--color-bg-base)',
  '--color-foreground': 'var(--color-text-primary)',
  '--color-card': 'var(--color-bg-card)',
  '--color-card-foreground': 'var(--color-text-primary)',
  '--color-popover': 'var(--color-bg-overlay)',
  '--color-popover-foreground': 'var(--color-text-primary)',
  '--color-primary': 'var(--color-accent-500)',
  '--color-primary-foreground': 'var(--color-accent-foreground)',
  '--color-secondary': 'var(--element-bg-base)',
  '--color-secondary-foreground': 'var(--color-text-primary)',
  '--color-muted': 'var(--element-bg-base)',
  '--color-muted-foreground': 'var(--color-text-muted)',
  '--color-destructive': 'var(--color-error)',
  '--color-destructive-foreground': 'var(--color-bg-base)',
  '--color-border': 'var(--border-base)',
  '--color-input': 'var(--input-border)',
  '--color-ring': 'var(--color-accent-400)',
};
const twTheme = `/* @ai00-x/design-system Tailwind v4 主题 — AUTO-GENERATED（勿手改）
 * 用法：@import "@ai00-x/design-system/styles"; @import "@ai00-x/design-system/tw"; */
@theme inline {
${Object.entries(twMap)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join('\n')}
}
`;

// ---------- 产物 4：src/tokens.ts ----------
const tokensTs = `// AUTO-GENERATED by scripts/build-tokens.mjs — 勿手改
// 全量设计令牌（引用已解析；颜色值是 var(--skin-*) 派生公式，随皮肤变化）。
export const tokens = {
${Object.keys(map)
  .map((p) => `  '${p}': ${JSON.stringify(resolveLiteral(map[p]))},`)
  .join('\n')}
} as const;

export type TokenName = keyof typeof tokens;

export function token(name: TokenName): string {
  return tokens[name];
}
`;

// ---------- 产物 5：src/skins.ts ----------
const skinsTs = `// AUTO-GENERATED by scripts/build-tokens.mjs — 勿手改
// 内置皮肤注册表。源：skins/*.ai00skin.json（taste-skill 发牌生成），顺序：skins/order.json
import type { Skin } from './skin/core';

export const DEFAULT_SKIN_ID = ${JSON.stringify(DEFAULT_SKIN_ID)};

export const builtinSkins: readonly Skin[] = ${JSON.stringify(skins, null, 2)} as const as readonly Skin[];
`;

// ---------- 写文件 ----------
mkdirSync(join(pkgRoot, 'css'), { recursive: true });
const write = (rel, text) => writeFileSync(join(pkgRoot, rel), text, 'utf8');
write('css/tokens.css', tokensCss);
write('css/skins.css', skinsCss);
write('css/tw-theme.css', twTheme);
write('src/tokens.ts', tokensTs);
write('src/skins.ts', skinsTs);
write(
  'css/index.css',
  `/* @ai00-x/design-system 样式聚合入口 — AUTO-GENERATED（勿手改）
 * 消费方用法：import "@ai00-x/design-system/styles"（JS 副作用导入，字体 url 才走得进打包器资产管线）
 * Tailwind v4 消费方另加：@import "@ai00-x/design-system/tw"; */
@import './tokens.css';
@import './skins.css';
@import './fonts.css';
@import './motion.css';
@import './components.css';
`,
);
const readCss = (f) => readFileSync(join(pkgRoot, 'css', f), 'utf8');
write(
  'css/tokens.standalone.css',
  `/* @ai00-x/design-system standalone — AUTO-GENERATED（tokens + 内置皮肤 + 动效 + 组件，单文件内联用；字体请另行引入） */\n${[
    tokensCss,
    skinsCss,
    readCss('motion.css'),
    readCss('components.css'),
  ].join('\n')}\n`,
);

console.log(
  `[design-system] 构建完成：${Object.keys(map).length} 个 token（primitives ${Object.keys(primVars).length} + semantic ${Object.keys(semVars).length} + alias ${Object.keys(aliasVars).length}）` +
    `\n  内置皮肤 ${skins.length} 个：${skins.map((s) => (s.id === DEFAULT_SKIN_ID ? `${s.id}(默认)` : s.id)).join(', ')}` +
    `\n  → css/{tokens,skins,tw-theme,index,tokens.standalone}.css · src/{tokens,skins}.ts`,
);
