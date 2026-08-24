#!/usr/bin/env node
/**
 * @ai00-x/design-system 设计令牌构建
 *
 * 输入：tokens/{primitives,semantic.dark,semantic.light,aliases}.json（DTCG 2025.10，人只改这里）
 *       + 手写 css/texture.css（宣纸颗粒）、css/motion.css（签名动效）
 * 输出：css/tokens.css（:root 暗色默认 + [data-theme="light"] 宣纸覆盖 + 别名）
 *       css/tw-theme.css（Tailwind v4 @theme inline 映射）
 *       css/index.css（聚合入口：@import 四件套）
 *       css/tokens.standalone.css（单文件全量：变量+纸纹+动效，供官网/Relay 内联）
 *       src/tokens.ts（TS 常量，引用已解析为最终字面值）
 *
 * 转换规则（规范 3.1/3.2，勿添加映射表）：
 *   1) JSON 分组路径 1:1 直出 CSS 变量名：color.bg.primary → --color-bg-primary（仅做 "." → "-" 机械转换）
 *   2) $value 中的 "{a.b.c}" 引用 → var(--a-b-c)；别名关系在数据里，不在代码里
 *   3) aliases.json 的 alias 组：key 本身就是完整 token 路径（用于 ThemeService 兼容名
 *      与"基名+子名冲突"的 token，如 color.accent 基名 vs color.accent.500 子名）
 *
 * 用法：pnpm build（在 client/packages/design-system 下）
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readToken = (file) => JSON.parse(readFileSync(join(pkgRoot, 'tokens', file), 'utf8'));

const primitives = readToken('primitives.json');
const semantic = readToken('semantic.dark.json');
const semanticLightPath = join(pkgRoot, 'tokens', 'semantic.light.json');
const semanticLight = existsSync(semanticLightPath) ? readToken('semantic.light.json') : null;
const aliasGroup = readToken('aliases.json').alias;

// ---------- 展开 JSON 树 → { '完整.路径': rawValue } ----------
function flatten(node, prefix, out) {
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$')) continue; // $description/$type 等 DTCG 元属性不是 token
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && Object.hasOwn(child, '$value')) {
      out[path] = child.$value;
    } else if (child && typeof child === 'object') {
      flatten(child, path, out);
    }
  }
  return out;
}

const primVars = flatten(primitives, '', {});
const semVars = flatten(semantic, '', {});
const lightVars = semanticLight ? flatten(semanticLight, '', {}) : {};
const aliasVars = {};
for (const [key, child] of Object.entries(aliasGroup)) aliasVars[key] = child.$value;

// 汇总表（供引用解析与查重；亮色与暗色变量名集合必须一致）
const map = { ...primVars, ...semVars, ...aliasVars };
const dup = Object.keys(map).filter((k, i, a) => a.indexOf(k) !== i);
if (dup.length) throw new Error(`重复 token 路径: ${dup.join(', ')}`);
if (semanticLight) {
  const missing = Object.keys(semVars).filter((k) => !(k in lightVars));
  const extra = Object.keys(lightVars).filter((k) => !(k in semVars));
  if (missing.length || extra.length)
    throw new Error(`亮暗变量名不一致 — 缺失: ${missing.join(', ') || '无'}; 多出: ${extra.join(', ') || '无'}`);
}

// ---------- 引用解析 ----------
const cssName = (path) => `--${path.replace(/\./g, '-')}`;
const REF = /^\{([^}]+)\}$/;
const refPath = (v) => (typeof v === 'string' ? v.trim().match(REF)?.[1] : undefined);

// CSS 值：引用 → var()；其余原样（含 color-mix 等复杂值）
const cssValue = (v) => {
  const p = refPath(v);
  return p ? `var(${cssName(p)})` : String(v);
};

// TS 值：递归解析引用为最终字面值
function resolveLiteral(v, seen = new Set()) {
  const p = refPath(v);
  if (!p) return String(v);
  if (seen.has(p)) throw new Error(`循环引用: ${p}`);
  if (!(p in map)) throw new Error(`未知引用: {${p}}`);
  return resolveLiteral(map[p], seen.union(new Set([p])));
}

// 校验所有引用可解析
for (const [k, v] of Object.entries(map)) {
  try {
    resolveLiteral(v);
  } catch (e) {
    throw new Error(`${k}: ${e.message}`);
  }
}

// ---------- 产物 1：css/tokens.css ----------
const section = (title, vars) =>
  `  /* ==== ${title} ==== */\n` +
  Object.entries(vars)
    .map(([p, v]) => `  ${cssName(p)}: ${cssValue(v)};`)
    .join('\n');

const lightBlock = semanticLight
  ? `\n/* ---------- 亮色主题「宣纸」：[data-theme-type="light"] 覆盖（变量名与暗色一一对应；ThemeService 挂 data-theme-type 于 html） ---------- */\n[data-theme-type='light'] {\n  color-scheme: light;\n\n${section('semantic · 亮色·宣纸（规范 4.1/4.5）', lightVars)}\n}\n`
  : '';

const tokensCss = `/* ============================================================
 * @ai00-x/design-system tokens — AUTO-GENERATED（pnpm build 产物，勿手改）
 * 源：tokens/{primitives,semantic.dark,semantic.light,aliases}.json（DTCG 2025.10）
 * 规范：参考/前端视觉设计规范-新东方极简.md（token 命名 1:1 直出）
 * 主题：:root 为暗色默认「深墨」；[data-theme-type="light"] 为亮色「宣纸」
 * 换肤：色值内嵌 var(--hue/--chroma/--chroma-surface/--gray-level) 回退公式，
 *       ThemeService 覆盖这些变量即整体换肤（朱砂不联动）
 * ============================================================ */
