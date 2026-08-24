import { AccentColors } from '../types';

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, color)))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function generateAccentFromHue(hue: number, isDark: boolean): AccentColors {
  const saturation = isDark ? 72 : 65;
  const lightness500 = isDark ? 65 : 45;

  const base500 = hslToHex(hue, saturation, lightness500);
  const rgb500 = hexToRgb(base500)!;

  if (isDark) {
    return {
      50: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.04)`,
      100: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.08)`,
      200: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.15)`,
      300: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.25)`,
      400: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.4)`,
      500: base500,
      600: hslToHex(hue, saturation + 5, lightness500 - 8),
      700: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.8)`,
      800: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.9)`,
    };
  }

  return {
    50: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.03)`,
    100: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.07)`,
    200: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.12)`,
    300: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.2)`,
    400: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.35)`,
    500: base500,
    600: hslToHex(hue, saturation + 5, lightness500 - 6),
    700: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.75)`,
    800: `rgba(${rgb500.r}, ${rgb500.g}, ${rgb500.b}, 0.88)`,
  };
}

/**
 * 从 accent.500 反推色相。注意：返回 OKLCH 色相（与 tokens.css 的
 * oklch(L var(--chroma) var(--hue)) 公式同一色彩空间）——此前误用 HSL 色相，
 * 两个空间的 hue 数值不可互换（如 #177ba8：OKLCH hue≈235，HSL hue≈199），
 * 导致注入 --hue 后整体色相偏移。
 */
export function hueFromAccentColor(accent500: string): number {
  const rgb = hexToRgb(accent500);
  if (!rgb) return DEFAULT_ACCENT_HUE;

  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(rgb.r);
  const g = lin(rgb.g);
  const b = lin(rgb.b);

  // linear sRGB → OKLab
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;

  if (a === 0 && b2 === 0) return DEFAULT_ACCENT_HUE;
  let h = (Math.atan2(b2, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return Math.round(h);
}

/** 黛青（规范：oklch hue 235） */
export const DEFAULT_ACCENT_HUE = 235;
