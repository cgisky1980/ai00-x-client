/**
 * useIconThemeColors — extract dominant color from app icons.
 *
 * Simplified port of Patina's `shared/hooks/useIconThemeColors.ts`. Returns a
 * map of `exePath → color` for the icons passed in. Colors are cached per
 * icon data URL so the canvas work only happens once per icon.
 *
 * Algorithm:
 *  1. Decode the icon data URL into an Image, draw onto a 48x48 canvas.
 *  2. Read pixels, bucket colors into a 24-bucket histogram (by hue).
 *  3. Filter near-white / near-grey backgrounds.
 *  4. Weight pixels by distance to canvas center (favor center).
 *  5. Pick the bucket with the highest weighted count, return its average.
 *  6. Fall back to a deterministic palette.
 */

import { useEffect, useState } from 'react';

const ICON_THEME_CACHE = new Map<string, string>();
const FALLBACK_PALETTE = [
  '#5e81ac',
  '#bf616a',
  '#a3be8c',
  '#d08770',
  '#ebcb8b',
  '#b48ead',
  '#88c0d0',
  '#81a1c1',
];

interface Bucket {
  count: number;
  r: number;
  g: number;
  b: number;
  weight: number;
}

const NUM_BUCKETS = 24;
const BUCKET_SIZE = 360 / NUM_BUCKETS;

function rgbToHue(r: number, g: number, b: number): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function isNearWhiteOrGrey(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max > 240 && max - min < 12) return true; // near white
  if (max - min < 8 && max < 80) return false; // very dark — keep (text/icon)
  if (max - min < 8) return true; // grey
  return false;
}

function extractDominantColor(canvas: HTMLCanvasElement, image: HTMLImageElement): string | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const size = 48;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(image, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const buckets: Bucket[] = Array.from({ length: NUM_BUCKETS }, () => ({
    count: 0,
    r: 0,
    g: 0,
    b: 0,
    weight: 0,
  }));
  const center = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const a = data[idx + 3];
      if (a < 128) continue;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      if (isNearWhiteOrGrey(r, g, b)) continue;
      const hue = rgbToHue(r, g, b);
      const bi = Math.min(NUM_BUCKETS - 1, Math.floor(hue / BUCKET_SIZE));
      const dx = x - center;
      const dy = y - center;
      const weight = 1 / (1 + (dx * dx + dy * dy) / 200);
      const bk = buckets[bi];
      bk.count += 1;
      bk.r += r * weight;
      bk.g += g * weight;
      bk.b += b * weight;
      bk.weight += weight;
    }
  }
  let best: Bucket | null = null;
  for (const bk of buckets) {
    if (bk.weight <= 0) continue;
    if (!best || bk.weight > best.weight) best = bk;
  }
  if (!best || best.weight === 0) return null;
  const r = Math.round(best.r / best.weight);
  const g = Math.round(best.g / best.weight);
  const b = Math.round(best.b / best.weight);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function hashExe(exePath: string): number {
  let h = 0;
  for (let i = 0; i < exePath.length; i++) h = (h * 31 + exePath.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Returns a map of `exePath → color` for the given icons.
 * `icons` is a record of `exePath → data URL` (icon may be null/missing).
 */
export function useIconThemeColors(icons: Record<string, string | null | undefined>): Record<string, string> {
  const [colors, setColors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const entries = Object.entries(icons).filter(([, url]) => typeof url === 'string' && url!.length > 0);
    if (entries.length === 0) {
      setColors({});
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 48;
    const result: Record<string, string> = {};
    let pending = entries.length;

    const finalize = () => {
      pending -= 1;
      if (pending === 0 && !cancelled) setColors({ ...result });
    };

    for (const [exePath, url] of entries) {
      const cached = ICON_THEME_CACHE.get(url!);
      if (cached) {
        result[exePath] = cached;
        finalize();
        continue;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const color = extractDominantColor(canvas, img);
        const finalColor = color ?? FALLBACK_PALETTE[hashExe(exePath) % FALLBACK_PALETTE.length];
        ICON_THEME_CACHE.set(url!, finalColor);
        result[exePath] = finalColor;
        finalize();
      };
      img.onerror = () => {
        result[exePath] = FALLBACK_PALETTE[hashExe(exePath) % FALLBACK_PALETTE.length];
        finalize();
      };
      img.src = url!;
    }

    return () => {
      cancelled = true;
    };
  }, [icons]);

  return colors;
}

export default useIconThemeColors;
