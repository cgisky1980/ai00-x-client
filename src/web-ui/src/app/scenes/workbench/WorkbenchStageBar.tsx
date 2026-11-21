/**
 * WorkbenchStageBar — 工作台统一流程条：计划 → 执行 → 审核。
 *
 * 产品强调「先计划、再执行（任务列表）、最后人类审核」，所以这段流程要在所有
 * 工作台（任务场景 / 项目场景 / 插件工作台）里长得一样、读起来一致。
 * 细化状态（已停止 / 待验收 / 失败）仍由 `taskPhase` 承载，这里只把 6 个技术
 * 状态归并成 3 个业务阶段，避免每处各写一套。
 */
import React from 'react';
import { Check, X } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { TaskPhase } from '../tasks/taskPhase';
import { WORKBENCH_STAGES, needsYou, stageKeyOf, stageOf } from './workbenchStage';
import './WorkbenchStageBar.scss';

export interface WorkbenchStageBarProps {
  phase: TaskPhase;
  /** compact = 只留节点与短标签，用于窄头部。 */
  size?: 'default' | 'compact';
  className?: string;
}

export const WorkbenchStageBar: React.FC<WorkbenchStageBarProps> = ({
  phase,
  size = 'default',
  className,
}) => {
  const { t } = useI18n('common');
  const current = stageOf(phase);

  return (
    <ol
      className={[
        'ai00-x-stage-bar',
        `ai00-x-stage-bar--${size}`,
        `is-${current.state}`,
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={t('nav.workbenchWindow.stages.label')}
    >
      {WORKBENCH_STAGES.map((stage, index) => {
        const state =
          index < current.index
            ? 'done'
            : index === current.index
              ? current.state === 'failed'
                ? 'failed'
                : 'active'
              : 'todo';
        return (
          <li
            key={stage}
            className={`ai00-x-stage-bar__item is-${state}`}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <span className="ai00-x-stage-bar__node" aria-hidden>
              {state === 'done' && <Check size={10} />}
              {state === 'failed' && <X size={10} />}
            </span>
            <span className="ai00-x-stage-bar__label">
              {t(`nav.workbenchWindow.stages.${stage}`)}
            </span>
            {index < WORKBENCH_STAGES.length - 1 && (
              <span className="ai00-x-stage-bar__line" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
};

/**
 * 迷你形态：三个小圆点（计划 / 执行 / 审核），用于侧栏任务行这类极窄位置。
 * 与流程条同源（`stageOf`），保证任何地方看到的进度都一致。
 */
export const WorkbenchStageDots: React.FC<{ phase: TaskPhase; className?: string }> = ({
  phase,
  className,
}) => {
  const { t } = useI18n('common');
  const current = stageOf(phase);
  return (
    <span
      className={['ai00-x-stage-dots', className ?? ''].filter(Boolean).join(' ')}
      role="img"
      aria-label={t('nav.workbenchWindow.stages.label')}
      title={WORKBENCH_STAGES.map((stage, index) =>
        index < current.index
          ? `${t(`nav.workbenchWindow.stages.${stage}`)} ✓`
          : t(`nav.workbenchWindow.stages.${stage}`),
      ).join(' · ')}
    >
      {WORKBENCH_STAGES.map((stage, index) => {
        const state =
          index < current.index
            ? 'done'
            : index === current.index
              ? current.state
              : 'todo';
        return <span key={stage} className={`ai00-x-stage-dots__dot is-${state}`} />;
      })}
    </span>
  );
};

/**
 * 状态文字：阶段名（计划 / 执行 / 审核 / 已完成）+ 可选「需要你」徽标。
 * 列表、看板、头部统一用它，技术状态不直接出 UI 文案（规范 §9.2）。
 */
export const WorkbenchStatusTag: React.FC<{
  phase: TaskPhase;
  asking?: boolean;
  /** 只显示「需要你」徽标（看板卡片：列头已表明阶段）。 */
  hideStage?: boolean;
  /**
   * 快速问答任务：它没有计划/执行/审核这条流水线，阶段词会误导
   * （实测问答任务在列表里长期挂着「执行」）。改为显示「快速问答」。
   */
  quick?: boolean;
  className?: string;
}> = ({ phase, asking = false, hideStage = false, quick = false, className }) => {
  const { t } = useI18n('common');
  const failed = stageOf(phase).state === 'failed';
  const attention = needsYou(phase, asking);
  if (hideStage && !attention) return null;
  return (
    <span
      className={['ai00-x-status-tag', failed ? 'is-failed' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {!hideStage && (
        <span className="ai00-x-status-tag__stage">
          {quick
            ? t('nav.workbenchWindow.tasks.modeQuick')
            : t(`nav.workbenchWindow.stages.${stageKeyOf(phase)}`)}
        </span>
      )}
      {attention && (
        <span className="ai00-x-status-tag__needs">{t('nav.workbenchWindow.stages.needsYou')}</span>
      )}
    </span>
  );
};
