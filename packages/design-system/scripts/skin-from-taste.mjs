#!/usr/bin/env node
/**
 * 从 taste-skill 调色库生成内置皮肤（规范 v1.0 第三节：内置皮肤一律发牌生成，不凭个人审美挑）。
 *
 * 流程：
 *   1) 读 taste-skill library/palettes.json 里的调色板（或先用 `start.mjs deal --page software` 发牌拿 id）
 *   2) 调 taste-skill `start.mjs brand` 得到本档 --p-* 与反档 --p-inv-*（taste 自带的对比度修正与 action 回落）
 *   3) 反档里 accent 若回落为墨色（浅强调色在浅底上不可读），原强调色降级为「高亮笔」mark 保留辨识度
 *   4) 经 core.js parseSkin + checkSkin 体检，写 skins/<id>.ai00skin.json
 *
 * 用法：
 *   node scripts/skin-from-taste.mjs <palette-id> --name "显示名" [--id <skin-id>] [--type geist] [--radius sharp|soft|round]
 *                                    [--buttons solid|pill|tonal] [--description "…"] [--taste <taste-skill 目录>]
 *   taste-skill 目录默认 $TASTE_SKILL_DIR 或 ~/.claude-xxx/skills/design-taste-frontend（自动搜 ~ 下 .claude 开头的目录）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSkin, contrast, FONT_CATALOG, parseSkin } from '../src/skin/core.js';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const paletteId = args[0];
if (!paletteId || paletteId.startsWith('--')) {
  console.error('用法：node scripts/skin-from-taste.mjs <palette-id> --name "显示名" [--id …] [--type geist] [--radius sharp]');
  process.exit(1);
}

function findTasteDir() {
  const env = opt('taste') ?? process.env.TASTE_SKILL_DIR;
  if (env) return env;
  const home = homedir();
  for (const d of readdirSync(home).filter((n) => n.startsWith('.claude'))) {
    const p = join(home, d, 'skills', 'design-taste-frontend');
    if (existsSync(join(p, 'scripts', 'start.mjs'))) return p;
  }
  throw new Error('找不到 taste-skill：用 --taste <目录> 或 TASTE_SKILL_DIR 指定');
}

const tasteDir = findTasteDir();
const palettes = JSON.parse(readFileSync(join(tasteDir, 'library', 'palettes.json'), 'utf8'));
const pal = (Array.isArray(palettes) ? palettes : palettes.palettes).find((p) => p.id === paletteId);
if (!pal) throw new Error(`taste-skill 调色库里没有 ${paletteId}`);

const typeId = opt('type', 'geist');
const out = execFileSync(
  process.execPath,
  [
    join(tasteDir, 'scripts', 'start.mjs'),
    'brand',
    '--page',
    'software',
    '--bg',
    pal.bg,
    '--surface',
    pal.surface,
    '--ink',
    pal.ink,
    '--muted',
    pal.muted,
    '--accent',
    pal.accent,
    '--type',
    typeId,
  ],
  { encoding: 'utf8', cwd: tasteDir },
);
const p = Object.fromEntries([...out.matchAll(/--p-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));

const own = {
  bg: p.bg,
  surface: p.surface,
  ink: p.ink,
  muted: p.muted,
  accent: p.action,
  accentInk: p['action-ink'],
  mark: p.accent,
  markInk: p['accent-ink'],
};
const inv = {
  bg: p['inv-bg'],
  surface: p['inv-surface'],
  ink: p['inv-ink'],
  muted: p['inv-muted'],
  accent: p['inv-action'],
  accentInk: p['inv-action-ink'],
};
// 反档：原强调色若在反档底上仍可作填充（配墨色字达标），保留为高亮笔——辨识度不随明暗丢失
const markInk = contrast(pal.accent, inv.ink) >= contrast(pal.accent, inv.bg) ? inv.ink : inv.bg;
if (contrast(markInk, pal.accent) >= 4.5 && contrast(pal.accent, inv.bg) >= 1.5) Object.assign(inv, { mark: pal.accent, markInk });

const ownIsDark = contrast(own.bg, '#000000') < contrast(own.bg, '#ffffff');
const tasteType = JSON.parse(readFileSync(join(tasteDir, 'library', 'type.json'), 'utf8'));
const t = (Array.isArray(tasteType) ? tasteType : tasteType.pairings).find((x) => x.id === typeId);
const fontOf = (family, fallback) => {
  const hit = Object.entries(FONT_CATALOG).find(([, f]) => f.name === family);
  return hit ? hit[0] : fallback;
};
const serif = t && (t.class === 'serif' || t.class === 'slab');

const raw = {
  format: 1,
  id: opt('id', paletteId),
  name: opt('name', pal.name),
  description: opt('description', pal.note?.split('.')[0] ?? ''),
  source: `taste-skill palette ${paletteId} + type ${typeId}（scripts/skin-from-taste.mjs 生成，勿手改；改动请重新发牌）`,
  modes: ownIsDark ? { dark: own, light: inv } : { dark: inv, light: own },
  type: {
    display: t ? fontOf(t.display.family, serif ? 'system-serif' : 'system-sans') : 'geist',
    text: t ? fontOf(t.text.family, 'system-sans') : 'geist',
    mono: t?.mono ? fontOf(t.mono.family, 'system-mono') : 'geist-mono',
  },
  shape: { radius: opt('radius', 'soft'), buttons: opt('buttons', 'solid') },
  motion: 'full',
};

const { skin, errors } = parseSkin(raw);
if (!skin) throw new Error(`生成的皮肤不合法：\n  ${errors.join('\n  ')}`);
const issues = checkSkin(skin);
for (const i of issues) console.warn(`[${i.level}] ${i.mode} ${i.label} ${i.ratio.toFixed(2)} < ${i.min}`);
if (issues.some((i) => i.level === 'error')) process.exit(2);

const file = join(pkgRoot, 'skins', `${skin.id}.ai00skin.json`);
writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
console.log(`[skin-from-taste] ${paletteId} → ${file}`);