:root {
  color-scheme: dark;

${section('primitives · 刻度与配方', primVars)}

${section('semantic · 暗色默认「深墨」（墨阶/黛青/朱砂）', semVars)}

${section('alias · 兼容名与跨引用（key 即完整变量名）', aliasVars)}
}
${lightBlock}`;

// ---------- 产物 2：css/tw-theme.css（Tailwind v4 工具类映射） ----------
// 选择性映射（非映射表：变量名两侧一致，仅挑选需要工具类化的名字）
const twMap = {
  // 表面
  '--color-bg-primary': 'var(--color-bg-primary)',
  '--color-bg-secondary': 'var(--color-bg-secondary)',
  '--color-bg-tertiary': 'var(--color-bg-tertiary)',
  '--color-bg-quaternary': 'var(--color-bg-quaternary)',
  '--color-bg-elevated': 'var(--color-bg-elevated)',
  '--color-bg-workbench': 'var(--color-bg-workbench)',
  '--color-bg-scene': 'var(--color-bg-scene)',
  // 文字
  '--color-text-primary': 'var(--color-text-primary)',
  '--color-text-secondary': 'var(--color-text-secondary)',
  '--color-text-muted': 'var(--color-text-muted)',
  '--color-text-disabled': 'var(--color-text-disabled)',
  // 交互色阶（Step 3 切换黛青后值自动跟随）
  '--color-accent': 'var(--color-accent)',
  '--color-accent-300': 'var(--color-accent-300)',
  '--color-accent-400': 'var(--color-accent-400)',
  '--color-accent-500': 'var(--color-accent-500)',
  '--color-accent-600': 'var(--color-accent-600)',
  // 语义状态
  '--color-success': 'var(--color-success)',
  '--color-warning': 'var(--color-warning)',
  '--color-error': 'var(--color-error)',
  '--color-info': 'var(--color-info)',
  // 品牌签名·朱砂（规范 2.1/2.5）
  '--color-brand-seal': 'var(--color-brand-seal)',
  '--color-brand-seal-foreground': 'var(--color-brand-seal-foreground)',
  // 墨阶新名（规范 4.1：base/sunken/card/overlay/modal）
  '--color-bg-card': 'var(--color-bg-card)',
  '--color-bg-overlay': 'var(--color-bg-overlay)',
  '--color-bg-modal': 'var(--color-bg-modal)',
  // 边框（border-line-* 工具类）
  '--color-line-subtle': 'var(--border-subtle)',
  '--color-line-base': 'var(--border-base)',
  '--color-line-medium': 'var(--border-medium)',
  '--color-line-strong': 'var(--border-strong)',
  // 圆角（覆盖 TW 默认刻度，rounded-* 与规范刻度一致）
  '--radius-sm': 'var(--radius-sm)',
  '--radius-md': 'var(--radius-base)',
  '--radius-lg': 'var(--radius-lg)',
  '--radius-xl': 'var(--radius-xl)',
  '--radius-2xl': 'var(--radius-2xl)',
  // 字体
  '--font-sans': 'var(--font-family-sans)',
  '--font-serif': 'var(--font-family-serif)',
  '--font-mono': 'var(--font-family-mono)',

  // ==== shadcn 语义名映射（存量 shadcn 类名体系 → 新 token；注意 --color-accent
  //      语义冲突以 ds 体系优先（黛青），shadcn 的 accent-hover 表面不在此映射 ====
  '--color-background': 'var(--color-bg-base)',
  '--color-foreground': 'var(--color-text-primary)',
  '--color-card': 'var(--color-bg-card)',
  '--color-card-foreground': 'var(--color-text-primary)',
  '--color-popover': 'var(--color-bg-overlay)',
  '--color-popover-foreground': 'var(--color-text-primary)',
  '--color-primary': 'var(--color-accent-500)',
  '--color-primary-foreground': 'oklch(0.97 0.01 90)',
  '--color-secondary': 'var(--element-bg-base)',
  '--color-secondary-foreground': 'var(--color-text-primary)',
  '--color-muted': 'var(--element-bg-base)',
  '--color-muted-foreground': 'var(--color-text-muted)',
  '--color-destructive': 'var(--color-error)',
  '--color-destructive-foreground': 'oklch(0.97 0.01 90)',
  '--color-border': 'var(--border-base)',
  '--color-input': 'var(--input-border)',
  '--color-ring': 'var(--color-accent-400)',
};

const twTheme = `/* ============================================================
 * @ai00-x/design-system Tailwind v4 主题 — AUTO-GENERATED（勿手改）
 * 用法（消费方 CSS 入口）：
 *   @import "@ai00-x/design-system/css";   // CSS 变量
 *   @import "@ai00-x/design-system/tw";    // 本文件（@theme inline）
 * 生成 bg-bg-primary / text-text-primary / border-line-base / rounded-lg 等
 * 工具类；@theme inline 使工具类直接引用运行时变量（随 data-theme 切换）。
 * ============================================================ */
