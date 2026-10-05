#!/usr/bin/env node
/**
 * @ai00-x/design-system 设计令牌构建
 *
 * 输入：tokens/{primitives,semantic.dark,semantic.light,aliases}.json（DTCG 2025.10，人只改这里）
 *       + styles/<id>/{manifest.json,tokens.json,components.css}（风格包，规范第九节，人只改这里）
 *       + 手写 css/texture.css（宣纸颗粒）、css/motion.css（签名动效）
 * 输出：css/tokens.css（:root 暗色默认 + [data-theme-type="light"] 宣纸覆盖 + 别名）
 *       css/style-packs/<id>.css（html[data-style="<id>"] 覆盖 + 风格包组件形态）
 *       css/style-packs.css（风格包聚合，在 tokens.css 之后引入）
 *       css/tw-theme.css（Tailwind v4 @theme inline 映射）
 *       css/index.css（聚合入口：@import 全量）
 *       css/tokens.standalone.css（单文件全量：变量+风格包+纸纹+动效+组件，供官网/Relay 内联）
 *       src/tokens.ts（TS 常量，引用已解析为最终字面值）
 *       src/stylePacks.ts（风格包注册表 + token 映射，供 ThemeService 运行时 inline 注入）
 *
 * 转换规则（规范 3.1/3.2，勿添加映射表）：
 *   1) JSON 分组路径 1:1 直出 CSS 变量名：color.bg.primary → --color-bg-primary（仅做 "." → "-" 机械转换）
 *   2) $value 中的 "{a.b.c}" 引用 → var(--a-b-c)；别名关系在数据里，不在代码里
 *   3) aliases.json 的 alias 组：key 本身就是完整 token 路径（用于 ThemeService 兼容名
 *      与"基名+子名冲突"的 token，如 color.accent 基名 vs color.accent.500 子名）
 *   4) styles/<id>/tokens.json 顶层只允许 base/light/dark 三段（分别落到
 *      html[data-style=id] / [data-style=id][data-theme-type=light] / ...dark）；
 *      覆盖路径必须已存在于基底 token（防拼写漂移）
 *
 * 用法：pnpm build（在 client/packages/design-system 下）
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
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

// TS 值：递归解析引用为最终字面值（srcMap 允许风格包在自己的覆盖集内解析引用）
function resolveLiteral(v, seen = new Set(), srcMap = map) {
  const p = refPath(v);
  if (!p) return String(v);
  if (seen.has(p)) throw new Error(`循环引用: ${p}`);
  if (!(p in srcMap)) throw new Error(`未知引用: {${p}}`);
  return resolveLiteral(srcMap[p], seen.union(new Set([p])), srcMap);
}

// 校验所有引用可解析
for (const [k, v] of Object.entries(map)) {
  try {
    resolveLiteral(v);
  } catch (e) {
    throw new Error(`${k}: ${e.message}`);
  }
}

// ---------- 风格包（styles/<id>/，规范第九节） ----------
const MODE_KEYS = ['base', 'light', 'dark'];

/**
 * 展开一个风格包分段（base/light/dark）。除常规嵌套树外，额外支持 `alias` 子段：
 * 其 key 即完整 token 路径（扁平语义，同 tokens/aliases.json）——用于表达"基名与子名冲突"
 * 的 token（如 name 既是 --color-success 又是 --color-success-solid 的基名，嵌套树无法同时表达）。
 */
function flattenSegment(node) {
  const out = {};
  if (!node || typeof node !== 'object') return out;
  const rest = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'alias' || k.startsWith('$')) continue;
    rest[k] = v;
  }
  Object.assign(out, flatten(rest, '', {}));
  if (node.alias) {
    for (const [k, v] of Object.entries(node.alias)) {
      if (k.startsWith('$')) continue;
      // alias 段沿用 tokens/aliases.json 的写法：{ "$value": …, "$type": … }，取其 $value
      out[k] = v && typeof v === 'object' && Object.hasOwn(v, '$value') ? v.$value : v;
    }
  }
  return out;
}

