/**
 * WorkbenchPlanHero — 计划页顶部概览卡。
 *
 * 回答「这是什么计划、进行到哪、花了多久、风险多大」：标题 + 阶段 + 进度条，
 * 右侧三块真实指标（已用时 / 已完成 / 风险等级）。只读展示。
 */
import React, { useMemo } from 'react';
import { BrandMark } from '@ai00-x/design-system/react';
import { CheckCircle2, Clock3, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { TodoTask } from '@/tools/todo/api/types';
import {
  countRisks,
  parsePlanPolicy,
  type PlanRisk,
  type PlanStep,
} from '@/tools/todo/utils/planStructure';
import './WorkbenchPlanHero.scss';

export interface WorkbenchPlanHeroProps {
  task: TodoTask;
  steps: PlanStep[];
  /** 结构化步骤为空时的兜底总数（旧计划用勾选项数）。 */
  fallbackTotal?: number;
  fallbackDone?: number;
  planMd?: string | null;
  running?: boolean;
  awaitingReview?: boolean;
  pendingApproval?: boolean;
  taskCompleted?: boolean;
}

/** 最高已知风险等级：高 > 中 > 低；全部未知返回 null。 */
function topRisk(counts: Record<PlanRisk, number>): PlanRisk | null {
  if (counts.high > 0) return 'high';
  if (counts.medium > 0) return 'medium';
  if (counts.low > 0) return 'low';
  return null;
}

export const WorkbenchPlanHero: React.FC<WorkbenchPlanHeroProps> = ({
  task,
  steps,
  fallbackTotal = 0,
  fallbackDone = 0,
  planMd = null,
  running = false,
  awaitingReview = false,
  pendingApproval = false,
  taskCompleted = false,
}) => {
  const { t } = useI18n('common');

  const policy = useMemo(() => parsePlanPolicy(planMd), [planMd]);
  const risks = useMemo(() => countRisks(steps), [steps]);
  const total = steps.length > 0 ? steps.length : fallbackTotal;
  const done = steps.length > 0 ? steps.filter(step => step.done).length : fallbackDone;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const elapsedMin = Math.max(
    0,
    Math.round(((task.completedAt ?? Date.now()) - task.createdAt) / 60000),
  );
  const risk = topRisk(risks);

  const stageTone = taskCompleted
    ? 'done'
    : awaitingReview
      ? 'review'
      : pendingApproval
        ? 'pending'
        : running
          ? 'running'
          : 'review';

  const stage = taskCompleted
    ? t('nav.workbenchWindow.plan.stageDone')
    : awaitingReview
      ? t('nav.workbenchWindow.plan.stageHumanReview')
      : pendingApproval
        ? t('nav.workbenchWindow.plan.stagePendingApproval')
        : running
          ? t('nav.workbenchWindow.plan.stageExecuting')
          : t('nav.workbenchWindow.plan.stageReviewing');

  const riskLabel = (value: PlanRisk): string => {
    switch (value) {
      case 'high':
        return t('nav.workbenchWindow.plan.riskHigh');
      case 'medium':
        return t('nav.workbenchWindow.plan.riskMedium');
      case 'low':
        return t('nav.workbenchWindow.plan.riskLow');
      default:
        return t('nav.workbenchWindow.plan.riskUnknown');
    }
  };

  return (
    <section className="ai00-x-plan-hero">
      <div className="ai00-x-plan-hero__main">
        <span className="ai00-x-plan-hero__avatar" aria-hidden>
          <BrandMark variant="seal" size={40} />
        </span>

        <div className="ai00-x-plan-hero__text">
          <h2 className="ai00-x-plan-hero__title" title={task.title}>
            {task.title}
          </h2>
          <p className="ai00-x-plan-hero__meta">
            <span className={`ai00-x-plan-hero__stage is-${stageTone}`}>{stage}</span>
            <span className="ai00-x-plan-hero__chip">
              {policy.execution === 'local-first'
                ? t('nav.workbenchWindow.plan.executionLocal')
                : t('nav.workbenchWindow.plan.executionLegacy')}
            </span>
            <span className="ai00-x-plan-hero__chip">
              {policy.review === 'strict'
                ? t('nav.workbenchWindow.plan.reviewStrict')
                : t('nav.workbenchWindow.plan.reviewAdaptive')}
            </span>
          </p>

          <div className="ai00-x-plan-hero__progress">
            <div
              className="ai00-x-plan-hero__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label={t('nav.workbenchWindow.plan.progress', { done, total })}
            >
              <span
                className="ai00-x-plan-hero__bar-fill"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="ai00-x-plan-hero__percent">{percent}%</span>
          </div>
        </div>
      </div>

      <div className="ai00-x-plan-hero__stats">
        <div className="ai00-x-plan-hero__stat">
          <Clock3 className="ai00-x-plan-hero__stat-icon" size={14} aria-hidden />
          <span className="ai00-x-plan-hero__stat-value">
            {t('nav.workbenchWindow.plan.elapsedMinutes', { min: elapsedMin })}
          </span>
          <span className="ai00-x-plan-hero__stat-label">
            {t('nav.workbenchWindow.plan.elapsed')}
          </span>
        </div>

        <div className="ai00-x-plan-hero__stat">
          <CheckCircle2 className="ai00-x-plan-hero__stat-icon" size={14} aria-hidden />
          <span className="ai00-x-plan-hero__stat-value is-mono">
            {done} / {total}
          </span>
          <span className="ai00-x-plan-hero__stat-label">
            {t('nav.workbenchWindow.plan.overviewDone')}
          </span>
        </div>

        {risk && (
          <div className="ai00-x-plan-hero__stat">
            <ShieldCheck className="ai00-x-plan-hero__stat-icon" size={14} aria-hidden />
            <span className={`ai00-x-plan-hero__stat-value is-${risk}`}>
              {riskLabel(risk)}
            </span>
            <span className="ai00-x-plan-hero__stat-label">
              {t('nav.workbenchWindow.plan.riskLevel')}
            </span>
          </div>
        )}
      </div>
    </section>
  );
};

export default WorkbenchPlanHero;
