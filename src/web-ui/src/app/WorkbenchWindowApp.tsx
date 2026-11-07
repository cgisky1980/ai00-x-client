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
import { House, LayoutGrid, PanelRight, PanelRightClose, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useWorkbenches } from '@/infrastructure/plugins/workbenchRegistry';
import WorkbenchHome from './WorkbenchHome';
import WorkbenchScene from './scenes/workbench/WorkbenchScene';
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
      return stored || null;
    } catch {
      return null;
    }
  });
  const [railCollapsed, setRailCollapsed] = useState(() => readFlag(RAIL_KEY, false));
  const [chatVisible, setChatVisible] = useState(() => readFlag(CHAT_KEY, true));
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches,
  );

  const activeEntry = activeId ? workbenches.find(w => w.id === activeId) : undefined;

  // 打开中的工作台被卸载/禁用 → 回首页。
  // 注意：registry 首帧是空数组，此时不能判定「已卸载」，否则重启恢复会被
  // 立刻清掉（只有列表真正加载出条目后才做失效判定）。
  useEffect(() => {
    if (activeId && workbenches.length > 0 && !workbenches.some(w => w.id === activeId)) {
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
            className={`ai00-x-workbench-window__item${!activeEntry ? ' is-active' : ''}`}
            aria-current={!activeEntry ? 'page' : undefined}
            title={t('nav.workbenchWindow.home.railHome')}
            onClick={() => setActiveId(null)}
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
        {activeEntry ? (
          <>
            <WorkbenchScene workbenchId={activeEntry.id} chatVisible={chatVisible} />
            {activeEntry.bindsSession && (
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
          </>
        ) : (
          <WorkbenchHome workbenches={workbenches} onOpen={setActiveId} />
        )}
      </main>
    </div>
  );
};

export default WorkbenchWindowApp;
