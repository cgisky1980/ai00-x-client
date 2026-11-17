/**
 * ComposerInteraction — 输入框下方那张「会升起来的卡」的内容层。
 *
 * 不放标题：需要人类动手时，内容本身就能说明问题（问题原文 / 交付物 / 步骤）。
 * 只剩两块：内容 + 动作，尽量少字。
 */
import React from 'react';
import { Button } from '@/component-library';
import './ComposerInteraction.scss';

export interface ComposerInteractionAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
}

export interface ComposerInteractionProps {
  /** 左侧状态点颜色。 */
  tone?: 'accent' | 'warning';
  /** 右侧极简计数（如 `2/5`、`3 项`）。 */
  meta?: string;
  children?: React.ReactNode;
  actions?: ComposerInteractionAction[];
}

export const ComposerInteraction: React.FC<ComposerInteractionProps> = ({
  tone = 'accent',
  meta,
  children,
  actions,
}) => (
  <div className={`ai00-x-interaction is-${tone}`}>
    <div className="ai00-x-interaction__body">
      <span className="ai00-x-interaction__dot" aria-hidden />
      <div className="ai00-x-interaction__content">{children}</div>
      {meta && <span className="ai00-x-interaction__meta">{meta}</span>}
    </div>

    {actions && actions.length > 0 && (
      <div className="ai00-x-interaction__actions">
        {actions.map((action) => (
          <Button
            key={action.label}
            variant={action.variant ?? 'secondary'}
            size="small"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ))}
      </div>
    )}
  </div>
);
