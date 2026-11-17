/**
 * WorkbenchTaskCards — 工作台计划的结构化任务卡。
 *
 * 每个 `T<id>` 步骤一张卡：编号 / 标题 / 状态 / 依赖 / 风险 / 范围 /
 * 实施细则 / 验收命令与验证结果 / 证据。紧凑模式用于输入框计划条与计划确认卡。
 *
 * 旧计划（无 T 编号）由调用方降级到 WorkbenchProgress，不会渲染空列表。
 */
import React, { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import {
  deriveStepState,
  parsePlanSteps,
  type PlanRisk,
  type PlanStep,
  type PlanStepState,
} from '@/tools/todo/utils/planStructure';
import './WorkbenchTaskCards.scss';

export interface WorkbenchTaskCardsProps {
  planMd: string | null;
  /** 任务会话是否在跑（决定是否标「进行中」）。 */
  running?: boolean;
  /** 任务已完成。 */
  taskCompleted?: boolean;
  /** 紧凑模式：只展示编号 / 标题 / 状态 / 风险。 */
  compact?: boolean;
  /** 只读（计划确认卡用）。 */
  readOnly?: boolean;
  /** 人类代勾某一步（回写计划文件）。 */
  onToggleDone?: (lineIndex: number, done: boolean) => void;
  /** 外部传入已解析步骤（避免重复解析）。 */
  steps?: PlanStep[];
  className?: string;
}

const STATE_TONE: Record<PlanStepState, string> = {
  todo: 'muted',
  active: 'accent',
  review: 'accent',
  rework: 'warning',
  done: 'success',
  fallback: 'warning',
  failed: 'error',
};

const RISK_TONE: Record<PlanRisk, string> = {
  low: 'muted',
  medium: 'accent',
  high: 'error',
  unknown: 'muted',
};

export const WorkbenchTaskCards: React.FC<WorkbenchTaskCardsProps> = ({
  planMd,
  running = false,
  taskCompleted = false,
  compact = false,
  readOnly = false,
  onToggleDone,
  steps: stepsProp,
  className,
}) => {
  const { t } = useI18n('common');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const steps = useMemo(
    () => stepsProp ?? parsePlanSteps(planMd),
    [planMd, stepsProp],
  );
  const activeIndex = useMemo(() => {
    const index = steps.findIndex(step => !step.done);
    return index >= 0 ? index : null;
  }, [steps]);

  if (steps.length === 0) return null;

  const stateLabel = (state: PlanStepState): string => {
    switch (state) {
      case 'active':
        return t('nav.workbenchWindow.plan.stateActive');
      case 'review':
        return t('nav.workbenchWindow.plan.stateReview');
      case 'rework':
        return t('nav.workbenchWindow.plan.stateRework');
      case 'done':
        return t('nav.workbenchWindow.plan.stateDone');
      case 'fallback':
        return t('nav.workbenchWindow.plan.stateFallback');
      case 'failed':
        return t('nav.workbenchWindow.plan.stateFailed');
      default:
        return t('nav.workbenchWindow.plan.stateTodo');
    }
  };

  const riskLabel = (risk: PlanRisk): string => {
    switch (risk) {
      case 'low':
        return t('nav.workbenchWindow.plan.riskLow');
      case 'medium':
        return t('nav.workbenchWindow.plan.riskMedium');
      case 'high':
        return t('nav.workbenchWindow.plan.riskHigh');
      default:
        return t('nav.workbenchWindow.plan.riskUnknown');
    }
  };

  return (
    <div className={`ai00-x-task-cards${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}>
      {steps.map((step, index) => {
        const state = deriveStepState(step, {
          activeIndex,
          index,
          taskCompleted,
          running,
        });
        const open = compact ? false : expanded[step.id] === true;
        const visiblePaths = open ? step.paths : step.paths.slice(0, 3);
        const hiddenPaths = step.paths.length - visiblePaths.length;

        return (
          <article
            key={step.id || `${index}`}
            className={`ai00-x-task-card is-${state}${open ? ' is-open' : ''}`}
          >
            <header className="ai00-x-task-card__head">
              {!readOnly && (
                <button
                  type="button"
                  className={`ai00-x-task-card__check${step.done ? ' is-done' : ''}`}
                  aria-label={step.title}
                  aria-pressed={step.done}
                  onClick={() => onToggleDone?.(step.lineIndex, !step.done)}
                >
                  {step.done ? '✓' : ''}
                </button>
              )}
              <span className="ai00-x-task-card__id">{step.id || '·'}</span>
              <span className="ai00-x-task-card__title" title={step.title}>
                {step.title}
              </span>
              <span
                className={`ai00-x-task-card__state is-${STATE_TONE[state]}`}
                data-state={state}
              >
                {stateLabel(state)}
              </span>
              {!compact && (
                <span className={`ai00-x-task-card__risk is-${RISK_TONE[step.risk]}`}>
                  {t('nav.workbenchWindow.plan.risk')} {riskLabel(step.risk)}
                </span>
              )}
              {!compact && (
                <button
                  type="button"
                  className="ai00-x-task-card__toggle"
                  aria-expanded={open}
                  onClick={() =>
                    setExpanded(prev => ({ ...prev, [step.id || `${index}`]: !open }))
                  }
                >
                  <ChevronDown size={12} />
                </button>
              )}
            </header>

            {!compact && (
              <div className="ai00-x-task-card__meta">
                <div className="ai00-x-task-card__meta-item">
                  <span className="ai00-x-task-card__meta-label">
                    {t('nav.workbenchWindow.plan.dependencies')}
                  </span>
                  {step.dependencies.length === 0 ? (
                    <span className="ai00-x-task-card__muted">
                      {t('nav.workbenchWindow.plan.noDependencies')}
                    </span>
                  ) : (
                    step.dependencies.map(dep => (
                      <code key={dep} className="ai00-x-task-card__chip">
                        {dep}
                      </code>
                    ))
                  )}
                </div>
                {step.paths.length > 0 && (
                  <div className="ai00-x-task-card__meta-item">
                    <span className="ai00-x-task-card__meta-label">
                      {t('nav.workbenchWindow.plan.scope')}
                    </span>
                    {visiblePaths.map(path => (
                      <code key={path} className="ai00-x-task-card__chip" title={path}>
                        {path}
                      </code>
                    ))}
                    {hiddenPaths > 0 && (
                      <button
                        type="button"
                        className="ai00-x-task-card__more"
                        onClick={() =>
                          setExpanded(prev => ({ ...prev, [step.id || `${index}`]: true }))
                        }
                      >
                        +{hiddenPaths}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {!compact && step.implementation && (
              <p className={`ai00-x-task-card__impl${open ? ' is-full' : ''}`}>
                {step.implementation}
              </p>
            )}

            {!compact && step.acceptance.length > 0 && (
              <ul className="ai00-x-task-card__acceptance">
                {step.acceptance.map(item => {
                  const verdict = step.verification?.verdict;
                  return (
                    <li key={item.text} className="ai00-x-task-card__acceptance-row">
                      <span className="ai00-x-task-card__acceptance-text">{item.text}</span>
                      {item.cmd && (
                        <code className="ai00-x-task-card__cmd" title={item.cmd}>
                          {t('nav.workbenchWindow.plan.acceptanceCommand')}
                        </code>
                      )}
                      {verdict && (
                        <span
                          className={`ai00-x-task-card__verify is-${
                            verdict === 'passed'
                              ? 'success'
                              : verdict === 'failed'
                                ? 'error'
                                : 'warning'
                          }`}
                        >
                          {verdict === 'passed'
                            ? t('nav.workbenchWindow.plan.verifyPassed')
                            : verdict === 'failed'
                              ? t('nav.workbenchWindow.plan.verifyFailed')
                              : t('nav.workbenchWindow.plan.verifyNeedsReview')}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {!compact && (step.evidence || step.verification) && (
              <div className="ai00-x-task-card__evidence">
                {step.verification?.at && (
                  <span className="ai00-x-task-card__evidence-at">
                    {t('nav.workbenchWindow.plan.verifiedAt', {
                      at: step.verification.at,
                    })}
                  </span>
                )}
                {step.evidence && (
                  <span className="ai00-x-task-card__evidence-text">
                    <span className="ai00-x-task-card__meta-label">
                      {t('nav.workbenchWindow.plan.evidence')}
                    </span>
                    {step.evidence}
                  </span>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
};

export default WorkbenchTaskCards;
