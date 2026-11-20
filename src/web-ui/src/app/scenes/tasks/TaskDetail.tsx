/**
 * TaskDetail — 抽屉里的任务详情 / 人类验收。
 *
 * 内容与工作台中间区的「计划首页」完全同源（`WorkbenchPlanPage`），
 * 这里只负责把交付物点击接到预览弹窗。
 */
import React, { useState } from 'react';
import { DeliverablePreview } from '@/tools/todo/components/DeliverablePreview';
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
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  return (
    <div className="ai00-x-task-detail">
      <WorkbenchPlanPage
        task={task}
        planMd={planMd}
        onPlanChange={onPlanChange}
        onOpenFile={setPreviewPath}
        running={running}
        variant="compact"
      />
      <DeliverablePreview path={previewPath} onClose={() => setPreviewPath(null)} />
    </div>
  );
};

export default TaskDetail;
