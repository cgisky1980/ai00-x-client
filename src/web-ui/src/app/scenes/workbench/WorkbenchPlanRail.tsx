/**
 * WorkbenchPlanRail — 常驻输入框上方的任务状态卡（纸叠的最底一张）。
 *
 * 主行：`2/6 · T3 标题 · 待评审` + 展开键（无计划时让位给子代理状态）；
 * 辅行：本轮消耗（由调用方渲染）；
 * 展开区：紧凑步骤列表（完整视图在中央计划卡，规范 v0.23 §9.2）；
 * 「需要你」时追加一行提示，推进按钮只在计划卡（入口唯一）。
 *
 * 旧计划（无 T 编号）回落文本步骤与三态进度；三者皆空时整卡不渲染。
 */
import React, { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { parseStepItems } from '@/tools/todo/utils/planAcceptance';
import { deriveStepState, parsePlanSteps } from '@/tools/todo/utils/planStructure';
import { WorkbenchProgress } from './WorkbenchProgress';
import './WorkbenchPlanRail.scss';

export interface WorkbenchPlanRailProps {
  planMd: string | null | undefined;
  /** 是否已完成（完成后不标进行中）。 */
  finished?: boolean;
  /** 会话是否在跑（决定是否标「进行中」）。 */
  running?: boolean;
  /** 辅行：本轮消耗（由调用方渲染好的节点）。 */
  usage?: React.ReactNode;
  /** 「需要你」提示（如「计划待你批准，请在计划页操作」）。 */
  notice?: string;
}

const STATE_KEY: Record<string, string> = {
  active: 'nav.workbenchWindow.plan.stateActive',
  review: 'nav.workbenchWindow.plan.stateReview',
  rework: 'nav.workbenchWindow.plan.stateRework',
  done: 'nav.workbenchWindow.plan.stateDone',
  fallback: 'nav.workbenchWindow.plan.stateFallback',
  failed: 'nav.workbenchWindow.plan.stateFailed',
  todo: 'nav.workbenchWindow.plan.stateTodo',
};

export const WorkbenchPlanRail: React.FC<WorkbenchPlanRailProps> = ({
  planMd,
  finished = false,
  running = false,
  usage,
  notice,
}) => {
  const { t } = useI18n('common');
  const structured = useMemo(() => parsePlanSteps(planMd ?? null), [planMd]);
  const legacySteps = useMemo(() => parseStepItems(planMd ?? null), [planMd]);
  const [open, setOpen] = useState(false);

  const isStructured = structured.length > 0;
  const total = isStructured ? structured.length : legacySteps.length;
  const done = isStructured
    ? structured.filter(step => step.done).length
    : legacySteps.filter(step => step.done).length;

  if (total === 0 && !usage && !notice) return null;

  const activeIndex = finished
    ? null
    : isStructured
      ? structured.findIndex(step => !step.done) >= 0
        ? structured.findIndex(step => !step.done)
        : null
      : legacySteps.findIndex(step => !step.done) >= 0
        ? legacySteps.findIndex(step => !step.done)
        : null;

  const currentStep = activeIndex != null ? structured[activeIndex] : undefined;
  const currentState = currentStep
    ? deriveStepState(currentStep, {
        activeIndex,
        index: activeIndex as number,
        taskCompleted: finished,
        running,
      })
    : null;
  const currentText = finished
    ? t('nav.workbenchWindow.progress.allDone')
    : isStructured
      ? currentStep
        ? `${currentStep.id} ${currentStep.title}`
        : t('nav.workbenchWindow.progress.allDone')
      : activeIndex != null
        ? (legacySteps[activeIndex]?.text ?? '')
        : t('nav.workbenchWindow.progress.allDone');

  return (
    <section className={`ai00-x-plan-strip${open ? ' is-open' : ''}`}>
      {/* 子代理运行态只在对话顶部的汇总条表达，这里不重复 */}
      {total > 0 && (
        <div className="ai00-x-plan-strip__head">
          <button
            type="button"
            className="ai00-x-plan-strip__main"
            onClick={() => setOpen(prev => !prev)}
            aria-expanded={open}
          >
            <span className="ai00-x-plan-strip__count">
              {done}/{total}
            </span>
            <span className="ai00-x-plan-strip__text">{currentText}</span>
            {currentState && (
              <span className={`ai00-x-plan-strip__state is-${currentState}`}>
                {t(STATE_KEY[currentState])}
              </span>
            )}
            <ChevronDown size={12} className="ai00-x-plan-strip__chevron" />
          </button>
        </div>
      )}

      {notice && (
        <p className="ai00-x-plan-strip__notice" role="status">
          {notice}
        </p>
      )}

      {usage && <div className="ai00-x-plan-strip__usage">{usage}</div>}

      {open && total > 0 && (
        <div className="ai00-x-plan-strip__steps">
          <WorkbenchProgress
            steps={
              isStructured
                ? structured.map((step) => ({ text: `${step.id} ${step.title}`, done: step.done }))
                : legacySteps
            }
            activeIndex={activeIndex}
            hideHead
          />
        </div>
      )}
    </section>
  );
};
