/**
 * TitleMeta — 「策」窗口自绘标题栏左侧元信息（标题后跟随）。
 *
 * 原 PanelHeader（旧原生标题栏时代的内部头部）的存活内容：Lv 等级 + XP
 * 经验条 + 积分徽标。窗口改自绘标题栏后内部头部整体移除，此组由
 * tasks-main 以 `titleBar.leading` 注入 WindowTitleBar（「策」字之后）。
 *
 * 样式复用 TodoPanel.scss 的 `todo-panel__lv/__xpbar/__xpfill`（BEM 平铺
 * 类名，不依赖 .todo-panel 祖先）。
 */
import React from 'react';
import { useGrowthStore } from '../store/growthStore';
import { CreditsBadge } from './CreditsBadge';

export const TitleMeta: React.FC = () => {
  const profile = useGrowthStore((s) => s.profile);

  return (
    <div className="todo-title-meta">
      <span className="todo-panel__lv">Lv.{profile.level}</span>
      <span className="todo-panel__xpbar">
        <span
          className="todo-panel__xpfill"
          style={{ width: `${Math.min(100, Math.round((profile.into / Math.max(1, profile.need)) * 100))}%` }}
        />
      </span>
      <CreditsBadge />
    </div>
  );
};
