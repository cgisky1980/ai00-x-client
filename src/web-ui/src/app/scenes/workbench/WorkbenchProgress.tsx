/**
 * WorkbenchProgress — 标准「进度」模块（对齐 ZCode 的进度卡）。
 *
 * Agent 干活的最小可视化单元：把计划步骤摊开，标出已完成 / 进行中 / 待办。
 * 这是所有工作台共用的一块，不各写一套：
 * - 已完成：对勾圆 + 删除线；
 * - 进行中：箭头 + 强调色（无圆圈）；
 * - 待办：空心圆 + 弱文本。
 */
import React from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import './WorkbenchProgress.scss';

export interface WorkbenchProgressStep {
  text: string;
  done: boolean;
}

export interface WorkbenchProgressProps {
  steps: WorkbenchProgressStep[];
  /** 当前正在做的步骤索引；null = 不标进行中（如已完成/已停止）。 */
  activeIndex?: number | null;
  /** 标题右侧的补充说明（例如「计划已生成」）。 */
  hint?: string;
  className?: string;
  /** 隐藏自带的「进度 x/y」标题行（外层已有标题时用）。 */
  hideHead?: boolean;
}

export const WorkbenchProgress: React.FC<WorkbenchProgressProps> = ({
  steps,
  activeIndex = null,
  hint,
  className,
  hideHead = false,
}) => {
  const { t } = useI18n('common');
  const done = steps.filter((step) => step.done).length;

  return (
    <section className={['ai00-x-progress', className ?? ''].filter(Boolean).join(' ')}>
      {!hideHead && (
        <header className="ai00-x-progress__head">
          <span className="ai00-x-progress__title">{t('nav.workbenchWindow.progress.title')}</span>
          <span className="ai00-x-progress__count">
            {done}/{steps.length}
          </span>
          {hint && <span className="ai00-x-progress__hint">{hint}</span>}
        </header>
      )}

      {steps.length === 0 ? (
        <p className="ai00-x-progress__empty">{t('nav.workbenchWindow.progress.empty')}</p>
      ) : (
        <ol className="ai00-x-progress__list">
          {steps.map((step, index) => {
            const state = step.done ? 'done' : index === activeIndex ? 'active' : 'todo';
            return (
              <li key={`${index}-${step.text}`} className={`ai00-x-progress__item is-${state}`}>
                <span className="ai00-x-progress__mark" aria-hidden>
                  {state === 'done' && <Check size={13} />}
                  {state === 'active' && <ArrowRight size={13} />}
                </span>
                <span className="ai00-x-progress__text">{step.text}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};
