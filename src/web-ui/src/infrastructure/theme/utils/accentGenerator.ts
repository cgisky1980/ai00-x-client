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

export function hueFromAccentColor(accent500: string): number {
  const rgb = hexToRgb(accent500);
  if (!rgb) return 220;

  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  if (d === 0) return 0;

  let h: number;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  } else if (max === g) {
    h = ((b - r) / d + 2) / 6;
  } else {
    h = ((r - g) / d + 4) / 6;
  }

  return Math.round(h * 360);
}

export const DEFAULT_ACCENT_HUE = 220;
