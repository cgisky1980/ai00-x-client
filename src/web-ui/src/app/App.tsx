import { useEffect, useRef } from 'react';
import { ChatProvider } from '../infrastructure';
import { ViewModeProvider } from '../infrastructure/contexts/ViewModeProvider';
import { SSHRemoteProvider } from '../features/ssh-remote';
import AppLayout from './layout/AppLayout';
import { ContextMenuRenderer } from '../shared/context-menu-system/components/ContextMenuRenderer';
import { NotificationContainer } from '../shared/notification-system';
import { ConfirmDialogRenderer } from '../component-library';
import { InteractionOverlay } from '../tools/vrm/components/InteractionOverlay';
import { DynamicIsland, LyricsOverlay } from '../tools/island';
import { PlayerEngine } from '@/tools/acestep/components/PlayerEngine';
import { startPlayerBridge } from '@/tools/acestep/services/PlayerBridge';

function App() {
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

  // The .a00m playback engine + player bridge live at the overlay window root,
  // which is always resident in the background (transparent click-through shell
  // hosting DynamicIsland / MusicPopup / LyricsOverlay). This lets music play
  // in the background without ever needing to open the task/chat window.
  useEffect(() => {
    const cleanup = startPlayerBridge();
    return cleanup;
  }, []);

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
          <DynamicIsland />
          <LyricsOverlay />
          <PlayerEngine />
          <ContextMenuRenderer />
          <NotificationContainer />
          <ConfirmDialogRenderer />
        </SSHRemoteProvider>
      </ViewModeProvider>
    </ChatProvider>
  );
}

export default App;
