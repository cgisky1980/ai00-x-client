/**
 * WorkbenchPlanRail — 常驻输入框下方的计划条（纸叠的最底一张）。
 *
 * 折叠：`2/6 · T3 标题 · 待评审` 一行；
 * 展开：结构化任务卡（紧凑模式）向上展开；
 * 右侧小图标进详情抽屉。
 *
 * 旧计划（无 T 编号）回落文本步骤与三态进度。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, PanelRight } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { parseStepItems } from '@/tools/todo/utils/planAcceptance';
import { deriveStepState, parsePlanSteps } from '@/tools/todo/utils/planStructure';
import { WorkbenchProgress } from './WorkbenchProgress';
import { WorkbenchTaskCards } from './WorkbenchTaskCards';
import './WorkbenchPlanRail.scss';

export interface WorkbenchPlanRailProps {
  planMd: string | null | undefined;
  /** 有未处理的人类动作时自动展开（评审/验收）。 */
  autoOpen?: boolean;
  /** 打开完整计划（抽屉）。 */
  onViewDetail?: () => void;
  /** 是否已完成（完成后不标进行中）。 */
  finished?: boolean;
  /** 会话是否在跑（决定是否标「进行中」）。 */
  running?: boolean;
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
  autoOpen = false,
  onViewDetail,
  finished = false,
  running = false,
}) => {
  const { t } = useI18n('common');
  const structured = useMemo(() => parsePlanSteps(planMd ?? null), [planMd]);
  const legacySteps = useMemo(() => parseStepItems(planMd ?? null), [planMd]);
  const [open, setOpen] = useState(autoOpen);

  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  const isStructured = structured.length > 0;
  const total = isStructured ? structured.length : legacySteps.length;
  const done = isStructured
    ? structured.filter(step => step.done).length
    : legacySteps.filter(step => step.done).length;

  if (total === 0) return null;

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
      {onViewDetail && (
        <button
          type="button"
          className="ai00-x-plan-strip__more"
          onClick={onViewDetail}
          title={t('nav.workbenchWindow.progress.detail')}
          aria-label={t('nav.workbenchWindow.progress.detail')}
        >
          <PanelRight size={12} />
        </button>
      )}

      {open && (
        <div className="ai00-x-plan-strip__steps">
          {isStructured ? (
            <WorkbenchTaskCards
              planMd={planMd ?? null}
              steps={structured}
              compact
              running={running}
              taskCompleted={finished}
            />
          ) : (
            <WorkbenchProgress steps={legacySteps} activeIndex={activeIndex} hideHead />
          )}
        </div>
      )}
    </section>
  );
};
