// ========================================================================
// 工灵形象组件（§3.4）：SVG 模板底座 + 随机件（CSS 类切换）
// ========================================================================

import React from 'react';
import type { AgentCategory } from './theaterTypes';
import { generateImpAppearance, type ImpAppearance } from './impVisualCore';
import './AgentTheater.scss';

interface ImpVisualProps {
  sessionId: string;
  category: AgentCategory;
  toolNames?: string[];
  size?: number;
  className?: string;
}

/** 模板专属装饰（帽子/外壳轮廓） */
const TEMPLATE_CLASS: Record<string, string> = {
  bee: 'ai00-imp--tpl-bee',
  woodpecker: 'ai00-imp--tpl-woodpecker',
  owl: 'ai00-imp--tpl-owl',
  snail: 'ai00-imp--tpl-snail',
  worker: 'ai00-imp--tpl-worker',
};

export const ImpVisual: React.FC<ImpVisualProps> = ({
  sessionId,
  category,
  toolNames = [],
  size = 28,
  className,
}) => {
  const appearance: ImpAppearance = generateImpAppearance(sessionId, category, toolNames);
  const tpl = TEMPLATE_CLASS[appearance.template] ?? TEMPLATE_CLASS.worker;
  return (
    <span
      className={`ai00-imp-visual ${tpl} ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        ['--imp-accent' as string]: appearance.accent,
        ['--imp-eye' as string]: appearance.eyeStyle,
        ['--imp-antenna' as string]: appearance.antennaStyle,
        ['--imp-pattern' as string]: appearance.patternStyle,
        ['--imp-gadget' as string]: appearance.gadget,
      }}
      aria-hidden
    >
      {/* 身体 */}
      <span className="ai00-imp-visual__body" />
      {/* 天线（随机样式） */}
      <span className="ai00-imp-visual__antenna" />
      {/* 眼睛（随机样式） */}
      <span className="ai00-imp-visual__eyes" />
      {/* 花纹（随机样式） */}
      <span className="ai00-imp-visual__pattern" />
      {/* 随身小工具（随机有无与种类） */}
      <span className="ai00-imp-visual__gadget" />
    </span>
  );
};
