/**
 * WorkbenchStageBar — 工作台统一流程条：计划 → 执行 → 审核。
 *
 * 产品强调「先计划、再执行（任务列表）、最后人类审核」，所以这段流程要在所有
 * 工作台（任务场景 / 项目场景 / 插件工作台）里长得一样、读起来一致。
 * 细化状态（已停止 / 待验收 / 失败）仍由 `taskPhase` 承载，这里只把 6 个技术
 * 状态归并成 3 个业务阶段，避免每处各写一套。
 */
import React from 'react';
import {
  AlertCircle,
  BellRing,
  Check,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  HelpCircle,
  Loader2,
  Pause,
  Play,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { TaskPhase } from '../tasks/taskPhase';
import {
  WORKBENCH_STAGES,
  needsYou,
  stageKeyOf,
  stageOf,
  type WorkbenchStageKey,
} from './workbenchStage';
import './WorkbenchStageBar.scss';

/** 阶段图标：列表里不显示阶段文字时，靠这些图标保留语义。 */
const STAGE_ICONS: Record<WorkbenchStageKey, LucideIcon> = {
  plan: ClipboardList,
  execute: Play,
  review: ClipboardCheck,
  done: CheckCircle2,
};

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
 * 状态标签：默认保留文字；列表里用 `iconOnly` 只留一个带底色的状态图标，
 * 语义移到 title / aria-label。列表里不再用三颗阶段圆点——它和行尾的「...」操作
 * 都是小圆点，极易混淆；现在用阶段专属图标（清单 / 播放 / 勾验收 / 完成）替代。
 */
export const WorkbenchStatusTag: React.FC<{
  phase: TaskPhase;
  asking?: boolean;
  /** 只显示需要处理的徽标（看板列头等外部已表明阶段；列表主行不要传）。 */
  hideStage?: boolean;
  /**
   * 快速问答任务：它没有计划/执行/审核这条流水线，阶段词会误导
   * （实测问答任务在列表里长期挂着「执行」）。改为显示「快速问答」。
   */
  quick?: boolean;
  /** 窄列表专用：可见层只留图标，完整状态放进 title / aria-label。 */
  iconOnly?: boolean;
  className?: string;
}> = ({ phase, asking = false, hideStage = false, quick = false, iconOnly = false, className }) => {
  const { t } = useI18n('common');
  const failed = phase === 'failed';
  const attention = needsYou(phase, asking);
  const running = phase === 'running';
  const paused = phase === 'stopped';
  const stageKey = stageKeyOf(phase);
  if (hideStage && !iconOnly && !attention) return null;
  if (hideStage && iconOnly && !attention && !quick && !failed && !running && !paused) return null;

  const stageLabel = quick
    ? t('nav.workbenchWindow.tasks.modeQuick')
    : t(`nav.workbenchWindow.stages.${stageKey}`);
  const label = [
    failed ? t('status.failed') : null,
    asking ? t('nav.workbenchWindow.stages.asking') : null,
    attention && !asking && !failed ? t('nav.workbenchWindow.stages.needsYou') : null,
    running ? t('nav.workbenchWindow.plan.stageExecuting') : null,
    paused && !quick ? t('nav.workbenchWindow.stages.stopped') : null,
    hideStage || running ? null : stageLabel,
  ]
    .filter(Boolean)
    .join(' · ');

  if (iconOnly) {
    const StageIcon = STAGE_ICONS[stageKey];
    // 优先级按「越需要人立刻处理越靠前」：失败 > 提问 > 审批/验收 > 模式 > 运行 > 暂停 > 阶段。
    let Icon: LucideIcon | null = null;
    let stateClass = '';
    if (failed) {
      Icon = AlertCircle;
      stateClass = 'is-failed';
    } else if (asking) {
      Icon = HelpCircle;
      stateClass = 'is-asking';
    } else if (attention) {
      Icon = BellRing;
    } else if (quick) {
      Icon = Zap;
      stateClass = 'is-quick';
    } else if (running) {
      Icon = Loader2;
      stateClass = 'is-running';
    } else if (paused) {
      Icon = Pause;
      stateClass = 'is-paused';
    } else if (!hideStage) {
      Icon = StageIcon;
      stateClass = 'is-stage';
    }
    return (
      <span
        className={[
          'ai00-x-status-tag',
          'is-icon-only',
          attention ? 'has-attention' : '',
          stateClass,
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="img"
        aria-label={label}
        title={label}
      >
        {Icon && <Icon size={13} className="ai00-x-status-tag__icon" aria-hidden />}
      </span>
    );
  }

  return (
    <span
      className={['ai00-x-status-tag', failed ? 'is-failed' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {!hideStage && <span className="ai00-x-status-tag__stage">{stageLabel}</span>}
      {attention && (
        <span className="ai00-x-status-tag__needs">{t('nav.workbenchWindow.stages.needsYou')}</span>
      )}
    </span>
  );
};