/**
 * 读 styles/<id>/：manifest.json（元信息）+ tokens.json（base/light/dark 三段覆盖 + alias 段）+ components.css
 * 校验：manifest.id 与目录名一致；tokens.json 顶层只允许 base/light/dark/alias；覆盖路径必须已存在于基底 token。
 */
function readStylePacks() {
  const stylesDir = join(pkgRoot, 'styles');
  if (!existsSync(stylesDir)) return [];
  const packs = readdirSync(stylesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const id = d.name;
      const dir = join(stylesDir, id);
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) throw new Error(`风格包 ${id} 缺少 manifest.json`);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.id !== id) throw new Error(`风格包 ${id}: manifest.id (${manifest.id}) 与目录名不一致`);

      const tokensPath = join(dir, 'tokens.json');
      const raw = existsSync(tokensPath) ? JSON.parse(readFileSync(tokensPath, 'utf8')) : {};
      const stray = Object.keys(raw).filter(
        (k) => !k.startsWith('$') && !MODE_KEYS.includes(k) && k !== 'alias',
      );
      if (stray.length)
        throw new Error(`风格包 ${id}: tokens.json 顶层只允许 base/light/dark/alias（发现 ${stray.join(', ')}）`);

      const groups = { base: {}, light: {}, dark: {} };
      for (const key of MODE_KEYS) if (raw[key]) groups[key] = flattenSegment(raw[key]);
      // 顶层 alias：与模式无关的别名，并入 base 段
      if (raw.alias) {
        for (const [k, v] of Object.entries(raw.alias)) {
          if (k.startsWith('$')) continue;
          groups.base[k] = v && typeof v === 'object' && Object.hasOwn(v, '$value') ? v.$value : v;
        }
      }

      const covered = { ...groups.base, ...groups.light, ...groups.dark };
      const unknown = Object.keys(covered).filter((p) => !(p in map));
      if (unknown.length) throw new Error(`风格包 ${id}: 覆盖了不存在的 token 路径 — ${unknown.join(', ')}`);

      const componentsPath = join(dir, 'components.css');
      const components = existsSync(componentsPath) ? readFileSync(componentsPath, 'utf8') : '';
      return { id, manifest, groups, components };
    });

  packs.sort((a, b) => (a.manifest.order ?? 999) - (b.manifest.order ?? 999) || a.id.localeCompare(b.id));
  const defaults = packs.filter((p) => p.manifest.default === true);
  if (packs.length && defaults.length !== 1)
    throw new Error(`风格包必须恰有一个 default:true（styles/*/manifest.json，当前 ${defaults.length} 个）`);
  return packs;
}

const stylePacks = readStylePacks();
const defaultPack = stylePacks.find((p) => p.manifest.default === true);

// 防坑警告：{ref} 直出只处理「整值就是一个引用」的情形（REF 全串匹配），
// 复合值里的 {…} 不会被转成 var() —— 会静默产出非法 CSS（曾于硬投影值上踩过）。
for (const pack of stylePacks) {
  for (const [mode, vars] of Object.entries(pack.groups)) {
    for (const [p, v] of Object.entries(vars)) {
      if (typeof v === 'string' && v.includes('{') && !refPath(v)) {
        console.warn(
          `[design-system] ⚠️ 风格包 ${pack.id}/${mode} 的 ${p} 值含 {…} 但不是整值引用：${v}\n` +
            `           复合值中的引用不会自动转成 var()，请改写为显式 var(--token-name)。`,
        );
      }
    }
  }
}

// ---------- 产物 1：css/tokens.css ----------
const section = (title, vars) =>
  `  /* ==== ${title} ==== */\n` +
  Object.entries(vars)
    .map(([p, v]) => `  ${cssName(p)}: ${cssValue(v)};`)
    .join('\n');

const lightBlock = semanticLight
  ? `\n/* ---------- 亮色主题「宣纸」：[data-theme-type="light"] 覆盖（变量名与暗色一一对应；ThemeService 挂 data-theme-type 于 html） ---------- */\nhtml[data-theme-type='light'] {\n  color-scheme: light;\n\n${section('semantic · 亮色·宣纸（规范 4.1/4.5）', lightVars)}\n}\n`
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

