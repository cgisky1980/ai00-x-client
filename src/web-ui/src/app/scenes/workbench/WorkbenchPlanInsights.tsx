/**
 * WorkbenchPlanInsights — 计划页底部三张洞察卡：概览 / 风险评估 / 核心目标。
 *
 * 数据全部来自计划书本身；缺数据的卡不渲染（grid 自动收紧）。
 */
import React, { useMemo } from 'react';
import { ChartColumn, ShieldCheck, Target } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import {
  countRisks,
  parsePlanGoal,
  type PlanRisk,
  type PlanStep,
} from '@/tools/todo/utils/planStructure';
import './WorkbenchPlanInsights.scss';

export interface WorkbenchPlanInsightsProps {
  steps: PlanStep[];
  /** 结构化步骤为空时的兜底统计（旧计划）。 */
  fallbackTotal?: number;
  fallbackDone?: number;
  planMd?: string | null;
  /** 计划书没有「目标」段时的回退（任务卡片 goal）。 */
  fallbackGoal?: string;
}

export const WorkbenchPlanInsights: React.FC<WorkbenchPlanInsightsProps> = ({
  steps,
  fallbackTotal = 0,
  fallbackDone = 0,
  planMd = null,
  fallbackGoal,
}) => {
  const { t } = useI18n('common');

  const total = steps.length > 0 ? steps.length : fallbackTotal;
  const done = steps.length > 0 ? steps.filter(step => step.done).length : fallbackDone;
  const risks = useMemo(() => countRisks(steps), [steps]);
  const known = risks.high + risks.medium + risks.low;
  const goal = useMemo(() => parsePlanGoal(planMd) || (fallbackGoal ?? '').trim(), [planMd, fallbackGoal]);

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

  const level: PlanRisk =
    risks.high > 0 ? 'high' : risks.medium > 0 ? 'medium' : risks.low > 0 ? 'low' : 'unknown';

  /** 环图各段占比（高 → 中 → 低 → 未标），按顺时针画 conic-gradient。 */
  const ringStops = useMemo(() => {
    const counted: Array<[number, string]> = [
      [risks.high, 'var(--color-error)'],
      [risks.medium, 'var(--color-warning)'],
      [risks.low, 'var(--color-success)'],
      [risks.unknown, 'var(--border-subtle)'],
    ];
    const sum = counted.reduce((acc, [count]) => acc + count, 0);
    if (sum === 0) return '';
    let cursor = 0;
    const parts = counted
      .filter(([count]) => count > 0)
      .map(([count, color]) => {
        const from = cursor;
        cursor += (count / sum) * 100;
        return `${color} ${from}% ${cursor}%`;
      });
    return `conic-gradient(${parts.join(', ')})`;
  }, [risks]);

  if (total === 0 && !goal && known === 0) return null;

  return (
    <div className="ai00-x-plan-insights">
      <section className="ai00-x-plan-insights__card">
        <h3 className="ai00-x-plan-insights__title">
          <ChartColumn size={14} aria-hidden />
          {t('nav.workbenchWindow.plan.overviewTitle')}
        </h3>
        <div className="ai00-x-plan-insights__numbers">
          <div className="ai00-x-plan-insights__number">
            <span className="ai00-x-plan-insights__value">{total}</span>
            <span className="ai00-x-plan-insights__label">
              {t('nav.workbenchWindow.plan.overviewTotal')}
            </span>
          </div>
          <div className="ai00-x-plan-insights__number">
            <span className="ai00-x-plan-insights__value is-done">{done}</span>
            <span className="ai00-x-plan-insights__label">
              {t('nav.workbenchWindow.plan.overviewDone')}
            </span>
          </div>
          <div className="ai00-x-plan-insights__number">
            <span className="ai00-x-plan-insights__value is-pending">{total - done}</span>
            <span className="ai00-x-plan-insights__label">
              {t('nav.workbenchWindow.plan.overviewPending')}
            </span>
          </div>
        </div>
      </section>

      {known > 0 && (
        <section className="ai00-x-plan-insights__card">
          <h3 className="ai00-x-plan-insights__title">
            <ShieldCheck size={14} aria-hidden />
            {t('nav.workbenchWindow.plan.riskAssessment')}
          </h3>
          <div className="ai00-x-plan-insights__risk">
            <span
              className="ai00-x-plan-insights__ring"
              style={{ backgroundImage: ringStops }}
              role="img"
              aria-label={`${t('nav.workbenchWindow.plan.riskLevel')}: ${riskLabel(level)}`}
            >
              <span className="ai00-x-plan-insights__ring-center">
                <span className={`ai00-x-plan-insights__ring-label is-${level}`}>
                  {riskLabel(level)}
                </span>
                <span className="ai00-x-plan-insights__ring-caption">
                  {t('nav.workbenchWindow.plan.riskLevel')}
                </span>
              </span>
            </span>
            <ul className="ai00-x-plan-insights__legend">
              {(['high', 'medium', 'low', 'unknown'] as const)
                .filter(key => risks[key] > 0)
                .map(key => (
                  <li key={key} className="ai00-x-plan-insights__legend-row">
                    <span className={`ai00-x-plan-insights__dot is-${key}`} aria-hidden />
                    <span className="ai00-x-plan-insights__legend-label">
                      {riskLabel(key)}
                    </span>
                    <span className="ai00-x-plan-insights__legend-count">{risks[key]}</span>
                  </li>
                ))}
            </ul>
          </div>
        </section>
      )}

      {goal && (
        <section className="ai00-x-plan-insights__card">
          <h3 className="ai00-x-plan-insights__title">
            <Target size={14} aria-hidden />
            {t('nav.workbenchWindow.plan.goalTitle')}
          </h3>
          <p className="ai00-x-plan-insights__goal">{goal}</p>
        </section>
      )}
    </div>
  );
};

export default WorkbenchPlanInsights;
