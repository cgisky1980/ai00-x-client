/**
 * WorkbenchWindowApp — 「工作台」独立窗口根组件（窗口 label = workbench）。
 *
 * 结构：左侧固定侧边栏（首页入口 + 已安装工作台列表，来源 = workbenchRegistry，
 * 随 `plugins-changed` 实时增删）；右侧主区默认首页（WorkbenchHome：市场/收藏/
 * 已安装页签 + 卡片网格），点侧栏条目或首页卡片进入对应工作台页
 * （WorkbenchScene 挂载插件 scene:page）。
 *
 * 2026-11-07 响应式：外框导航可折叠为图标栏、右侧 AI 区可显隐且窄窗口下转为
 * 浮层抽屉；两项偏好写入 localStorage，重启恢复。窄窗口保留左栏，不靠隐藏
 * 导航换取空间。
 *
 * 刻意不做「工作台自己的数据落盘」：数据由插件通过 `ctx.storage`
 * （plugin_data_* 命令）自持，窗口只是宿主。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, FolderKanban, House, LayoutGrid, MessageSquare, PanelRight, PanelRightClose, PanelLeftClose, PanelLeftOpen, SquareKanban } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useWorkbenches } from '@/infrastructure/plugins/workbenchRegistry';
import {
  WORKBENCH_FOCUS_TASK,
  WORKBENCH_OPEN_SESSION,
  type WorkbenchFocusTaskIntent,
  type WorkbenchOpenSessionIntent,
} from '@/infrastructure/plugins/workbenchSession';
import {
  subscribeWindowMessage,
  takePendingIntents,
} from '@/infrastructure/windows/windowBus';
import WorkbenchHome from './WorkbenchHome';
import WorkbenchScene from './scenes/workbench/WorkbenchScene';
import TaskScene from './scenes/tasks/TaskScene';
import TaskBoardScene, { BOARD_SCENE_ID } from './scenes/tasks/TaskBoardScene';
import { TASKS_SCENE_ID } from './scenes/tasks/taskSession';
import ProjectsScene, { PROJECTS_SCENE_ID } from './scenes/projects/ProjectsScene';
import AutomationsScene, { AUTOMATIONS_SCENE_ID } from './scenes/automations/AutomationsScene';
import { initTodoWindowSync } from '@/tools/todo/sync/todoWindowSync';
import './WorkbenchWindowApp.scss';

/** 窄窗口断点：低于它 AI 区以浮层形式出现（与样式表保持一致）。 */
const NARROW_QUERY = '(max-width: 980px)';

const RAIL_KEY = 'workbench.railCollapsed';
const CHAT_KEY = 'workbench.chatVisible';

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // 存储不可用（隐私模式等）时只是不记忆，不影响使用
  }
}

