/**
 * WallpaperNav — left navigation for wallpaper mode.
 *
 * Simplified: each wallpaper project has exactly one session.
 * Click a project to enter its session directly — no session list.
 * Project actions (apply, publish, delete) via menu button.
 * v0.13：菜单浮层收敛至 DS DropdownMenu（.ds-menu）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import {
  FolderOpen, MoreHorizontal, Plus, Paintbrush,
  Monitor, Upload, Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/component-library';
import { useSceneStore } from '../../stores/sceneStore';
import { wallpaperAPI, WallpaperProject } from '@/infrastructure/api/service-api/WallpaperAPI';
import { configAPI } from '@/infrastructure/api';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { useActiveSession } from '@/flow_chat/store/modernFlowChatStore';
import { findWallpaperProjectSession, pathsEqual } from '@/app/utils/projectSessionWorkspace';
import { openMainSession } from '@/flow_chat/services/sessionNavigation';
import { notificationService } from '@/shared/notification-system';
import './WallpaperNav.scss';

const WallpaperNav: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { t } = useI18n('scenes/wallpaper');
  const activeSession = useActiveSession();
  const openScene = useSceneStore((s) => s.openScene);
  const [projects, setProjects] = useState<WallpaperProject[]>([]);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [openMenuProjectId, setOpenMenuProjectId] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const list = await wallpaperAPI.listWorkspaceProjects();
      setProjects(list);
      // Load sessions for each wallpaper project so they can be found by findWallpaperProjectSession
      for (const project of list) {
        if (project.projectPath) {
          const existing = flowChatStore.getSessionsByWorkspacePath(project.projectPath);
          if (existing.length === 0) {
            try {
              await flowChatStore.initializeFromDisk(project.projectPath);
            } catch {
              // Silently fail — non-critical
            }
          }
        }
      }
    } catch {
      // Silently fail — project list is non-critical
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    const onFocus = () => { void loadProjects(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadProjects]);

  /** Click project → enter its session directly */
  const handleProjectClick = useCallback(async (project: WallpaperProject) => {
    const projectPath = project.projectPath;
    if (!projectPath) return;

    try {
      const existing = flowChatStore.getSessionsByWorkspacePath(projectPath);
      if (existing.length === 0) {
        try {
          await flowChatStore.initializeFromDisk(projectPath);
        } catch {
          // Non-critical — may already be loaded or no sessions exist
        }
      }

      const existingSession = findWallpaperProjectSession(projectPath);

      if (existingSession) {
        await openMainSession(existingSession.sessionId);
      } else {
        const manager = FlowChatManager.getInstance();
        const sessionId = await manager.createChatSession(
          { workspacePath: projectPath },
          'Wallpaper',
        );
        await openMainSession(sessionId);
      }
    } catch (err) {
      notificationService.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handlePublish = useCallback(async (dirName: string) => {
    setPublishingId(dirName);
    setOpenMenuProjectId(null);
    try {
      const result = await wallpaperAPI.publishProject(dirName);
      notificationService.success(t('published'), { duration: 3000 });
      window.open(result.serveUrl, '_blank');
    } catch (err) {
      notificationService.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishingId(null);
    }
  }, [t]);

  const handleDelete = useCallback(async (dirName: string) => {
    setOpenMenuProjectId(null);
    try {
      await wallpaperAPI.deleteWorkspaceProject(dirName);
      setProjects(prev => prev.filter(p => p.id !== dirName));
    } catch (err) {
      notificationService.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleApplyToDesktop = useCallback(async (project: WallpaperProject) => {
    setOpenMenuProjectId(null);
    try {
      const projectPath = project.projectPath;
      if (!projectPath) {
        notificationService.error('Project path not available');
        return;
      }
      let mode: string | undefined;
      try {
        const raw = await configAPI.getConfig('app.underlay');
        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          mode = parsed?.background?.mode;
        }
      } catch {
        // fallback: let backend read from config
      }
      await wallpaperAPI.applyToDesktop(projectPath, { mode });
      notificationService.success(t('appliedToDesktop', { defaultValue: 'Wallpaper applied to desktop' }), { duration: 3000 });
    } catch (err) {
      notificationService.error(err instanceof Error ? err.message : String(err));
    }
  }, [t]);

  // Determine which project is currently active (based on active session)
  const activeProjectId = useMemo(() => {
    if (!activeSession) return null;
    const wp = activeSession.workspacePath || activeSession.config?.workspacePath;
    if (!wp) return null;
    return projects.find(p => pathsEqual(p.projectPath, wp))?.id ?? null;
  }, [activeSession, projects]);

  return (
    <nav className={`ai00-x-wallpaper-nav ${className}`}>
      <div className="ai00-x-wallpaper-nav__section-header">
        <div className="ai00-x-wallpaper-nav__section-header-left">
          <FolderOpen size={12} />
          <span>{t('myProjects')}</span>
        </div>
        <button
          type="button"
          className="ai00-x-wallpaper-nav__section-action"
          aria-label={t('newDesign')}
          onClick={() => openScene('wallpaper')}
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="ai00-x-wallpaper-nav__projects">
        {projects.length === 0 ? (
          <div className="ai00-x-wallpaper-nav__projects-empty">
            {t('projectList.empty')}
          </div>
        ) : (
          projects.map(project => {
            const isMenuOpen = openMenuProjectId === project.id;
            const isActive = project.id === activeProjectId;

            return (
              <div
                key={project.id}
                className={[
                  'ai00-x-wallpaper-nav__project',
                  isMenuOpen && 'is-menu-open',
                ].filter(Boolean).join(' ')}
              >
                {/* Project card — click to enter session */}
                <div className="ai00-x-wallpaper-nav__project-card">
                  <button
                    type="button"
                    className={`ai00-x-wallpaper-nav__project-name-btn${isActive ? ' is-active' : ''}`}
                    onClick={() => { void handleProjectClick(project); }}
                  >
                    <Paintbrush size={13} className="ai00-x-wallpaper-nav__project-icon" />
                    <span className="ai00-x-wallpaper-nav__project-name">{project.name}</span>
                  </button>
                  <div className="ai00-x-wallpaper-nav__project-menu">
                    <DropdownMenu
                      open={openMenuProjectId === project.id}
                      onOpenChange={(open) => setOpenMenuProjectId(open ? project.id : null)}
                    >
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={`ai00-x-wallpaper-nav__project-menu-trigger${isMenuOpen ? ' is-open' : ''}`}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </DropdownMenuTrigger>

                      <DropdownMenuContent align="start" sideOffset={4} data-no-penetrate>
                        <DropdownMenuItem onClick={() => { void handleApplyToDesktop(project); }}>
                          <Monitor size={13} />
                          <span>{t('applyToDesktop', { defaultValue: 'Apply to Desktop' })}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={publishingId === project.id}
                          onClick={() => { void handlePublish(project.id); }}
                        >
                          {publishingId === project.id
                            ? <span className="ai00-x-wallpaper-nav__spinner" />
                            : <Upload size={13} />}
                          <span>{t('projectList.publish')}</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive onClick={() => { void handleDelete(project.id); }}>
                          <Trash2 size={13} />
                          <span>{t('projectList.delete')}</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </nav>
  );
};

export default WallpaperNav;
