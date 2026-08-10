import React, { useCallback } from 'react';
import { Code, Paintbrush, CheckSquare, Music } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useModeStore, type AppMode } from '../../stores/modeStore';
import { useSceneStore } from '../../stores/sceneStore';
import { useNavSceneStore } from '../../stores/navSceneStore';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import { createLogger } from '@/shared/utils/logger';
import './ModeTabs.scss';

const log = createLogger('ModeTabs');

function getDefaultScene(mode: AppMode): 'welcome' | 'task-welcome' | 'wallpaper' | 'acestep' {
  switch (mode) {
    case 'task': return 'task-welcome';
    case 'wallpaper': return 'wallpaper';
    case 'music': return 'acestep';
    default: return 'welcome';
  }
}

const MODES: { id: AppMode; Icon: typeof Code; iconSize: number }[] = [
  { id: 'task', Icon: CheckSquare, iconSize: 14 },
  { id: 'code', Icon: Code, iconSize: 14 },
  { id: 'music', Icon: Music, iconSize: 14 },
  { id: 'wallpaper', Icon: Paintbrush, iconSize: 14 },
];

const ModeTabs: React.FC = () => {
  const { t } = useI18n('common');
  const activeMode = useModeStore((s) => s.activeMode);
  const setActiveMode = useModeStore((s) => s.setActiveMode);
  const openScene = useSceneStore((s) => s.openScene);
  const { openWorkspace, currentWorkspace } = useWorkspaceContext();

  const handleModeChange = useCallback(async (mode: AppMode) => {
    if (mode === activeMode) return;

    // 1. Switch mode
    setActiveMode(mode);

    // 2. Control left navigation based on mode
    const navStore = useNavSceneStore.getState();
    if (mode === 'wallpaper') {
      navStore.openNavScene('wallpaper');
    } else if (mode === 'task') {
      // Task mode uses MainNav with filtered workspace list, not a separate TaskNav
      navStore.closeNavScene();
      // Auto-open task workspace when switching to Task mode
      try {
        const taskPath = await globalAPI.getTaskWorkspacePath();
        const isAlreadyOnTask = currentWorkspace?.rootPath === taskPath;
        if (!isAlreadyOnTask) {
          await openWorkspace(taskPath);
        }
      } catch (e) {
        log.error('Failed to open task workspace on mode switch', e);
      }
    } else if (mode === 'music') {
      // Music mode: no workspace, no nav scene — just the acestep scene
      navStore.closeNavScene();
    } else {
      navStore.closeNavScene();
    }

    // 3. Always show the default scene for the target mode
    openScene(getDefaultScene(mode));
  }, [activeMode, setActiveMode, openScene, openWorkspace, currentWorkspace]);

  return (
    <div className="ai00-x-mode-tabs" role="tablist">
      {MODES.map(({ id, Icon, iconSize }) => (
        <button
          key={id}
          type="button"
          role="tab"
          className={`ai00-x-mode-tab${activeMode === id ? ' is-active' : ''}`}
          aria-selected={activeMode === id}
          onClick={() => handleModeChange(id)}
        >
          <Icon size={iconSize} />
          <span>{t(`nav.modes.${id}`)}</span>
        </button>
      ))}
    </div>
  );
};

export default ModeTabs;
