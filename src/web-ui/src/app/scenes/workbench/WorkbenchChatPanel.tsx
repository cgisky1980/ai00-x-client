/**
 * WorkbenchChatPanel — 工作台窗口的固定对话区（宿主侧 UI）。
 *
 * 《工作台插件规范》§6.2 落地：
 * - 插件经总线 `workbench:active-project{projectId,title?}` 上报当前工程；
 *   宿主据此解析工程根、写入 AGENTS.local.md（system 段注入）、创建/复用
 *   绑定会话（projectId→sessionId 映射由宿主持有，插件不得自存）。
 * - 写类工具越界（审批帧到达时按 callId 反查路径参数判定）自动拒绝并在
 *   头部下方给出 path_out_of_scope 结构化提示。
 * - 写类工具成功落盘 → 总线 `workbench:project-written{projectId,paths}`
 *   回发插件（插件据此刷新预览）。
 *
 * 接线配方与 SessionChatPanel 同源（历史基线 + connectMux 实时流 →
 * foldEvents；审批/提问走 $events waterfall 应答）。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkbenchOpenSessionIntent } from '@/infrastructure/plugins/workbenchSession';
import type { WorkbenchEntry } from '@/infrastructure/plugins/workbenchRegistry';
import { useWorkbenchSession } from './useWorkbenchSession';
import { WorkbenchMessageStream } from './WorkbenchMessageStream';
import { WorkbenchComposerDock } from './WorkbenchComposerDock';
// 消息/输入区样式类复用策场景（__msg* / __composer 等 BEM 平级类）
import '../dsh/DshScene.scss';
import './WorkbenchDelegating.scss';

interface WorkbenchChatPanelProps {
  /** 当前插件工作台；纯外部会话宿主时为空（此时不建立任何工程绑定）。 */
  entry?: WorkbenchEntry;
  /** 插件页挂载失败：AI 区显示不可用状态，不建立任何会话。 */
  pluginUnavailable?: boolean;
  /**
   * 外部会话绑定（策看板「在工作台继续」投递）：优先于 `workbench:active-project`
   * 的工程绑定；只读展示 cwd，不建会话、不改 cwd。
   */
  externalSession?: WorkbenchOpenSessionIntent | null;
  /** 退出外部会话：回到当前工程的会话绑定。 */
  onExitExternalSession?: () => void;
  /**
   * 运行态上报（可选）：会话此刻是否在跑 / 是否出错。工作台默认任务场景用它
   * 把状态递给看板（看板只读，不复用 TodoOverlay 的轮询）。
   */
  onRuntimeChange?: (runtime: { running: boolean; failed: boolean; asking: boolean }) => void;
  /** 默认 panel=插件右侧栏；conversation=任务主对话区（隐藏通用头部）。 */
  variant?: 'panel' | 'conversation';
  /** 展示层把首轮内部编排任务书替换为用户的原始需求，不改引擎历史。 */
  initialRequest?: string;
  /**
   * 输入框上方是否显示工作区行（目录 + 分支）。
   * 项目工作台里项目名与分支已在头部/侧栏常驻，这里默认关掉避免重复。
   */
  showWorkspace?: boolean;
  /** 计划书（保留兼容宿主传参；进度只在中央计划卡展示）。 */
  planMd?: string | null;
  /** 任务已完成：消息流不标「进行中」。 */
  planFinished?: boolean;
  /**
   * 宿主有中央计划卡（规范 v0.23 §9.6）：exit_plan_mode 审批不在输入框出现，
   * 而是登记到 workbenchTaskStore 交给计划卡「待批准」态统一应答。
   */
  planHosted?: boolean;
  /** 计划卡上有等你动手的事（保留兼容宿主传参；输入框不再提示）。 */
  planNeedsYou?: boolean;
  /**
   * 人往会话里发了一条新消息（任务宿主用它把「待验收」退回执行段）。
   * 只在人真的提交了非空文本时触发，排队/重试也算。
   */
  onUserMessage?: () => void;
  /** 只读（已归档查看）：保留对话历史，输入框换成「取消归档」提示。 */
  readOnly?: boolean;
  /** 只读态下的恢复入口。 */
  onRestore?: () => void;
}

