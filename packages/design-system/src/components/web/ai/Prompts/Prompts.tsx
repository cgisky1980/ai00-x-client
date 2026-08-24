/**
 * Prompts —— AI 提示词/示例卡（v0.15 AI 系，antd X Prompts/Welcome 对位）
 * hover 走 v0.14.2 主题自适应光晕（--ds-glow-card / --ds-card-hover-ring）。
 */
import React from 'react';
import './Prompts.scss';

export interface PromptItem {
  key: string;
  icon?: React.ReactNode;
  title: string;
  description?: string;
}

export interface PromptsProps {
  items: PromptItem[];
  onSelect?(key: string): void;
  /** 默认 2；≤640px 自动 1 列 */
  columns?: 1 | 2;
  className?: string;
}

export const Prompts: React.FC<PromptsProps> = ({
  items,
  onSelect,
  columns = 2,
  className = '',
}) => (
  <div className={['ai-prompts', `ai-prompts--c${columns}`, className].filter(Boolean).join(' ')}>
    {items.map((item) => (
      <button
        key={item.key}
        type="button"
        className="ai-prompts__item"
        onClick={() => onSelect?.(item.key)}
      >
        {item.icon != null && <span className="ai-prompts__icon">{item.icon}</span>}
        <span className="ai-prompts__text">
          <span className="ai-prompts__title">{item.title}</span>
          {item.description != null && <span className="ai-prompts__desc">{item.description}</span>}
        </span>
      </button>
    ))}
  </div>
);
