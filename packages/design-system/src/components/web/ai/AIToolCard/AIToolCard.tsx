/**
 * AIToolCard —— AI 工具调用卡（v0.15 AI 系）
 * BaseToolCard 降耦重制：五态（running/success/error/confirm/cancelled），
 * 确认态展开确认/拒绝按钮组，点击头折叠。
 */
import React, { useState } from 'react';
import { label } from '../../../../lib/labels';
import './AIToolCard.scss';

export type AIToolCardStatus = 'running' | 'success' | 'error' | 'confirm' | 'cancelled';

export interface AIToolCardConfirm {
  onConfirm(): void;
  onReject(): void;
  confirmText?: string;
  rejectText?: string;
}

export interface AIToolCardProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  status: AIToolCardStatus;
  /** 耗时/文件名等 mono 信息 */
  meta?: React.ReactNode;
  /** 可折叠（有展开内容时设 true） */
  expandable?: boolean;
  defaultExpanded?: boolean;
  confirm?: AIToolCardConfirm;
  /** 错误详情（status=error 时显示于展开区顶部） */
  error?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

const StatusIcon: React.FC<{ status: AIToolCardStatus }> = ({ status }) => {
  switch (status) {
    case 'running':
      return <span className="ai-tool-card__spinner" aria-hidden="true" />;
    case 'success':
      return (
        <svg viewBox="0 0 12 12" className="ai-tool-card__mark ai-tool-card__mark--ok" aria-hidden="true">
          <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'error':
      return (
        <svg viewBox="0 0 12 12" className="ai-tool-card__mark ai-tool-card__mark--err" aria-hidden="true">
          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'confirm':
      return (
        <svg viewBox="0 0 12 12" className="ai-tool-card__mark ai-tool-card__mark--ask" aria-hidden="true">
          <path d="M6 2.2v5.6M6 9.4v.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'cancelled':
      return (
        <svg viewBox="0 0 12 12" className="ai-tool-card__mark ai-tool-card__mark--cancel" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
          <path d="M3.8 3.8L8.2 8.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
  }
};

export const AIToolCard: React.FC<AIToolCardProps> = ({
  icon,
  title,
  status,
  meta,
  expandable = false,
  defaultExpanded = false,
  confirm,
  error,
  children,
  className = '',
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded || status === 'confirm');
  const hasBody = status === 'confirm' || error != null || children != null;
  const canToggle = expandable && hasBody && status !== 'confirm';
  const expandedNow = status === 'confirm' ? true : expanded;

  return (
    <div
      className={[
        'ai-tool-card',
        `ai-tool-card--${status}`,
        canToggle && 'ai-tool-card--expandable',
        expandedNow && 'is-expanded',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className="ai-tool-card__head"
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        aria-expanded={canToggle ? expandedNow : undefined}
        onClick={() => canToggle && setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (canToggle && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <span className="ai-tool-card__status"><StatusIcon status={status} /></span>
        {icon != null && <span className="ai-tool-card__icon">{icon}</span>}
        <span className="ai-tool-card__title">{title}</span>
        {meta != null && <span className="ai-tool-card__meta">{meta}</span>}
        {canToggle && (
          <svg className="ai-tool-card__chevron" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>

      {hasBody && expandedNow && (
        <div className="ai-tool-card__body">
          {error != null && <div className="ai-tool-card__error">{error}</div>}
          {children}
          {status === 'confirm' && confirm && (
            <div className="ai-tool-card__confirm">
              <button
                type="button"
                className="ai-tool-card__btn ai-tool-card__btn--primary"
                onClick={confirm.onConfirm}
              >
                {confirm.confirmText ?? label('components.ai.confirm', '确认执行')}
              </button>
              <button
                type="button"
                className="ai-tool-card__btn"
                onClick={confirm.onReject}
              >
                {confirm.rejectText ?? label('components.ai.reject', '拒绝')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
