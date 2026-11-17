/**
 * WorkbenchScene — host for a plugin-provided workbench page.
 *
 * The scene id is `workbench:{id}`; the page module comes from the plugin that
 * declared `manifest.workbench` + a module `scene:page` hook. Mounting and
 * teardown go through the shared plugin runtime, so workbenches use exactly
 * the same `activate(ctx)` protocol as overlay plugins — no second protocol.
 *
 * 2026-11-07：挂载改为 loading/ready/failed 三态 —— 插件模块加载期间给占位，
 * 失败时用可重试的错误面板替换空白宿主区（重试 = 重新执行挂载，旧实例先 dispose）。
 *
 * See `client/参考/2026-11-06-工作台体系计划.md`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import { mountScenePage } from '@/infrastructure/plugins/runtime';
import { useWorkbench } from '@/infrastructure/plugins/workbenchRegistry';
import type { WorkbenchOpenSessionIntent } from '@/infrastructure/plugins/workbenchSession';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useResizablePane } from '@/hooks/useResizablePane';
import { attachPageRailResizer } from './pageRailResizer';
import { WorkbenchChatPanel } from './WorkbenchChatPanel';
import { WorkbenchTabs, type WorkbenchTabItem } from './WorkbenchTabs';
import { WorkbenchFilePreview } from './WorkbenchFilePreview';
import { activeFilePath, useWorkbenchTabs } from './useWorkbenchTabs';
import './WorkbenchScene.scss';

interface WorkbenchSceneProps {
  /** 插件工作台 id；为空时只承载外部会话（策看板移交的会话）。 */
  workbenchId?: string | null;
  /** 右侧 AI 区是否显示（宿主工具栏控制；窄窗口下为浮层）。 */
  chatVisible?: boolean;
  /** 外部会话绑定（优先于插件页的工程绑定）。 */
  externalSession?: WorkbenchOpenSessionIntent | null;
  onExitExternalSession?: () => void;
}

type MountStatus = 'loading' | 'ready' | 'failed';

