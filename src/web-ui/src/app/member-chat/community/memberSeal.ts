/**
 * memberSeal — 成员纹章（E 阶段）
 *
 * GitHub identicon / 老 Reddit 的确定性图案：同一个 (username, member_id)
 * 永远得到同一枚纹章，不同人必然不同。零素材、零请求、零存储。
 *
 * 与品牌 LOGO 的边界（必须守住，否则稀释品牌）：
 * - `<BrandMark>` 是「灵」字印形，**产品**标识，只在应用门面出现
 * - 本模块是几何纹章，**成员**标识，只在个人主页容器内出现
 * - 形状语言刻意不共用（无字、无印形边框），配色刻意脱离主题 accent
 *
 * 配色：固定墨阶 + 一点朱砂（默认决策）。
 * 不跟主题走 —— 印章不该随心情变色；而且若纹章随 accent 变，
 * 「每人不同」会被「每主题不同」混淆掉。
 */
import type { CSSProperties } from 'react';

/** FNV-1a 32 位：短、快、分布够好，且跨端可复现（H5 镜像同算法） */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619，用移位避免 32 位溢出丢精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** 5×5 对称格：把 32 位哈希摊成 15 个有效格（左右镜像） */
export const SEAL_GRID = 5;

export interface SealCell {
  x: number;
  y: number;
  on: boolean;
}

/**
 * 生成 5×5 镜像纹章的填充格（中间列为轴）。
 *
 * 每格取 **1 位**（15 格用掉 15 位，32 位哈希够）：
 * - 1 位 → 每格填充概率 50%，全图期望 ~12/25，分布集中在 8~17，读作纹章
 * - 2 位 + `!== 0` → 每格 75%，期望 ~19/25，实测出现过 23/25 的实心块
 *   （单测 member_12 抓到），读作二维码不像印章
 * 所以这里必须是 1 位，不是"更保险的 2 位"。
 */
export function sealCells(seed: string): SealCell[] {
  const h = hash32(seed);
  const cells: SealCell[] = [];
  const mid = (SEAL_GRID - 1) / 2; // 2
  for (let y = 0; y < SEAL_GRID; y++) {
    for (let x = 0; x <= mid; x++) {
      const bit = y * (mid + 1) + x;
      const on = ((h >> bit) & 0b1) === 1;
      cells.push({ x, y, on });
      if (x < mid) {
        // 镜像格：同一行右侧对称位
        cells.push({ x: SEAL_GRID - 1 - x, y, on });
      }
    }
  }
  return cells;
}

export interface SealStyle {
  /** 纹章前景色（墨阶，随页面明暗档取） */
  ink: string;
  /** 一点朱砂：给其中一格上色，避免纯单色过于机械 */
  seal: string;
}

/**
 * 纹章作为 CSS background（内联），零 DOM 节点、零 SVG 解析。
 * 圆角 + 边框让它读起来像一枚印章而不是二维码。
 */
export function sealStyle(seed: string, ink: string, seal: string, size = 28): CSSProperties {
  const cells = sealCells(seed);
  // 朱砂落在中轴偏上那一格：对称轴上的唯一暖点，视觉重心稳
  const accentY = 1;
  const parts: string[] = [];
  for (const c of cells) {
    if (!c.on) continue;
    const isSeal = c.y === accentY && c.x === 2;
    parts.push(
      `${isSeal ? seal : ink} ${c.x * 100}% ${c.y * 100}% ${(c.x + 1) * 100}% ${(c.y + 1) * 100}%`,
    );
  }
  return {
    width: size,
    height: size,
    backgroundImage: parts.length > 0 ? `linear-gradient(${parts.join(', ')})` : 'none',
    border: '1px solid currentColor',
    borderRadius: '18%',
    opacity: 0.5,
    flex: 'none',
    pointerEvents: 'none',
    userSelect: 'none',
  } as CSSProperties;
}

/** 生成确定性 SVG（供 H5 / 需要 <img> 的场合；与 CSS 版同算法同结果） */
export function sealSvg(seed: string, ink: string, seal: string, size = 28): string {
  const cells = sealCells(seed);
  const rects = cells
    .filter((c) => c.on)
    .map((c) => {
      const fill = c.y === 1 && c.x === 2 ? seal : ink;
      return `<rect x="${c.x}" y="${c.y}" width="1" height="1" fill="${fill}"/>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SEAL_GRID} ${SEAL_GRID}" ` +
    `width="${size}" height="${size}" shape-rendering="crispEdges" role="presentation">` +
    `<g opacity="0.5">${rects}</g></svg>`
  );
}