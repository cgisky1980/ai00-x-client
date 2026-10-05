/**
 * coverArt — 无图作品的排版封面（C 阶段）
 *
 * 为什么不再用程序化渐变：
 * 8 条手挑渐变（旧的 CARD_ART）是最强的"AI 生成感"来源——它们与主题无关、
 * 与作品无关，随 post.id 取模，同一个人的主页上会出现 8 种互相不搭的颜色。
 * 排版封面（typographic cover）则读起来像设计：
 *   - 底色取**主题 accent 叠 bg 的淡色**（--pt-accent-soft 的实色版本）
 *   - 前景是大号衬线/等宽首字（尊重 data-type 轴）
 *   - 叠一层与主题同源的纹理
 * 于是无图作品也落在页面的色彩世界里，且零素材、零随机。
 */
import type { CSSProperties } from 'react';

/** 首字取样：跳过 markdown 修饰符与空白，取视觉上第一个字符 */
export function coverLetter(seed: string): string {
  const cleaned = seed.replace(/[#>*_`~[\]()-]/g, '').trim();
  const ch = cleaned.charAt(0);
  // 纯符号/数字无衬线感，留 2 字（如 "24"）比单符号好看
  if (!ch) return '文';
  return /[\p{L}]/u.test(ch) ? ch.toUpperCase() : cleaned.slice(0, 2);
}

/**
 * 排版封面样式（内联，因为要吃主题推导出的色板）。
 * 首字本身由调用方作为子节点渲染，这里只出样式与底纹。
 *
 * @param typeAxis data-type 轴：serif 衬线 / mono 等宽 / sans 无衬线
 */
export function coverArtStyle(
  typeAxis: string,
  palette: { accentSoft: string; accent: string; border: string; text: string },
): CSSProperties {
  const font =
    typeAxis === 'mono'
      ? 'var(--pt-mono, var(--font-family-mono))'
      : typeAxis === 'sans'
        ? 'var(--font-family-sans)'
        : 'var(--pt-font-display)';
  return {
    backgroundColor: palette.accentSoft,
    backgroundImage: `radial-gradient(circle at 32% 28%, color-mix(in srgb, ${palette.accent} 22%, transparent) 0%, transparent 58%),
      linear-gradient(155deg, ${palette.accentSoft} 0%, color-mix(in srgb, ${palette.border} 55%, transparent) 100%)`,
    borderColor: palette.border,
    // 大字压在左下角，右侧留白给纹理——杂志封面的常规取位
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
    padding: '8% 10%',
    fontFamily: font,
    fontSize: 'clamp(1.75rem, 1rem + 3.2vw, 3rem)',
    fontWeight: '600',
    lineHeight: '0.9',
    letterSpacing: typeAxis === 'mono' ? '0.08em' : '0.02em',
    color: palette.accent,
    userSelect: 'none',
  } as CSSProperties;
}