import React, { useCallback } from 'react';
import { Loader2, CheckCircle, FileText, ChevronRight } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { ideControl } from '@/shared/services/ide-control/api';
import './TaskShow.scss';

interface TaskShowProps {
  sessionId: string;
  workflowPhase?: 'planning' | 'awaiting_plan_confirmation' | 'executing' | 'reviewing';
  planFilePath?: string | null;
  planName?: string;
  isAwaiting?: boolean;
  autoReviewState?: 'idle' | 'reviewing' | 'completed';
  lastReviewSummary?: string | null;
  completedCount?: number;
  totalCount?: number;
}

type PhaseColor = 'blue' | 'purple' | 'yellow' | 'green';

function isAllDone(completedCount?: number, totalCount?: number): boolean {
  return totalCount != null && totalCount > 0 && completedCount === totalCount;
}

function getPhaseConfig(
  workflowPhase: TaskShowProps['workflowPhase'],
  autoReviewState: TaskShowProps['autoReviewState'],
  completedCount?: number,
  totalCount?: number,
): { color: PhaseColor; icon: React.ReactNode; label: string; clickable: boolean } | null {
  switch (workflowPhase) {
    case 'planning':
      if (autoReviewState === 'reviewing') {
        return {
          color: 'yellow',
          icon: <Loader2 size={14} className="task-show__spin" />,
          label: 'taskShow.multiReviewing',
          clickable: false,
        };
      }
      if (autoReviewState === 'completed') {
        return {
          color: 'green',
          icon: <CheckCircle size={14} />,
          label: 'taskShow.reviewCompleted',
          clickable: false,
        };
      }
      return {
        color: 'purple',
        icon: <Loader2 size={14} className="task-show__spin" />,
        label: 'taskShow.planning',
        clickable: false,
      };
    case 'awaiting_plan_confirmation':
      if (autoReviewState === 'completed') {
        return {
          color: 'green',
          icon: <FileText size={14} />,
          label: 'taskShow.reviewCompleted',
          clickable: true,
        };
      }
      return {
        color: 'yellow',
        icon: <FileText size={14} />,
        label: 'taskShow.awaitingConfirmation',
        clickable: true,
      };
    case 'executing':
      if (isAllDone(completedCount, totalCount)) {
        return {
          color: 'green',
          icon: <CheckCircle size={14} />,
          label: 'taskShow.allCompleted',
          clickable: true,
        };
      }
      return {
        color: 'blue',
        icon: <FileText size={14} />,
        label: 'taskShow.executing',
        clickable: true,
      };
    case 'reviewing':
      if (isAllDone(completedCount, totalCount)) {
        return {
          color: 'green',
          icon: <CheckCircle size={14} />,
          label: 'taskShow.allCompleted',
          clickable: true,
        };
      }
      return {
        color: 'yellow',
        icon: <FileText size={14} />,
        label: 'taskShow.reviewing',
        clickable: true,
      };
    default:
      if (isAllDone(completedCount, totalCount)) {
        return {
          color: 'green',
          icon: <CheckCircle size={14} />,
          label: 'taskShow.allCompleted',
          clickable: true,
        };
      }
      return null;
  }
}

export const TaskShow: React.FC<TaskShowProps> = ({
  workflowPhase,
  planFilePath,
  planName,
  autoReviewState,
  completedCount,
  totalCount,
}) => {
  const { t } = useI18n('flow-chat');

  const handleViewPlan = useCallback(async () => {
    if (!planFilePath) return;
    try {
      await ideControl.navigation.goToFile(planFilePath);
    } catch (err) {
      console.error('[TaskShow] Failed to open plan viewer:', err);
    }
  }, [planFilePath]);

  const config = getPhaseConfig(workflowPhase, autoReviewState, completedCount, totalCount);
  if (!config) return null;

  const allDone = isAllDone(completedCount, totalCount);
  const showProgress = totalCount != null && totalCount > 0
    && (workflowPhase === 'executing' || allDone);
  const progressVal = showProgress && completedCount != null ? completedCount / totalCount : 0;

  return (
    <div
      className={`task-show task-show--${config.color}${config.clickable ? ' task-show--clickable' : ''}`}
      onClick={config.clickable ? handleViewPlan : undefined}
      role={config.clickable ? 'button' : undefined}
      tabIndex={config.clickable ? 0 : undefined}
    >
      <div className="task-show__content">
        <span className="task-show__icon">{config.icon}</span>
        {planName && config.clickable && (
          <span className="task-show__name">{planName}</span>
        )}
        <span className="task-show__label">{t(config.label)}</span>
        {showProgress && (
          <>
            <span className="task-show__count">
              {completedCount}/{totalCount}
            </span>
            <div className="task-show__progress-track">
              <div
                className="task-show__progress-fill"
                style={{ width: `${progressVal * 100}%` }}
              />
            </div>
          </>
        )}
        {config.clickable && (
          <span className="task-show__action">
            {t('taskShow.viewPlan')}
            <ChevronRight size={12} />
          </span>
        )}
      </div>
    </div>
  );
};
