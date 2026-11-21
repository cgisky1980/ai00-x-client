/**
 * WorkbenchTaskHost — 任务会话的「中（计划卡 / 文件标签）+ 右（常驻对话）」宿主。
 *
 * 任务场景与项目场景共用这一份接线（规范 §9.7）：标签区、计划卡、对话面板、
 * 运行态上报、阶段判定全部只在这里写一次。左侧列表由各场景自己渲染。
 * 快速问答没有中央区：对话独占主区。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { FileText } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useResizablePane } from '@/hooks/useResizablePane';
import type { TodoTask } from '@/tools/todo/api/types';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import { taskPhase } from '../tasks/taskPhase';
import { useWorkbenchTaskStore } from '../tasks/workbenchTaskStore';
import { WorkbenchChatPanel } from './WorkbenchChatPanel';
import { WorkbenchFilePreview } from './WorkbenchFilePreview';
import { WorkbenchPlanPage } from './WorkbenchPlanPage';
import { WorkbenchStatusTag } from './WorkbenchStageBar';
import { WorkbenchTabs, type WorkbenchTabItem } from './WorkbenchTabs';
import { activeFilePath, HOME_TAB_KEY, useWorkbenchTabs } from './useWorkbenchTabs';
import { needsYou } from './workbenchStage';
import './WorkbenchTaskHost.scss';

export interface WorkbenchTaskHostProps {
  task: TodoTask;
  sessionId: string;
  /** 会话工作目录（项目任务 = 项目目录；默认工作区可省略）。 */
  cwd?: string;
  planMd: string | null;
  onPlanChange: (taskId: string, markdown: string) => void;
  /** 计划页标题行左侧（返回键 / 任务名 / 项目名）；状态标签由宿主追加。 */
  title: React.ReactNode;
  /** 对话列顶部的错误条（场景级错误）。 */
  error?: string | null;
}

export const WorkbenchTaskHost: React.FC<WorkbenchTaskHostProps> = ({
  task,
  sessionId,
  cwd,
  planMd,
  onPlanChange,
  title,
  error,
}) => {
  const { t } = useI18n('common');
  const runtime = useWorkbenchTaskStore((s) => s.runtime[sessionId]);
  const reportRuntime = useWorkbenchTaskStore((s) => s.reportRuntime);
  const updateTask = useTodoStore((s) => s.updateTask);
  const quick = task.executionMode === 'quick';
  const phase = taskPhase(task, planMd, runtime);
  const running = Boolean(runtime?.running);
  /** 已归档 = 只读查看：计划卡不给批准/验收/编辑，输入框换成「恢复任务」。 */
  const archived = Boolean(task.archivedAt);
  const restoreTask = useCallback((): void => {
    updateTask(task.id, { archivedAt: null });
  }, [task.id, updateTask]);

  /**
   * 待验收时人在对话里追加要求 = 还有活要干：自检结论立即作废，任务退回执行段。
   * 不清的话卡片会一直挂着「待验收」的验收按钮，而 agent 其实已经在改文件了。
   */
  const handleUserMessage = useCallback((): void => {
    if (task.agentCompletedAt) updateTask(task.id, { agentCompletedAt: null });
  }, [task.agentCompletedAt, task.id, updateTask]);

  const tabs = useWorkbenchTabs(task.id);
  const currentPath = activeFilePath(tabs.activeKey);

  /**
   * 进入「需要你」时把中区落回计划页：批准与验收只在计划卡上，若上次停在某个
   * 交付物标签，人点进任务会找不到唯一的推进入口。只在「刚进入该阶段」触发一次——
   * 之后人自己点交付物查看不会被拽回来。
   */
  const landedRef = useRef<string | null>(null);
  useEffect(() => {
    if (quick) return;
    const key = `${task.id}:${phase}`;
    if (needsYou(phase)) {
      if (landedRef.current !== key) {
        landedRef.current = key;
        tabs.setActiveKey(HOME_TAB_KEY);
      }
      return;
    }
    landedRef.current = null;
  }, [quick, task.id, phase, tabs]);

  const tabItems = useMemo<WorkbenchTabItem[]>(
    () => [
      {
        key: 'home',
        kind: 'home' as const,
        title: t('nav.workbenchWindow.tabs.plan'),
        icon: <FileText size={13} />,
      },
      ...tabs.fileTabs.map((tab) => ({
        key: tab.key,
        kind: 'file' as const,
        title: tab.title,
        tooltip: tab.path,
        icon: <FileText size={13} />,
      })),
    ],
    [tabs.fileTabs, t],
  );

  /** 对话区宽度（所有工作台共用记忆键）。 */
  const chat = useResizablePane({
    storageKey: 'workbench.chatWidth',
    defaultWidth: 380,
    min: 300,
    max: 640,
    edge: 'left',
    label: t('nav.workbenchWindow.resizeChat'),
  });

  const pickFile = useCallback((): void => {
    void import('@tauri-apps/plugin-dialog').then(({ open }) =>
      open({ multiple: false, directory: false, title: t('nav.workbenchWindow.tabs.pickFile') }).then(
        (picked) => {
          if (typeof picked === 'string') tabs.openFile(picked);
        },
      ),
    );
  }, [tabs, t]);

  return (
    <div className={`ai00-x-task-host${quick ? ' is-quick' : ''}`}>
      {!quick && (
        <div className="ai00-x-task-host__stage">
          <WorkbenchTabs
            tabs={tabItems}
            activeKey={tabs.activeKey}
            onChange={tabs.setActiveKey}
            onClose={tabs.closeTab}
            onPickFile={pickFile}
          >
            {currentPath ? (
              <WorkbenchFilePreview path={currentPath} />
            ) : (
              <WorkbenchPlanPage
                task={task}
                planMd={planMd}
                onPlanChange={onPlanChange}
                onOpenFile={tabs.openFile}
                running={running}
                readOnly={archived}
                header={
                  <>
                    {title}
                    <WorkbenchStatusTag
                      className="ai00-x-task-host__status"
                      phase={phase}
                      asking={Boolean(runtime?.asking)}
                    />
                  </>
                }
              />
            )}
          </WorkbenchTabs>
        </div>
      )}
      {!quick && (
        <div
          className={`ai00-x-task-host__chat-resizer${chat.dragging ? ' is-dragging' : ''}`}
          {...chat.handleProps}
        />
      )}
      <div
        className={`ai00-x-task-host__chat${quick ? ' is-full' : ''}`}
        {...(quick ? {} : { style: { width: `${chat.width}px` } })}
      >
        {error && (
          <p className="ai00-x-task-host__error" role="alert">
            {error}
          </p>
        )}
        <WorkbenchChatPanel
          key={sessionId}
          variant="conversation"
          showWorkspace={false}
          initialRequest={task.notes || task.title}
          externalSession={{ sessionId, ...(cwd ? { cwd } : {}), title: task.title }}
          onRuntimeChange={(state) => reportRuntime(sessionId, state)}
          onUserMessage={handleUserMessage}
          readOnly={archived}
          onRestore={restoreTask}
          // 快速问答没有计划：相关 props 一律不传（状态卡 / 计划卡托管都不会出现）
          {...(quick
            ? {}
            : {
                planMd,
                planFinished: Boolean(task.completedAt),
                planHosted: true,
                planNeedsYou: needsYou(phase),
              })}
        />
      </div>
    </div>
  );
};

export default WorkbenchTaskHost;
