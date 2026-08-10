import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Loader2, CheckCircle, FileText, ChevronRight, Pencil, Search } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { useActiveSession } from '@/flow_chat/store/modernFlowChatStore';
import { FlowChatStore } from '@/flow_chat/store/FlowChatStore';
import { ideControl } from '@/shared/services/ide-control/api';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { planBuildStateService, type PlanTodo } from '@/shared/services/PlanBuildStateService';
import yaml from 'yaml';
import './PlanInputCard.scss';

interface PlanData {
  name: string;
  overview: string;
  todos: PlanTodo[];
}

function parsePlanFile(content: string): PlanData | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const parsed = yaml.parse(fmMatch[1]);
  return {
    name: parsed?.name || '',
    overview: parsed?.overview || '',
    todos: parsed?.todos || [],
  };
}

export const PlanInputCard: React.FC = () => {
  const { t } = useI18n('flow-chat');
  const activeSession = useActiveSession();
  const [planData, setPlanData] = useState<PlanData | null>(null);

  const sessionId = activeSession?.sessionId ?? '';
  const planFilePath = activeSession?.planFilePath ?? null;
  const workflowPhase = activeSession?.workflowPhase;
  const isAwaiting = activeSession?.planConfirmation?.isAwaiting ?? false;
  const autoReviewState = activeSession?.planConfirmation?.autoReviewState ?? 'idle';
  const isArchived = activeSession?.completionPhase === 'archived';

  const loadPlanData = useCallback(async (filePath: string) => {
    try {
      const content = await workspaceAPI.readFileContent(filePath);
      const data = parsePlanFile(content);
      if (data) setPlanData(data);
    } catch {
      setPlanData(null);
    }
  }, []);

  useEffect(() => {
    if (planFilePath) {
      loadPlanData(planFilePath);
    } else {
      setPlanData(null);
    }
  }, [planFilePath, loadPlanData]);

  useEffect(() => {
    if (!planFilePath) return;
    const unsub = planBuildStateService.subscribe(planFilePath, (event) => {
      if (event.updatedTodos) {
        setPlanData(prev => prev ? { ...prev, todos: event.updatedTodos! } : null);
      }
    });
    return unsub;
  }, [planFilePath]);

  const completedCount = useMemo(() => {
    if (!planData?.todos) return 0;
    return planData.todos.filter(t => t.status === 'completed').length;
  }, [planData]);

  const totalCount = planData?.todos?.length ?? 0;
  const allDone = totalCount > 0 && completedCount === totalCount;

  useEffect(() => {
    if (allDone && sessionId && activeSession?.mode !== 'Wallpaper') {
      const store = FlowChatStore.getInstance();
      store.setTaskCompleted(sessionId, true);
    }
  }, [allDone, sessionId, activeSession?.mode]);

  const handleViewPlan = useCallback(async () => {
    if (!planFilePath) return;
    try {
      await ideControl.navigation.goToFile(planFilePath);
    } catch (err) {
      console.error('[PlanInputCard] Failed to open plan viewer:', err);
    }
  }, [planFilePath]);

  const handleConfirmPlan = useCallback(async () => {
    if (!sessionId || !planFilePath) return;
    // Delegate to the CreatePlanDisplay card's Build button via custom event.
    // This ensures both UI paths trigger the same logic.
    window.dispatchEvent(new CustomEvent('ai00-x:plan-confirm-build', {
      detail: { sessionId, planFilePath },
    }));
  }, [sessionId, planFilePath]);

  const handleRevisePlan = useCallback(() => {
    // Fill the chat input with a revision prompt instead of a separate input box
    window.dispatchEvent(new CustomEvent('ai00-x:prefill-chat-input', {
      detail: { text: t('planCard.revisePrefill', { defaultValue: 'I want to revise this plan:' }) },
    }));
  }, [t]);

  const getStatusDisplay = () => {
    if (isArchived) {
      return <span className="plan-input-card__status plan-input-card__status--done"><CheckCircle size={14} /> {t('taskComplete.archived')}</span>;
    }
    if (!planFilePath) {
      return <span className="plan-input-card__status plan-input-card__status--idle">{t('taskShow.waitingForPlan', { defaultValue: 'Waiting for plan creation...' })}</span>;
    }
    if (isAwaiting) {
      if (autoReviewState === 'reviewing') {
        return <span className="plan-input-card__status plan-input-card__status--reviewing"><Loader2 size={14} className="spin" /> {t('taskShow.multiReviewing', { defaultValue: 'Reviewing...' })}</span>;
      }
      return <span className="plan-input-card__status plan-input-card__status--awaiting"><FileText size={14} /> {t('taskShow.awaitingConfirmation', { defaultValue: 'Awaiting Confirmation' })}</span>;
    }
    if (allDone) {
      return <span className="plan-input-card__status plan-input-card__status--done"><CheckCircle size={14} /> {t('taskShow.allCompleted', { defaultValue: 'All tasks completed' })}</span>;
    }
    if (workflowPhase === 'executing' || workflowPhase === 'reviewing') {
      return (
        <span className="plan-input-card__status plan-input-card__status--executing">
          <Loader2 size={14} className="spin" />
          {workflowPhase === 'reviewing' ? t('taskShow.reviewing', { defaultValue: 'Reviewing...' }) : t('taskShow.executing', { defaultValue: 'Executing' })}
        </span>
      );
    }
    return <span className="plan-input-card__status plan-input-card__status--idle"><FileText size={14} /> {planData?.name || 'Plan'}</span>;
  };

  const progress = totalCount > 0 ? completedCount / totalCount : 0;

  return (
    <div className="plan-input-card">
      <div className="plan-input-card__header">
        <div className="plan-input-card__info">
          {getStatusDisplay()}
          {totalCount > 0 && (
            <span className="plan-input-card__progress-text">{completedCount}/{totalCount}</span>
          )}
        </div>
        <div className="plan-input-card__actions">
          {isAwaiting ? (
            <>
              <button className="plan-input-card__btn plan-input-card__btn--confirm" onClick={handleConfirmPlan}>
                <CheckCircle size={14} />
                <span>{t('planCard.confirmAndExecute', { defaultValue: 'Confirm & Execute' })}</span>
              </button>
              <button className="plan-input-card__btn plan-input-card__btn--revise" onClick={handleRevisePlan}>
                <Pencil size={14} />
                <span>{t('planCard.revisePlan', { defaultValue: 'Revise Plan' })}</span>
              </button>
            </>
          ) : (
            planFilePath && (
              <button className="plan-input-card__btn plan-input-card__btn--view" onClick={handleViewPlan}>
                <Search size={14} />
                <span>{t('taskShow.viewPlan', { defaultValue: 'View Plan' })}</span>
                <ChevronRight size={12} />
              </button>
            )
          )}
        </div>
      </div>

      {totalCount > 0 && (
        <div className="plan-input-card__progress">
          <div className="plan-input-card__progress-track">
            <div className="plan-input-card__progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
};

export default PlanInputCard;
