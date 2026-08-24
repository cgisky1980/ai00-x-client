/**
 * 灵印 BrandMark —— Ai00-X 官方品牌符号（规范 2.5 · v0.9 字形）
 *
 * 字形：古文「靈」直构「镂空圆脸擦 X，四角冒头」（与 CubeLoading 圆脸动画同源）：
 *   巫 → 几何粗笔 X（圆头等宽），后层底座；中段被圆脸挖空擦除，四角自环后冒出 = ai00-x 之「X」
 *   口 → 镂空圆脸（环形描边，印心透底）= 「靈」之「口」，呼吸之枢
 *   雨 → 两枚实心圆眼，与环同色，居于环内水平线两侧 = ai00 之「00」，有灵之眼
 * 一字三读：靈 / 0·0·X / 有灵之脸（环为面、眼为目、X 为骨）。
 *
 * 变体（单色印，无框无底）：
 *   ink（默认） currentColor——主题自适应，日常场景
 *   seal        朱砂色字形（--color-brand-seal）——门面仪式，一屏一处朱
 *   inverse     宣纸白字形（#f6f2e8 固定资产色）——暗色门面
 *   line        同 ink 字形，muted 色——装饰水印
 *   lockup      seal 缩小 + Ai00-X wordmark 横排
 *
 * 灵韵态（animated）：圆环呼吸 + 双眼眨眼（复用 CubeLoading 动画语言），
 *   仅用于 loading / 启动等「AI 运行」场景；X 静止为骨。
 *
 * 纪律：一屏一印；不拉伸不加特效（灵韵态除外）；seal 的朱砂不随 hue 换肤联动。
 */
import { useId } from 'react';
import { cn } from '../lib/cn';

/** inverse 版字形用品牌资产宣纸白（不随主题） */
const INVERSE_PAPER = '#f6f2e8';

export type BrandMarkVariant = 'ink' | 'seal' | 'inverse' | 'line' | 'lockup';

export interface BrandMarkProps {
  variant?: BrandMarkVariant;
  /** 印面边长 px（lockup 为印部分尺寸）。最小 16 */
  size?: number;
  className?: string;
  /** lockup 副标题（如 "Agentic OS"），可选 */
  subtitle?: string;
  /** 灵韵态：圆脸呼吸 + 眨眼。仅 loading/启动场景使用 */
  animated?: boolean;
}

/**
 * 灵印字形（viewBox 24×24）：镂空圆脸擦 X，X 四角冒头。
 *   X   两对角粗笔 (3,3)↔(21,21)，笔宽 4（≈印宽 17%），圆头——后层底座
 *   擦除 mask 内圆 r=8.5 c(12,12)——X 中段被挖空，接缝正好落在环描边下
 *   环  正圆 c(12,12) r=8.5，环宽 1.6（≈印宽 7%，同 panda-face 比例）——镂空圆脸
 *   眼  实心圆 r=1.5，c(8.5,12)/(15.5,12)——与环同色，环内水平线两侧
 */
function LingGlyph({ color, className }: { color: string; className?: string }) {
  const maskId = useId();
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <defs>
        <mask id={maskId}>
          <rect width="24" height="24" fill="white" />
          {/* 印心挖空：擦除 X 中段 */}
          <circle cx={12} cy={12} r={8.5} fill="black" />
        </mask>
      </defs>
      {/* 巫 · X 四角冒头（中段被圆脸擦除） */}
      <g
        className="ds-brand-mark__x"
        stroke={color}
        strokeWidth={4}
        strokeLinecap="round"
        mask={`url(#${maskId})`}
      >
        <line x1={3} y1={3} x2={21} y2={21} />
        <line x1={21} y1={3} x2={3} y2={21} />
      </g>
      {/* 口 · 镂空圆脸（环形描边，印心透底） */}
      <circle className="ds-brand-mark__face" cx={12} cy={12} r={8.5} stroke={color} strokeWidth={1.6} />
      {/* 雨 · 双眼（与环同色） */}
      <circle className="ds-brand-mark__eye" cx={8.5} cy={12} r={1.5} fill={color} />
      <circle className="ds-brand-mark__eye ds-brand-mark__eye--right" cx={15.5} cy={12} r={1.5} fill={color} />
    </svg>
  );
}

export function BrandMark({
  variant = 'ink',
  size = 24,
  className,
  subtitle,
  animated = false,
}: BrandMarkProps) {
  if (variant === 'lockup') {
    return (
      <span className={cn('ds-brand-mark ds-brand-mark--lockup', className)}>
        <BrandMark variant="seal" size={size} animated={animated} />
        <span className="ds-brand-mark__word">
          <span className="ds-brand-mark__name">Ai00-X</span>
          {subtitle ? <span className="ds-brand-mark__sub">{subtitle}</span> : null}
        </span>
      </span>
    );
  }

  const color =
    variant === 'seal'
      ? 'var(--color-brand-seal)'
      : variant === 'inverse'
        ? INVERSE_PAPER
        : 'currentColor';

  return (
    <span
      className={cn(
        'ds-brand-mark',
        variant !== 'ink' && `ds-brand-mark--${variant}`,
        animated && 'ds-brand-mark--animated',
        className,
      )}
      style={{ width: size, height: size }}
      role="img"
      aria-label="Ai00-X"
    >
      <LingGlyph color={color} className="ds-brand-mark__glyph" />
    </span>
  );
}
