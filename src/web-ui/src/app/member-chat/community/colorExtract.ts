/**
 * colorExtract — 封面主色提取（造物集沉浸 header 用）
 *
 * fetch → blob → createImageBitmap → 32×32 canvas 降采样 → 饱和度加权主色。
 * 跨域受限（API 未带 CORS 头）或加载失败时返回 null，调用方回退主题 accent——
 * 取色是增强层不是依赖层，任何失败路径都必须兜底。
 */

const CACHE = new Map<string, string | null>();
const CACHE_MAX = 60;

/** 像素饱和度加权：跳过近黑/近白/低饱和，权重 = saturation × (1 - |luminance-0.5|×2) */
function dominantFromPixels(data: Uint8ClampedArray): string | null {
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let wSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = data[i + 3]!;
    if (a < 128) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lum = (max + min) / 510; // 0..1
    const sat = max === min ? 0 : (max - min) / 255; // 0..1
    if (lum < 0.08 || lum > 0.92 || sat < 0.15) continue; // 跳过近黑近白灰
    const weight = sat * (1 - Math.abs(lum - 0.5) * 2);
    rSum += r * weight;
    gSum += g * weight;
    bSum += b * weight;
    wSum += weight;
  }
  if (wSum <= 0) return null;
  const toHex = (v: number) => Math.round(v / wSum).toString(16).padStart(2, '0');
  return `#${toHex(rSum)}${toHex(gSum)}${toHex(bSum)}`;
}

function setCache(key: string, value: string | null): void {
  if (CACHE.has(key)) CACHE.delete(key);
  else if (CACHE.size >= CACHE_MAX) {
    const first = CACHE.keys().next().value;
    if (first !== undefined) CACHE.delete(first);
  }
  CACHE.set(key, value);
}

/** 提取图片主色（带缓存；失败返回 null） */
export async function extractDominantColor(url: string): Promise<string | null> {
  if (!url) return null;
  if (CACHE.has(url)) return CACHE.get(url) ?? null;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close?.();
    const color = dominantFromPixels(ctx.getImageData(0, 0, size, size).data);
    setCache(url, color);
    return color;
  } catch {
    setCache(url, null);
    return null;
  }
}
