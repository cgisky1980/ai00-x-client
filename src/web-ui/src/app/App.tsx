import { useEffect, useRef } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { ChatProvider } from '../infrastructure';
import { ViewModeProvider } from '../infrastructure/contexts/ViewModeProvider';
import { SSHRemoteProvider } from '../features/ssh-remote';
import AppLayout from './layout/AppLayout';
import { ContextMenuRenderer } from '../shared/context-menu-system/components/ContextMenuRenderer';
import { NotificationContainer } from '../shared/notification-system';
import { ConfirmDialogRenderer } from '../component-library';
import { InteractionOverlay } from '../tools/vrm/components/InteractionOverlay';
import { DynamicIsland, LyricsOverlay } from '../tools/island';
import { AceStepPlaybackHost } from '../tools/acestep/components/AceStepPlaybackHost';
import { TodoOverlay } from '../tools/todo';
import { startAudioCommandBridge } from '@/tools/vrm/services/AudioCommandBridge';
import { AgentTheaterWidget } from './components/AgentTheater/AgentTheaterWidget';
import { SessionChatPanels } from './components/AgentTheater/SessionChatPanels';
import { TranslatePopup } from './components/Translate/TranslatePopup';
import { UpdatePromptBar } from './components/UpdatePromptBar/UpdatePromptBar';

function App() {
  const { t } = useI18n('common');
  const mainWindowShownRef = useRef(false);

  useEffect(() => {
    const showMainWindow = async () => {
      if (mainWindowShownRef.current) return;
      mainWindowShownRef.current = true;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('show_main_window');
      } catch {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const w = getCurrentWindow();
          await w.show();
          await w.setFocus();
        } catch {
          mainWindowShownRef.current = false;
        }
      }
    };

    const closeLoader = async () => {
      try {
        const { emit } = await import('@tauri-apps/api/event');
        await emit('close-loader');
      } catch {}
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(async () => {
        await showMainWindow();
        await closeLoader();
      });
    });

    const watchdog = window.setTimeout(() => {
      void showMainWindow();
      void closeLoader();
    }, 10000);

    return () => window.clearTimeout(watchdog);
  }, []);

  useEffect(() => {
    const initIdeControl = async () => {
      try {
        const { initializeIdeControl } = await import('../shared/services/ide-control');
        await initializeIdeControl();
      } catch {}
    };

    const initMCPServers = async () => {
      try {
        const { MCPAPI } = await import('../infrastructure/api/service-api/MCPAPI');
        await MCPAPI.initializeServers();
      } catch {}
    };

    const initSelfControl = async () => {
      try {
        const { startSelfControlEventListener } = await import('../infrastructure/self-control');
        startSelfControlEventListener();
      } catch {}
    };

    const initOverlaySystem = async () => {
      try {
        const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
        const isMac = typeof navigator?.platform === 'string' && navigator.platform.toUpperCase().includes('MAC');
        if (isTauri && !isMac) {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('init_overlay');
        }
      } catch {}
    };

    const initPluginRuntime = () => {
      let dispose: (() => void) | undefined;
      try {
        import('../infrastructure/plugins/runtime').then(({ initPluginRuntime }) => {
          dispose = initPluginRuntime();
        }).catch(() => {});
      } catch {}
      return () => dispose?.();
    };

    const initInteractionConfig = async () => {
      try {
        const { useInteractionStore } = await import('../tools/vrm/store/interactionStore');
        await useInteractionStore.getState().loadInteractionConfig();
      } catch {}
    };

    initIdeControl();
    initMCPServers();
    initSelfControl();
    initOverlaySystem();
    initInteractionConfig();
    const disposePluginRuntime = initPluginRuntime();
    return () => disposePluginRuntime();
  }, []);

  // 音频命令桥（乐窗 Step 3）：`music://audio-command` 远程驱动 audioPlaybackStore，
  // 状态变化 debounce 广播 `music://audio-state` 快照给音乐窗。
  // （.a00m 播放本体 PlayerEngine + PlayerBridge 已随乐窗 Step 4 迁入 MusicWindowApp。）
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void startAudioCommandBridge().then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, []);

  // P1-B：引擎环境安装失败 → 全局 toast 引导「设置 → dsh 扩展 → 引擎健康」恢复
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        if (typeof window === 'undefined' || !('__TAURI__' in window)) return;
        const [{ listen }, { notificationService }] = await Promise.all([
          import('@tauri-apps/api/event'),
          import('@/shared/notification-system'),
        ]);
        const un = await listen('dsh://env-install-failed', () => {
          notificationService.error(t('engine.envInstallFailed'));
        });
        unlisten = un;
      } catch {
        /* 事件桥不可用时静默 */
      }
    })();
    return () => unlisten?.();
  }, [t]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'f' || k === 'r') { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  return (
    <ChatProvider>
      <ViewModeProvider defaultMode="coder">
        <SSHRemoteProvider>
          <AppLayout />
          <InteractionOverlay />
          {/* Injected plugin mount layer: below DynamicIsland (z 50010).
              Plugin DOM marks itself `.no-penetrate` to gain mouse capture. */}
          <div id="ai00-plugin-layer" style={{ position: 'fixed', inset: 0, zIndex: 50000, pointerEvents: 'none' }} />
          <TodoOverlay />
          <DynamicIsland />
          {/* 播放权威常驻挂载（仅 overlay 窗口生效，组件内按 window label 门控） */}
          <AceStepPlaybackHost />
          <LyricsOverlay />
          <AgentTheaterWidget />
          <SessionChatPanels />
          <TranslatePopup />
          <UpdatePromptBar />
          <ContextMenuRenderer />
          <NotificationContainer />
          <ConfirmDialogRenderer />
        </SSHRemoteProvider>
      </ViewModeProvider>
    </ChatProvider>
  );
}

export default App;