export const WorkbenchChatPanel: React.FC<WorkbenchChatPanelProps> = ({
  entry,
  pluginUnavailable = false,
  externalSession = null,
  onExitExternalSession,
  onRuntimeChange,
  variant = 'panel',
  initialRequest,
  showWorkspace = true,
  planFinished = false,
  planHosted = false,
  onUserMessage,
  readOnly = false,
  onRestore,
}) => {
  const { t } = useTranslation('common');

  const session = useWorkbenchSession({
    entry,
    externalSession,
    onRuntimeChange,
    initialRequest,
    planHosted,
    onUserMessage,
  });
  const { project, bound, binding, bindError, bindProject, taskRunning } = session;

  // 插件页不可用：AI 区给出明确的不可用状态，不建立会话、不显示输入框
  // （外部会话不依赖插件页：仍可对话与应答审批）
  if (pluginUnavailable && !externalSession) {
    return (
      <div className="ai00-x-workbench-chat">
        <div className="ai00-x-workbench-chat__head">
          <span className="ai00-x-workbench-chat__dot" />
          <span className="ai00-x-workbench-chat__title">{t('nav.workbenchScene.chat.title')}</span>
        </div>
        <div className="ai00-x-workbench-chat__empty" role="status">
          {t('nav.workbenchScene.chat.pluginUnavailable')}
        </div>
      </div>
    );
  }

  /** 对话区就绪：外部会话只需会话 id；工程绑定还需完成绑定且无错误。 */
  const chatReady =
    Boolean(bound) && (externalSession ? true : Boolean(project) && !binding && !bindError);

  return (
    <div
      className={`ai00-x-workbench-chat${variant === 'conversation' ? ' ai00-x-workbench-chat--conversation' : ''}`}
    >
      {variant === 'panel' && (
      <div className="ai00-x-workbench-chat__head">
        <span className={`ai00-x-workbench-chat__dot${taskRunning ? ' is-running' : ''}`} />
        <span className="ai00-x-workbench-chat__title">{t('nav.workbenchScene.chat.title')}</span>
        {externalSession ? (
          <>
            <span
              className="ai00-x-workbench-chat__project"
              title={bound?.cwd || externalSession.cwd || undefined}
            >
              {externalSession.title || externalSession.sessionId.slice(0, 8)}
            </span>
            {onExitExternalSession && (
              <button
                type="button"
                className="ai00-x-workbench-chat__exit"
                onClick={onExitExternalSession}
              >
                {t('nav.workbenchScene.chat.exitExternal')}
              </button>
            )}
          </>
        ) : (
          project && (
            <span className="ai00-x-workbench-chat__project" title={bound?.cwd}>
              {project.title || project.projectId}
            </span>
          )
        )}
      </div>
      )}

      {!externalSession && !project && (
        <div className="ai00-x-workbench-chat__empty">
          {t('nav.workbenchScene.chat.noProject')}
        </div>
      )}
      {!externalSession && project && binding && (
        <div className="ai00-x-workbench-chat__empty">
          {t('nav.workbenchScene.chat.binding')}
        </div>
      )}
      {!externalSession && project && !binding && bindError && (
        <div className="ai00-x-workbench-chat__empty">
          <p>{t('nav.workbenchScene.chat.bindFailed', { message: bindError })}</p>
          <button
            type="button"
            className="ai00-x-workbench-chat__retry"
            onClick={() => bindProject(project.projectId, project.title)}
          >
            {t('nav.workbenchScene.retry')}
          </button>
        </div>
      )}

      {chatReady && (
        <>
          <WorkbenchMessageStream
            session={session}
            entry={entry}
            planHosted={planHosted}
            planFinished={planFinished}
          />

          {readOnly ? (
            <div className="ai00-x-workbench-chat__empty" role="status">
              <p>{t('nav.workbenchWindow.tasks.archivedReadOnly')}</p>
              {onRestore && (
                <button type="button" className="ai00-x-workbench-chat__retry" onClick={onRestore}>
                  {t('nav.workbenchWindow.tasks.unarchive')}
                </button>
              )}
            </div>
          ) : (
            <WorkbenchComposerDock
              session={session}
              externalSession={externalSession}
              showWorkspace={showWorkspace}
            />
          )}
        </>
      )}
    </div>
  );
};

export default WorkbenchChatPanel;