// ---------- 产物 4：css/style-packs/<id>.css + css/style-packs.css + src/stylePacks.ts ----------
const declBlock = (vars) =>
  Object.entries(vars)
    .map(([p, v]) => `  ${cssName(p)}: ${cssValue(v)};`)
    .join('\n');

/** 风格包 token → 已解析字面值（包内引用优先于基底，与 CSS 侧层叠语义一致） */
const packTokenLiteral = (pack, vars) => {
  const srcMap = { ...map, ...pack.groups.base, ...pack.groups.light, ...pack.groups.dark };
  return Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [cssName(k), resolveLiteral(v, new Set(), srcMap)]),
  );
};

const packCssById = new Map();
const stylePackTokenEntries = [];

for (const pack of stylePacks) {
  const { id, groups, components, manifest } = pack;
  const parts = [
    `/* ============================================================
 * @ai00-x/design-system style pack — ${manifest.name} (${id})
 * AUTO-GENERATED（pnpm build 产物，勿手改）｜ 源：styles/${id}/
 * 规范第九节：html[data-style='${id}'] 覆盖基底 token；文件末尾为该风格专属组件形态
 * ============================================================ */`,
    Object.keys(groups.base).length
      ? `/* 全模式覆盖（明暗通用；在 tokens.css 之后引入，故可压过 [data-theme-type='light'] 块） */\nhtml[data-style='${id}'] {\n${declBlock(groups.base)}\n}`
      : `/* 默认风格：零覆盖（基底 tokens 即本风格本身） */\nhtml[data-style='${id}'] {}`,
  ];
  if (Object.keys(groups.light).length)
    parts.push(`html[data-style='${id}'][data-theme-type='light'] {\n${declBlock(groups.light)}\n}`);
  if (Object.keys(groups.dark).length)
    parts.push(`html[data-style='${id}'][data-theme-type='dark'] {\n${declBlock(groups.dark)}\n}`);
  if (components.trim())
    parts.push(`/* ---- styles/${id}/components.css（风格专属组件形态） ---- */\n${components.trim()}`);
  packCssById.set(id, `${parts.join('\n\n')}\n`);

  const literal = JSON.stringify(
    {
      base: packTokenLiteral(pack, groups.base),
      light: packTokenLiteral(pack, groups.light),
      dark: packTokenLiteral(pack, groups.dark),
    },
    null,
    2,
  )
    .split('\n')
    .map((l, i) => (i === 0 ? l : `  ${l}`))
    .join('\n');
  stylePackTokenEntries.push(`  ${JSON.stringify(id)}: ${literal},`);
}

const stylePacksCss = `/* @ai00-x/design-system 风格包聚合 — AUTO-GENERATED（勿手改）
 * ⚠️ 必须在 tokens.css 与 components.css 之后引入：
 *   前者让包 token 压过基底 token，后者让包组件形态压过基座组件样式。 */
${stylePacks.map((p) => `@import './style-packs/${p.id}.css';`).join('\n')}
`;

const stylePackMetaEntries = stylePacks
  .map(
    (p) =>
      `  {\n    id: ${JSON.stringify(p.id)},\n    name: ${JSON.stringify(p.manifest.name)},\n    description: ${JSON.stringify(p.manifest.description ?? '')},\n    order: ${p.manifest.order ?? 999},\n    isDefault: ${p.manifest.default === true},\n  },`,
  )
  .join('\n');

