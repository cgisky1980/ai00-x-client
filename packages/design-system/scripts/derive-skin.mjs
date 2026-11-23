/**
 * 单源皮肤派生：从 palette（品牌色 + 基底色）展开明暗两档种子。
 *
 * 设计原则（2026-11-23）：
 * - 单源：一份 palette 决定皮肤的身份（色相家族），明暗不再各写一份完整种子。
 * - 运算派生：用 OKLCH 保留色相/彩度，翻转明度生成两档（同色家族，防退化）。
 * - 可选 override：手调审美细节（如 teal-paper 的 muted）覆盖派生值，不影响单源身份。
 * - 门禁：派生后由 core.js checkSkin 校验对比度；本模块只负责生成种子。
 *
 * 输出格式与 .ai00skin.json 的 modes 完全一致，下游 parseSkin/skinCss 零改动。
 */
import { hexToOklch, oklchToHex, shiftLightness, nudgeToContrast, contrast } from '../src/skin/core.js';

/** 单源调色板 → 明暗两档种子 */
export function deriveModes(palette) {
  const brand = String(palette.brand ?? '').toLowerCase();
  const base = String(palette.base ?? '').toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(brand) || !/^#[0-9a-f]{6}$/.test(base))
    throw new Error(`palette.brand/base 必须是 #rrggbb（得到 brand=${brand} base=${base}）`);

  const [bL, bC, bH] = hexToOklch(base);
  const [, aC, aH] = hexToOklch(brand);
  const isNeutralBase = bC < 0.01; // 中性底（煤黑/石墨）vs 彩色底（纸上青）
  const neutralC = isNeutralBase ? 0 : Math.min(bC, 0.01);

  // 亮档底/字：中性底皮肤用 base 色相的中性白；彩色底皮肤保留一点点底色相
  const lightBg = oklchToHex([0.98, neutralC, bH]);
  const lightSurface = oklchToHex([0.92, neutralC, bH]);
  const darkInk = oklchToHex([0.98, neutralC, bH]);

  // muted（次要文字）按底色自适应：从中间明度出发，推到对底 ≥4.5。
  // 固定 L 会在彩色深底（如 teal-paper #06525c）上不达标。
  const darkMutedSeed = oklchToHex([bL >= 0.5 ? 0.45 : 0.68, neutralC, bH]);
  const lightMutedSeed = oklchToHex([0.5, neutralC, bH]);
  const darkMuted = nudgeToContrast(darkMutedSeed, base, 4.5) ?? darkMutedSeed;
  const lightMuted = nudgeToContrast(lightMutedSeed, lightBg, 4.5) ?? lightMutedSeed;

  const dark = {
    bg: base,
    surface: shiftLightness(base, 0.05),
    ink: darkInk,
    muted: darkMuted,
    accent: brand,
    accentInk: base,
    mark: brand,
  };

  // 反档 accent：保品牌色相/彩度，压到亮档可读明度，再推到 4.5:1
  const lightAccent = nudgeToContrast(oklchToHex([0.54, aC, aH]), lightBg, 4.5);

  const light = {
    bg: lightBg,
    surface: lightSurface,
    ink: base,
    muted: lightMuted,
    accent: lightAccent,
    accentInk: lightBg,
    mark: brand,
  };

  return { dark, light };
}

/** 把单源皮肤（含 palette/overrides）展开成标准 skin JSON（modes 双份） */
export function expandSingleSource(raw) {
  const palette = raw.palette;
  if (!palette) return raw; // 旧格式（用户皮肤、未迁移的内置皮肤）原样返回

  const derived = deriveModes(palette);
  const overrideMode = raw.overridesMode ?? 'merge';
  const modes = {};
  for (const mode of ['dark', 'light']) {
    const base = derived[mode];
    const ov = raw.overrides?.[mode] ?? {};
    modes[mode] = overrideMode === 'replace' ? { ...ov } : { ...base, ...ov };
  }

  const { palette: _p, overrides: _o, overridesMode: _m, ...rest } = raw;
  return { ...rest, format: 1, modes };
}
