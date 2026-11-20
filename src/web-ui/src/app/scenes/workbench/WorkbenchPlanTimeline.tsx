/**
 * WorkbenchPlanTimeline — 计划执行步骤的竖向时间线。
 *
 * 每一步一行：状态圆（可代勾）+ 步骤卡（编号 / 标题 / 状态药丸 / 展开箭头）。
 * 当前步骤默认展开「正在执行」面板；展开后展示依赖 / 范围 / 验收 / 验证 / 证据。
 */
import React, { useMemo, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import {
  deriveStepState,
  type PlanRisk,
  type PlanStep,
  type PlanStepState,
} from '@/tools/todo/utils/planStructure';
import './WorkbenchPlanTimeline.scss';

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

export interface WorkbenchPlanTimelineProps {
  steps: PlanStep[];
  running?: boolean;
  taskCompleted?: boolean;
  readOnly?: boolean;
  onToggleDone?: (lineIndex: number, done: boolean) => void;
  className?: string;
}

export const WorkbenchPlanTimeline: React.FC<WorkbenchPlanTimelineProps> = ({
  steps,
  running = false,
  taskCompleted = false,
  readOnly = false,
  onToggleDone,
  className,
}) => {
  const { t } = useI18n('common');
  /** 仅记录用户显式切换过的步骤；未记录时按状态取默认值。 */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
    <ol className={`ai00-x-plan-timeline${className ? ` ${className}` : ''}`}>
      {steps.map((step, index) => {
        const key = step.id || `${index}`;
        const state = deriveStepState(step, {
          activeIndex,
          index,
          taskCompleted,
          running,
        });
        const open = expanded[key] ?? false;
        const desc = step.implementation || step.acceptance[0]?.text || '';

        return (
          <li key={key} className={`ai00-x-plan-timeline__item is-${state}`}>
            <div className="ai00-x-plan-timeline__rail">
              <button
                type="button"
                className={`ai00-x-plan-timeline__mark is-${state}`}
                aria-label={step.title}
                aria-pressed={step.done}
                disabled={readOnly}
                onClick={() => onToggleDone?.(step.lineIndex, !step.done)}
              >
                {step.done && <Check size={12} />}
              </button>
            </div>

            <article className="ai00-x-plan-timeline__card">
              <header className="ai00-x-plan-timeline__head">
                <span className="ai00-x-plan-timeline__id">{step.id || '·'}</span>
                <span className="ai00-x-plan-timeline__title" title={step.title}>
                  {step.title}
                </span>
                <span
                  className={`ai00-x-plan-timeline__state is-${STATE_TONE[state]}`}
                  data-state={state}
                >
                  {stateLabel(state)}
                </span>
                <button
                  type="button"
                  className="ai00-x-plan-timeline__toggle"
                  aria-expanded={open}
                  aria-label={open ? t('nav.workbenchWindow.plan.showLess') : t('nav.workbenchWindow.plan.showMore')}
                  onClick={() => setExpanded(prev => ({ ...prev, [key]: !open }))}
                >
                  <ChevronDown size={12} />
                </button>
              </header>

              {state === 'active' ? (
                <div className="ai00-x-plan-timeline__active">
                  <p className="ai00-x-plan-timeline__active-title">
                    <span className="ai00-x-plan-timeline__pulse" aria-hidden />
                    {t('nav.workbenchWindow.plan.executingNow')}
                    <span className="ai00-x-plan-timeline__active-name">{step.title}</span>
                  </p>
                  {desc && <p className="ai00-x-plan-timeline__desc">{desc}</p>}
                </div>
              ) : (
                desc && <p className="ai00-x-plan-timeline__desc">{desc}</p>
              )}

              {open && (
                <div className="ai00-x-plan-timeline__details">
                  <div className="ai00-x-plan-timeline__meta">
                    <span className="ai00-x-plan-timeline__meta-item">
                      <span className="ai00-x-plan-timeline__meta-label">
                        {t('nav.workbenchWindow.plan.dependencies')}
                      </span>
                      {step.dependencies.length === 0 ? (
                        <span className="ai00-x-plan-timeline__muted">
                          {t('nav.workbenchWindow.plan.noDependencies')}
                        </span>
                      ) : (
                        step.dependencies.map(dep => (
                          <code key={dep} className="ai00-x-plan-timeline__chip">
                            {dep}
                          </code>
                        ))
                      )}
                    </span>
                    <span className="ai00-x-plan-timeline__meta-item">
                      <span className="ai00-x-plan-timeline__meta-label">
                        {t('nav.workbenchWindow.plan.risk')}
                      </span>
                      <span className={`is-${RISK_TONE[step.risk]}`}>
                        {riskLabel(step.risk)}
                      </span>
                    </span>
                    {step.paths.length > 0 && (
                      <span className="ai00-x-plan-timeline__meta-item">
                        <span className="ai00-x-plan-timeline__meta-label">
                          {t('nav.workbenchWindow.plan.scope')}
                        </span>
                        {step.paths.map(path => (
                          <code key={path} className="ai00-x-plan-timeline__chip" title={path}>
                            {path}
                          </code>
                        ))}
                      </span>
                    )}
                  </div>

                  {step.acceptance.length > 0 && (
                    <ul className="ai00-x-plan-timeline__acceptance">
                      {step.acceptance.map(item => {
                        const verdict = step.verification?.verdict;
                        return (
                          <li key={item.text} className="ai00-x-plan-timeline__acceptance-row">
                            <span className="ai00-x-plan-timeline__acceptance-text">
                              {item.text}
                            </span>
                            {item.cmd && (
                              <code className="ai00-x-plan-timeline__cmd" title={item.cmd}>
                                {t('nav.workbenchWindow.plan.acceptanceCommand')}
                              </code>
                            )}
                            {verdict && (
                              <span
                                className={`ai00-x-plan-timeline__verify is-${
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

                  {(step.evidence || step.verification) && (
                    <div className="ai00-x-plan-timeline__evidence">
                      {step.verification?.at && (
                        <span>{t('nav.workbenchWindow.plan.verifiedAt', { at: step.verification.at })}</span>
                      )}
                      {step.evidence && (
                        <span className="ai00-x-plan-timeline__evidence-text">
                          <span className="ai00-x-plan-timeline__meta-label">
                            {t('nav.workbenchWindow.plan.evidence')}
                          </span>
                          {step.evidence}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </article>
          </li>
        );
      })}
    </ol>
  );
};

export default WorkbenchPlanTimeline;