export function WorkbenchScene({
  workbenchId = null,
  chatVisible = true,
  externalSession = null,
  onExitExternalSession,
}: WorkbenchSceneProps) {
  const { t } = useI18n('common');
  const entry = useWorkbench(workbenchId);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<MountStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  /** AI 对话栏宽度：可拖拽（300–640，默认 360），记忆到 localStorage。 */
  const chat = useResizablePane({
    storageKey: 'workbench.chatWidth',
    defaultWidth: 360,
    min: 300,
    max: 640,
    edge: 'left',
    label: t('nav.workbenchWindow.resizeChat'),
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!entry || !host) return undefined;

    let disposed = false;
    let handle: { dispose: () => void } | null = null;
    setStatus('loading');

    void mountScenePage(
      entry.pluginId,
      entry.modulePath,
      entry.installedAt,
      host,
    ).then((mounted) => {
      if (disposed) {
        mounted.dispose();
        return;
      }
      handle = mounted;
      setStatus(mounted.failed ? 'failed' : 'ready');
    }).catch(() => {
      if (!disposed) setStatus('failed');
    });

    return () => {
      disposed = true;
      handle?.dispose();
    };
  }, [entry, attempt]);

  const retry = useCallback((): void => {
    setAttempt(n => n + 1);
  }, []);

  // 插件页左侧项目栏宽度：宿主统一接管拖拽（插件不需要自己实现）
  useEffect(() => {
    const host = hostRef.current;
    if (!entry || !host || status !== 'ready') return undefined;
    return attachPageRailResizer({
      host,
      storageKey: `workbench.pageRailWidth.${entry.id}`,
      label: t('nav.workbenchWindow.resizePageRail'),
    });
  }, [entry, status, t]);

  /** AI 区承载条件：外部会话，或插件声明了会话绑定。 */
  const showChat = Boolean(externalSession) || Boolean(entry?.bindsSession);

  // ---- 中间标签区：首页=插件页（不可关闭），其余=文件预览 ----
  const tabs = useWorkbenchTabs(entry?.id ?? 'external-session');
  const currentPath = activeFilePath(tabs.activeKey);
  const tabItems = useMemo<WorkbenchTabItem[]>(
    () => [
      {
        key: 'home',
        kind: 'home',
        title: entry?.title ?? t('nav.workbenchScene.externalTitle'),
        icon: <LayoutGrid size={13} />,
      },
      ...tabs.fileTabs.map((tab) => ({
        key: tab.key,
        kind: 'file' as const,
        title: tab.title,
        tooltip: tab.path,
        icon: <LayoutGrid size={13} />,
      })),
    ],
    [entry?.title, tabs.fileTabs, t],
  );

  const pickFile = useCallback((): void => {
    void import('@tauri-apps/plugin-dialog').then(({ open }) =>
      open({
        multiple: false,
        directory: false,
        title: t('nav.workbenchWindow.tabs.pickFile'),
      }).then((picked) => {
        if (typeof picked === 'string') tabs.openFile(picked);
      }),
    );
  }, [tabs, t]);

  if (!entry && !externalSession) {
    return (
      <div className="ai00-x-workbench-scene">
        <div className="ai00-x-workbench-scene__empty">
          {t('nav.workbenchScene.notInstalled', { id: workbenchId ?? '' })}
        </div>
      </div>
    );
  }

  return (
    <div className="ai00-x-workbench-scene" data-workbench-id={entry?.id ?? 'external-session'}>
      <div
        className={`ai00-x-workbench-scene__body${showChat && chatVisible ? ' is-chat-visible' : ''}`}
        style={{ '--workbench-chat-width': `${chat.width}px` } as React.CSSProperties}
      >
        <div className="ai00-x-workbench-scene__main">
          <WorkbenchTabs
            tabs={tabItems}
            activeKey={tabs.activeKey}
            onChange={tabs.setActiveKey}
            onClose={tabs.closeTab}
            onPickFile={pickFile}
          >
            {/* 插件宿主保持挂载：切到文件标签只是隐藏，不卸载插件实例 */}
            <div
              className={`ai00-x-workbench-scene__home${currentPath ? ' is-hidden' : ''}`}
            >
              {entry ? (
                <>
                  <div className="ai00-x-workbench-scene__host" ref={hostRef} />
                  {status === 'loading' && (
                    <div className="ai00-x-workbench-scene__loading" role="status" aria-live="polite">
                      <span className="ai00-x-workbench-scene__loading-bar" aria-hidden="true" />
                      <span className="ai00-x-workbench-scene__loading-bar" aria-hidden="true" />
                      <span className="ai00-x-workbench-scene__loading-bar" aria-hidden="true" />
                      <p>{t('nav.workbenchScene.loading', { title: entry.title })}</p>
                    </div>
                  )}
                  {status === 'failed' && (
                    <div className="ai00-x-workbench-scene__error" role="alert">
                      <p className="ai00-x-workbench-scene__error-title">
                        {t('nav.workbenchScene.loadFailed', { title: entry.title })}
                      </p>
                      <p className="ai00-x-workbench-scene__error-hint">
                        {t('nav.workbenchScene.loadFailedHint')}
                      </p>
                      <button type="button" className="ai00-x-workbench-scene__error-retry" onClick={retry}>
                        {t('nav.workbenchScene.retry')}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="ai00-x-workbench-scene__external">
                  <p className="ai00-x-workbench-scene__external-title">
                    {t('nav.workbenchScene.externalTitle')}
                  </p>
                  <p className="ai00-x-workbench-scene__external-hint">
                    {t('nav.workbenchScene.externalHint')}
                  </p>
                  {externalSession?.cwd && (
                    <p className="ai00-x-workbench-scene__external-cwd">
                      <span>{t('nav.workbenchScene.externalCwd')}</span>
                      <code>{externalSession.cwd}</code>
                    </p>
                  )}
                </div>
              )}
            </div>
            {currentPath && <WorkbenchFilePreview path={currentPath} />}
          </WorkbenchTabs>
        </div>
        {showChat && chatVisible && (
          <>
            <div
              className={`ai00-x-workbench-scene__chat-resizer${chat.dragging ? ' is-dragging' : ''}`}
              {...chat.handleProps}
            />
            <WorkbenchChatPanel
              entry={entry}
              pluginUnavailable={Boolean(entry) && status === 'failed'}
              externalSession={externalSession}
              {...(onExitExternalSession ? { onExitExternalSession } : {})}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default WorkbenchScene;