const stylePacksTs = `// AUTO-GENERATED by scripts/build-tokens.mjs — 勿手改
// 风格包注册表（规范第九节）。供设置页枚举，以及 ThemeService 运行时 inline 注入包 token
// （必须由 ThemeService 注入：它会 inline 写 --radius-*/--shadow-*/--font-*/语义色，
//   inline 优先级高于任何样式块，故风格包值只能在主题变量之后再次 inline 注入才能生效）。
// 源：packages/design-system/styles/<id>/

export interface StylePackMeta {
  id: string;
  name: string;
  description: string;
  order: number;
  isDefault: boolean;
}

/** 各风格包 token 覆盖（CSS 变量名 → 已解析字面值） */
export interface StylePackTokenMap {
  /** 全模式覆盖 */
  base: Record<string, string>;
  /** 仅亮色档覆盖 */
  light: Record<string, string>;
  /** 仅暗色档覆盖 */
  dark: Record<string, string>;
}

export const stylePacks = [
${stylePackMetaEntries}
] as const;

export type StylePackId = (typeof stylePacks)[number]['id'];

export const DEFAULT_STYLE_PACK_ID: StylePackId = ${JSON.stringify(defaultPack?.id ?? '')};

export const stylePackTokens: Record<string, StylePackTokenMap> = {
${stylePackTokenEntries.join('\n')}
};

/** 取某风格包在当前明暗档下应注入的 CSS 变量表（base 打底 + 当前档覆盖） */
export function resolveStylePackTokens(
  id: string,
  mode: 'light' | 'dark',
): Record<string, string> {
  const pack = stylePackTokens[id];
  if (!pack) return {};
  return { ...pack.base, ...pack[mode] };
}
`;

// ---------- 写文件 ----------
mkdirSync(join(pkgRoot, 'css'), { recursive: true });
mkdirSync(join(pkgRoot, 'css', 'style-packs'), { recursive: true });
mkdirSync(join(pkgRoot, 'src'), { recursive: true });
writeFileSync(join(pkgRoot, 'css', 'tokens.css'), tokensCss, 'utf8');
writeFileSync(join(pkgRoot, 'css', 'tw-theme.css'), twTheme, 'utf8');
writeFileSync(join(pkgRoot, 'src', 'tokens.ts'), tokensTs, 'utf8');
for (const [id, css] of packCssById) writeFileSync(join(pkgRoot, 'css', 'style-packs', `${id}.css`), css, 'utf8');
writeFileSync(join(pkgRoot, 'css', 'style-packs.css'), stylePacksCss, 'utf8');
writeFileSync(join(pkgRoot, 'src', 'stylePacks.ts'), stylePacksTs, 'utf8');

// 聚合入口：消费方一次 @import "@ai00-x/design-system/styles" 即全量（变量+风格包+纸纹+动效+组件）
const indexCss = `/* @ai00-x/design-system 样式聚合入口 — AUTO-GENERATED（勿手改）
 * 消费方用法：@import "@ai00-x/design-system/styles";
 * Tailwind v4 消费方另加：@import "@ai00-x/design-system/tw"; */
@import './tokens.css';
@import './fonts.css';
@import './texture.css';
@import './motion.css';
@import './components.css';
@import './style-packs.css';
`;
writeFileSync(join(pkgRoot, 'css', 'index.css'), indexCss, 'utf8');

// 单文件全量（官网/Relay 等静态 HTML 内联用）：变量 + 纸纹 + 动效 + 组件 + 风格包
const readCss = (f) => readFileSync(join(pkgRoot, 'css', f), 'utf8');
const stripImport = (s) => s.replace(/^@import[^;]+;\s*$/gm, '');
const standalone = `/* @ai00-x/design-system standalone — AUTO-GENERATED（tokens + 纸纹 + 动效 + 组件 + 风格包，单文件内联用） */\n${[
  tokensCss,
  stripImport(readCss('texture.css')),
  readCss('motion.css'),
  readCss('components.css'),
  ...[...packCssById.values()],
].join('\n')}\n`;
writeFileSync(join(pkgRoot, 'css', 'tokens.standalone.css'), standalone, 'utf8');

const total = Object.keys(primVars).length + Object.keys(semVars).length + Object.keys(aliasVars).length;
console.log(
  `[design-system] 构建完成：primitives ${Object.keys(primVars).length} + semantic ${Object.keys(semVars).length} + alias ${Object.keys(aliasVars).length} = ${total} 个 token` +
    (semanticLight ? `（含亮色宣纸覆盖 ${Object.keys(lightVars).length}）` : '') +
    `\n  风格包 ${stylePacks.length} 个：${stylePacks.map((p) => `${p.id}${p.manifest.default ? '(默认)' : ''}`).join(', ') || '无'}` +
    `\n  → css/tokens.css / tw-theme.css / index.css / tokens.standalone.css / style-packs.css / style-packs/*.css` +
    `\n  → src/tokens.ts / src/stylePacks.ts`,
);
