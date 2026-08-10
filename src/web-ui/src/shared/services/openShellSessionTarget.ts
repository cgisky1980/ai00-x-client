import type { SceneTabId } from '@/app/components/SceneBar/types';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useTerminalSceneStore } from '@/app/stores/terminalSceneStore';

interface OpenShellSessionTargetOptions {
  sessionId: string;
  sessionName: string;
}

function openStandaloneShellSession(sessionId: string): void {
  const { openScene } = useSceneStore.getState();
  const terminalState = useTerminalSceneStore.getState();

  openScene('shell' as SceneTabId);

  if (terminalState.activeSessionId === sessionId) {
    terminalState.setActiveSession(null);
    window.setTimeout(() => {
      useTerminalSceneStore.getState().setActiveSession(sessionId);
    }, 0);
    return;
  }

  terminalState.setActiveSession(sessionId);
}

export function openShellSessionTarget(options: OpenShellSessionTargetOptions): void {
  const { sessionId } = options;
  const { activeTabId } = useSceneStore.getState();

  if (activeTabId === 'session') {
    const terminalState = useTerminalSceneStore.getState();
    if (terminalState.activeSessionId === sessionId) {
      terminalState.setActiveSession(null);
      window.setTimeout(() => {
        useTerminalSceneStore.getState().setActiveSession(sessionId);
      }, 0);
    } else {
      terminalState.setActiveSession(sessionId);
    }
    return;
  }

  openStandaloneShellSession(sessionId);
}
