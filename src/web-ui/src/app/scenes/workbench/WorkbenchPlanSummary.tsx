/**
 * WorkbenchPlanSummary — 计划执行摘要条。
 *
 * 打开计划先回答「这份计划怎么执行」：执行方式、云端复审模式、进度、
 * 风险分布、当前阶段与当前模型组合。只读展示，不修改任何配置。
 */
import React, { useMemo } from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { getActiveProfile } from '@/agent/modelProfiles';
import { countRisks, parsePlanPolicy, type PlanStep } from '@/tools/todo/utils/planStructure';
import './WorkbenchPlanSummary.scss';

export interface WorkbenchPlanSummaryProps {
  steps: PlanStep[];
  /** 计划原文（用于读取执行策略段；缺省按旧计划展示）。 */
  planMd?: string | null;
  /** 会话正在运行。 */
  running?: boolean;
  /** 模型自检已提交、等待人类验收。 */
  awaitingReview?: boolean;
  /** 计划书已写好、等人类批准（此时「当前阶段」不能再显示待评审）。 */
  pendingApproval?: boolean;
  /** 任务已完成（人类验收通过）。 */
  taskCompleted?: boolean;
  /** 右侧入口。 */
  actions?: React.ReactNode;
  className?: string;
}

export const WorkbenchPlanSummary: React.FC<WorkbenchPlanSummaryProps> = ({
  steps,
  planMd = null,
  running = false,
  awaitingReview = false,
  pendingApproval = false,
  taskCompleted = false,
  actions,
  className,
}) => {
  const { t } = useI18n('common');

  const policy = useMemo(() => parsePlanPolicy(planMd), [planMd]);
  const risks = useMemo(() => countRisks(steps), [steps]);
  const done = steps.filter(step => step.done).length;
  const profileName = useMemo(() => {
    try {
      return getActiveProfile()?.name ?? '';
    } catch {
      return '';
    }
  }, []);

  if (steps.length === 0) return null;

  const stage = taskCompleted
    ? t('nav.workbenchWindow.plan.stageDone')
    : awaitingReview
      ? t('nav.workbenchWindow.plan.stageHumanReview')
      : pendingApproval
        ? t('nav.workbenchWindow.plan.stagePendingApproval')
        : running
          ? t('nav.workbenchWindow.plan.stageExecuting')
          : t('nav.workbenchWindow.plan.stageReviewing');

  const showPolicy = policy.execution === 'local-first' || planMd != null;

  return (
    <div className={`ai00-x-plan-summary${className ? ` ${className}` : ''}`}>
      <div className="ai00-x-plan-summary__items">
        {showPolicy && (
          <>
            <span className="ai00-x-plan-summary__item">
              <span className="ai00-x-plan-summary__label">
                {t('nav.workbenchWindow.plan.execution')}
              </span>
              {policy.execution === 'local-first'
                ? t('nav.workbenchWindow.plan.executionLocal')
                : t('nav.workbenchWindow.plan.executionLegacy')}
            </span>
            <span className="ai00-x-plan-summary__item">
              <span className="ai00-x-plan-summary__label">
                {t('nav.workbenchWindow.plan.reviewMode')}
              </span>
              {policy.review === 'strict'
                ? t('nav.workbenchWindow.plan.reviewStrict')
                : t('nav.workbenchWindow.plan.reviewAdaptive')}
            </span>
          </>
        )}
        <span className="ai00-x-plan-summary__item is-mono">
          {t('nav.workbenchWindow.plan.progress', { done, total: steps.length })}
        </span>
        {(risks.high > 0 || risks.medium > 0 || risks.low > 0) && (
          <span className="ai00-x-plan-summary__item">
            <span className="ai00-x-plan-summary__label">
              {t('nav.workbenchWindow.plan.risk')}
            </span>
            {t('nav.workbenchWindow.plan.riskSummary', {
              high: risks.high,
              medium: risks.medium,
              low: risks.low,
            })}
          </span>
        )}
        <span className="ai00-x-plan-summary__item">
          <span className="ai00-x-plan-summary__label">
            {t('nav.workbenchWindow.plan.currentStage')}
          </span>
          {stage}
        </span>
        {profileName && (
          <span className="ai00-x-plan-summary__item is-muted" title={profileName}>
            {profileName}
          </span>
        )}
      </div>
      {actions && <div className="ai00-x-plan-summary__actions">{actions}</div>}
    </div>
  );
};

export default WorkbenchPlanSummary;