const WorkbenchWindowApp: React.FC = () => {
  const { t } = useI18n('common');
  const workbenches = useWorkbenches();
  // null = 首页；否则为打开的工作台 id
  const [activeId, setActiveId] = useState<string | null>(() => {
    try {
      const stored = window.localStorage.getItem('workbench.activeId');
      return stored || TASKS_SCENE_ID;
    } catch {
      return TASKS_SCENE_ID;
    }
  });
  const [railCollapsed, setRailCollapsed] = useState(() => readFlag(RAIL_KEY, false));
  const [chatVisible, setChatVisible] = useState(() => readFlag(CHAT_KEY, true));
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches,
  );
  /** 策看板移交的外部会话（P1）：优先于插件页的工程绑定。 */
  const [externalSession, setExternalSession] = useState<WorkbenchOpenSessionIntent | null>(null);
  /** 看板 →「任务」场景的任务交接（场景内 state，不走 windowBus）。 */
  const [taskFocus, setTaskFocus] = useState<string | null>(null);

  /** 接收外部会话：直接展开 AI 区，不建会话、不改 cwd。 */
  const applyExternalSession = useCallback((intent: WorkbenchOpenSessionIntent | null): void => {
    if (!intent?.sessionId) return;
    // 即时广播路径也要清掉排队意图，否则本窗口关闭后在 TTL 内重开会被同一条复活
    takePendingIntents<WorkbenchOpenSessionIntent>(WORKBENCH_OPEN_SESSION);
    setExternalSession(intent);
    setChatVisible(true);
    writeFlag(CHAT_KEY, true);
  }, []);

  /**
   * 外部会话入口（策 → 工作台）：
   * 窗口未开时策侧已落成待处理意图（`queueWindowIntent`），启动时取走；
   * 窗口已开时走总线广播即时到达。两种时序收敛到同一个 apply。
   */
  useEffect(() => {
    const pending = takePendingIntents<WorkbenchOpenSessionIntent>(WORKBENCH_OPEN_SESSION);
    if (pending[0]) applyExternalSession(pending[0]);
    return subscribeWindowMessage((message) => {
      if (message.type !== WORKBENCH_OPEN_SESSION) return;
      applyExternalSession((message.payload as WorkbenchOpenSessionIntent | undefined) ?? null);
    });
  }, [applyExternalSession]);

  const exitExternalSession = useCallback((): void => setExternalSession(null), []);

  /**
   * 「需要你」通知的入口（overlay → 本窗口）：切到任务场景并定位到那张卡。
   * 与外部会话一样双时序收敛：启动时取 pending，之后走广播。
   * 顺手清掉 pending，避免本窗口关闭后在 TTL 内重开被同一条再次定位。
   */
  useEffect(() => {
    const applyFocus = (taskId: string | undefined): void => {
      if (!taskId) return;
      setExternalSession(null);
      setTaskFocus(taskId);
      setActiveId(TASKS_SCENE_ID);
    };
    const pending = takePendingIntents<WorkbenchFocusTaskIntent>(WORKBENCH_FOCUS_TASK);
    if (pending[0]?.taskId) applyFocus(pending[0].taskId);
    return subscribeWindowMessage((message) => {
      if (message.type !== WORKBENCH_FOCUS_TASK) return;
      applyFocus((message.payload as WorkbenchFocusTaskIntent | undefined)?.taskId);
      takePendingIntents<WorkbenchFocusTaskIntent>(WORKBENCH_FOCUS_TASK);
    });
  }, []);

  // 工作台窗口持有工作台任务（看板/任务场景）：订阅策的跨窗口数据广播，
  // 别处（如插件工作台会话补登的任务卡、设置窗口）写入后这里能即时对齐。
  useEffect(() => initTodoWindowSync('ui'), []);

  // 启动即校准 Ai00-API 引用：上游下架/改名后，配置里残留的
  // `ai00s:<旧模型>` 会被自动换成可用模型（fetchAi00sModels 内部自愈）。
  useEffect(() => {
    void import('@/infrastructure/config/services/ai00sTier')
      .then(({ fetchAi00sModels }) => fetchAi00sModels())
      .catch(() => undefined);
  }, []);

  const activeEntry = activeId ? workbenches.find(w => w.id === activeId) : undefined;

  // 打开中的工作台被卸载/禁用 → 回首页。
  // 注意：registry 首帧是空数组，此时不能判定「已卸载」，否则重启恢复会被
  // 立刻清掉（只有列表真正加载出条目后才做失效判定）。内置场景（`@` 前缀）
  // 不属于插件列表，跳过判定。
  useEffect(() => {
    if (
      activeId &&
      !activeId.startsWith('@') &&
      workbenches.length > 0 &&
      !workbenches.some(w => w.id === activeId)
    ) {
      setActiveId(null);
    }
  }, [activeId, workbenches]);

  useEffect(() => {
    try {
      if (activeId) window.localStorage.setItem('workbench.activeId', activeId);
      else window.localStorage.removeItem('workbench.activeId');
    } catch {
      // 忽略：不记忆不影响功能
    }
  }, [activeId]);

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (e: MediaQueryListEvent): void => setNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggleRail = useCallback((): void => {
    setRailCollapsed(prev => {
      writeFlag(RAIL_KEY, !prev);
      return !prev;
    });
  }, []);

  const toggleChat = useCallback((): void => {
    setChatVisible(prev => {
      writeFlag(CHAT_KEY, !prev);
      return !prev;
    });
  }, []);

  // 窄窗口下浮层打开时 Esc 关闭
  useEffect(() => {
    if (!narrow || !chatVisible || !activeEntry) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setChatVisible(false);
        writeFlag(CHAT_KEY, false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow, chatVisible, activeEntry]);

  return (
    <div
      className={`ai00-x-workbench-window${railCollapsed ? ' is-rail-collapsed' : ''}${
        activeEntry && chatVisible ? ' is-chat-visible' : ''
      }`}
    >
      <aside className="ai00-x-workbench-window__rail">
        <div className="ai00-x-workbench-window__rail-head">
          <span className="ai00-x-workbench-window__rail-title">
            {t('nav.sections.workbench')}
          </span>
          <button
            type="button"
            className="ai00-x-workbench-window__rail-toggle"
            onClick={toggleRail}
            aria-label={
              railCollapsed
                ? t('nav.workbenchWindow.expandRail')
                : t('nav.workbenchWindow.collapseRail')
            }
            title={
              railCollapsed
                ? t('nav.workbenchWindow.expandRail')
                : t('nav.workbenchWindow.collapseRail')
            }
          >
            {railCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>
        </div>
        <div className="ai00-x-workbench-window__items">
          <button
            type="button"
            className={`ai00-x-workbench-window__item${activeId === PROJECTS_SCENE_ID ? ' is-active' : ''}`}
            aria-current={activeId === PROJECTS_SCENE_ID ? 'page' : undefined}
            title={t('nav.workbenchWindow.projects.title')}
            onClick={() => {
              setActiveId(PROJECTS_SCENE_ID);
              setExternalSession(null);
            }}
          >
            <span className="ai00-x-workbench-window__item-icon" aria-hidden="true">
              <FolderKanban size={15} />
            </span>
            <span className="ai00-x-workbench-window__item-label">
              {t('nav.workbenchWindow.projects.rail')}
            </span>
          </button>
          <button
            type="button"
            className={`ai00-x-workbench-window__item${activeId === TASKS_SCENE_ID ? ' is-active' : ''}`}
            aria-current={activeId === TASKS_SCENE_ID ? 'page' : undefined}
            title={t('nav.workbenchWindow.tasks.title')}
            onClick={() => {
              setActiveId(TASKS_SCENE_ID);
              setExternalSession(null);
            }}
          >
            <span className="ai00-x-workbench-window__item-icon" aria-hidden="true">
              <MessageSquare size={15} />
            </span>
            <span className="ai00-x-workbench-window__item-label">
              {t('nav.workbenchWindow.tasks.rail')}
            </span>
          </button>
          <button
            type="button"
            className={`ai00-x-workbench-window__item${activeId === AUTOMATIONS_SCENE_ID ? ' is-active' : ''}`}
            aria-current={activeId === AUTOMATIONS_SCENE_ID ? 'page' : undefined}
            title={t('nav.workbenchWindow.automations.title')}
            onClick={() => {
              setActiveId(AUTOMATIONS_SCENE_ID);
              setExternalSession(null);
            }}
          >
            <span className="ai00-x-workbench-window__item-icon" aria-hidden="true">
              <CalendarClock size={15} />
            </span>
            <span className="ai00-x-workbench-window__item-label">
              {t('nav.workbenchWindow.automations.rail')}
            </span>
          </button>
          <button
            type="button"
            className={`ai00-x-workbench-window__item${activeId === BOARD_SCENE_ID ? ' is-active' : ''}`}
            aria-current={activeId === BOARD_SCENE_ID ? 'page' : undefined}
            title={t('nav.workbenchWindow.board.title')}
            onClick={() => {
              setActiveId(BOARD_SCENE_ID);
              setExternalSession(null);
            }}
          >
            <span className="ai00-x-workbench-window__item-icon" aria-hidden="true">
              <SquareKanban size={15} />
            </span>
            <span className="ai00-x-workbench-window__item-label">
              {t('nav.workbenchWindow.board.rail')}
            </span>
          </button>
          <button
            type="button"
            className={`ai00-x-workbench-window__item${!activeId ? ' is-active' : ''}`}
            aria-current={!activeId ? 'page' : undefined}
            title={t('nav.workbenchWindow.home.railHome')}
            onClick={() => {
              setActiveId(null);
              setExternalSession(null);
            }}
          >
            <span className="ai00-x-workbench-window__item-icon" aria-hidden="true">
              <House size={15} />
            </span>
            <span className="ai00-x-workbench-window__item-label">
              {t('nav.workbenchWindow.home.railHome')}
            </span>
          </button>
          {workbenches.map(workbench => {
            const isActive = workbench.id === activeEntry?.id;
            return (
              <button
                key={workbench.id}
                type="button"
                className={`ai00-x-workbench-window__item${isActive ? ' is-active' : ''}`}
                title={workbench.title}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => setActiveId(workbench.id)}
              >
                <span className="ai00-x-workbench-window__item-icon" aria-hidden="true">
                  <LayoutGrid size={15} />
                </span>
                <span className="ai00-x-workbench-window__item-label">{workbench.title}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="ai00-x-workbench-window__stage">
        {activeId === PROJECTS_SCENE_ID ? (
          <ProjectsScene />
        ) : activeId === AUTOMATIONS_SCENE_ID ? (
          <AutomationsScene />
        ) : activeId === TASKS_SCENE_ID ? (
          <TaskScene
            focusTaskId={taskFocus}
            onFocusHandled={() => setTaskFocus(null)}
          />
        ) : activeId === BOARD_SCENE_ID ? (
          <TaskBoardScene
            onOpenTask={(taskId) => {
              setTaskFocus(taskId);
              setActiveId(TASKS_SCENE_ID);
            }}
          />
        ) : activeEntry ? (
          <WorkbenchScene
            workbenchId={activeEntry.id}
            chatVisible={chatVisible}
            externalSession={externalSession}
            onExitExternalSession={exitExternalSession}
          />
        ) : externalSession ? (
          <WorkbenchScene
            chatVisible={chatVisible}
            externalSession={externalSession}
            onExitExternalSession={exitExternalSession}
          />
        ) : (
          <WorkbenchHome workbenches={workbenches} onOpen={setActiveId} />
        )}
        {activeId !== TASKS_SCENE_ID &&
          activeId !== BOARD_SCENE_ID &&
          activeId !== PROJECTS_SCENE_ID &&
          activeId !== AUTOMATIONS_SCENE_ID &&
          (Boolean(externalSession) || Boolean(activeEntry?.bindsSession)) && (
          <button
            type="button"
            className={`ai00-x-workbench-window__chat-toggle${chatVisible ? ' is-on' : ''}`}
            onClick={toggleChat}
            aria-pressed={chatVisible}
            aria-label={
              chatVisible
                ? t('nav.workbenchWindow.hideChat')
                : t('nav.workbenchWindow.showChat')
            }
            title={
              chatVisible
                ? t('nav.workbenchWindow.hideChat')
                : t('nav.workbenchWindow.showChat')
            }
          >
            {chatVisible ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
          </button>
        )}
      </main>
    </div>
  );
};

export default WorkbenchWindowApp;
