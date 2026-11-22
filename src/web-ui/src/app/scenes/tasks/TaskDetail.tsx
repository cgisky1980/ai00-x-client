/**
 * TaskDetail — 抽屉里的任务详情 / 人类验收。
 *
 * 内容与工作台中间区的「计划首页」完全同源（`WorkbenchPlanPage`），
 * 这里只负责把交付物点击接到预览弹窗。
 */
import React, { useState } from 'react';
import { DeliverablePreview } from '@/tools/todo/components/DeliverablePreview';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { TodoTask } from '@/tools/todo/api/types';
import { WorkbenchPlanPage } from '../workbench/WorkbenchPlanPage';

export interface TaskDetailProps {
  task: TodoTask;
  planMd: string | null;
  onPlanChange: (taskId: string, markdown: string) => void;
  /** 会话正在运行（步骤状态显示「进行中」）。 */
  running?: boolean;
}

export const TaskDetail: React.FC<TaskDetailProps> = ({
  task,
  planMd,
  onPlanChange,
  running = false,
}) => {
  const { t } = useI18n('common');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  return (
    <div className="ai00-x-task-detail">
      {task.executionMode === 'quick' ? (
        // 快速问答没有计划/交付物/验收这条流水线，套计划页只会显示「尚无计划书」误导人。
        <p className="ai00-x-task-detail__quick">{t('nav.workbenchWindow.board.quickNoPlan')}</p>
      ) : (
        <>
          {/* 还没有计划（agent 建的想法卡 / 刚建卡）：把原始请求摆出来，
              否则详情只剩一个空计划页，人看不出这张卡要做什么。 */}
          {!planMd?.trim() && task.notes?.trim() ? (
            <section className="ai00-x-task-detail__request">
              <h3>{t('nav.workbenchWindow.tasks.requestLabel')}</h3>
              <p>{task.notes}</p>
            </section>
          ) : null}
          <WorkbenchPlanPage
            task={task}
            planMd={planMd}
            onPlanChange={onPlanChange}
            onOpenFile={setPreviewPath}
            running={running}
            variant="compact"
          />
        </>
      )}
      <DeliverablePreview path={previewPath} onClose={() => setPreviewPath(null)} />
    </div>
  );
};

export default TaskDetail;