@theme inline {
${Object.entries(twMap)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join('\n')}
}
`;

// ---------- 产物 3：src/tokens.ts ----------
const tsEntries = Object.entries(map)
  .map(([p]) => `  '${p}': ${JSON.stringify(resolveLiteral(map[p]))},`)
  .join('\n');

const tokensTs = `// AUTO-GENERATED by scripts/build-tokens.mjs — 勿手改
// 全量设计令牌（引用已解析为最终字面值）。供 JS 侧消费（如 antd ConfigProvider 映射）。
// 类型提示：CSS 变量名 = token 路径的 "." 替换为 "-"
export const tokens = {
${tsEntries}
} as const;

export type TokenName = keyof typeof tokens;

/** 取 token 最终字面值；等价于 CSS 侧 var(--name) 的解析结果 */
export function token(name: TokenName): string {
  return tokens[name];
}
`;

// ---------- 写文件 ----------
mkdirSync(join(pkgRoot, 'css'), { recursive: true });
mkdirSync(join(pkgRoot, 'src'), { recursive: true });
writeFileSync(join(pkgRoot, 'css', 'tokens.css'), tokensCss, 'utf8');
writeFileSync(join(pkgRoot, 'css', 'tw-theme.css'), twTheme, 'utf8');
writeFileSync(join(pkgRoot, 'src', 'tokens.ts'), tokensTs, 'utf8');

// 聚合入口：消费方一次 @import "@ai00-x/design-system/styles" 即全量（变量+纸纹+动效+组件）
const indexCss = `/* @ai00-x/design-system 样式聚合入口 — AUTO-GENERATED（勿手改）
 * 消费方用法：@import "@ai00-x/design-system/styles";
 * Tailwind v4 消费方另加：@import "@ai00-x/design-system/tw"; */
@import './tokens.css';
@import './fonts.css';
@import './texture.css';
@import './motion.css';
@import './components.css';
`;
writeFileSync(join(pkgRoot, 'css', 'index.css'), indexCss, 'utf8');

// 单文件全量（官网/Relay 等静态 HTML 内联用）：变量 + 纸纹 + 动效 + 组件
const readCss = (f) => readFileSync(join(pkgRoot, 'css', f), 'utf8');
const stripImport = (s) => s.replace(/^@import[^;]+;\s*$/gm, '');
const standalone = `/* @ai00-x/design-system standalone — AUTO-GENERATED（tokens + 纸纹 + 动效 + 组件，单文件内联用） */\n${[
  tokensCss,
  stripImport(readCss('texture.css')),
  readCss('motion.css'),
  readCss('components.css'),
].join('\n')}\n`;
writeFileSync(join(pkgRoot, 'css', 'tokens.standalone.css'), standalone, 'utf8');

const total = Object.keys(primVars).length + Object.keys(semVars).length + Object.keys(aliasVars).length;
console.log(
  `[design-system] 构建完成：primitives ${Object.keys(primVars).length} + semantic ${Object.keys(semVars).length} + alias ${Object.keys(aliasVars).length} = ${total} 个 token` +
    (semanticLight ? `（含亮色宣纸覆盖 ${Object.keys(lightVars).length}）` : '') +
    `\n  → css/tokens.css / tw-theme.css / index.css / tokens.standalone.css\n  → src/tokens.ts`,
);
