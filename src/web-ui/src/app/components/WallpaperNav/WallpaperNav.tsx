/**
 * WallpaperNav — left navigation for wallpaper mode.
 *
 * Simplified: each wallpaper project has exactly one session.
 * Click a project to enter its session directly — no session list.
 * Project actions (apply, publish, delete) via menu button.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import {
  FolderOpen, MoreHorizontal, Plus, Paintbrush,
  Monitor, Upload, Trash2,
} from 'lucide-react';
import { usePortalContainer } from '@/infrastructure/contexts/PortalContainerContext';
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
  const portalContainer = usePortalContainer();
  const portalTarget = portalContainer ?? document.body;
  const [projects, setProjects] = useState<WallpaperProject[]>([]);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [openMenuProjectId, setOpenMenuProjectId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);

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

  // Close menu on outside click
  useEffect(() => {
    if (!openMenuProjectId) return;
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (target instanceof Element && target.closest('.ai00-x-wallpaper-nav__project-menu-popover')) return;
      if (target instanceof Element && target.closest('.ai00-x-wallpaper-nav__project-menu-trigger')) return;
      setOpenMenuProjectId(null);
      setMenuPosition(null);
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [openMenuProjectId]);

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

  /** Open project menu */
  const handleMenuOpen = useCallback((e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    if (openMenuProjectId === projectId) {
      setOpenMenuProjectId(null);
      setMenuPosition(null);
      return;
    }
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    setMenuPosition({
      top: rect.bottom + 4,
      left: rect.left,
    });
    setOpenMenuProjectId(projectId);
  }, [openMenuProjectId]);

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
                    <button
                      type="button"
                      className={`ai00-x-wallpaper-nav__project-menu-trigger${isMenuOpen ? ' is-open' : ''}`}
                      onClick={(e) => handleMenuOpen(e, project.id)}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                </div>

                {/* Project action menu popover */}
                {isMenuOpen && menuPosition && createPortal(
                  <div
                    className="ai00-x-wallpaper-nav__project-menu-popover"
                    data-no-penetrate
                    role="menu"
                    style={{ top: menuPosition.top, left: menuPosition.left }}
                  >
                    <button
                      type="button"
                      className="ai00-x-wallpaper-nav__project-menu-item"
                      onClick={() => { void handleApplyToDesktop(project); }}
                    >
                      <Monitor size={13} />
                      <span>{t('applyToDesktop', { defaultValue: 'Apply to Desktop' })}</span>
                    </button>
                    <button
                      type="button"
                      className="ai00-x-wallpaper-nav__project-menu-item"
                      disabled={publishingId === project.id}
                      onClick={() => { void handlePublish(project.id); }}
                    >
                      {publishingId === project.id
                        ? <span className="ai00-x-wallpaper-nav__spinner" />
                        : <Upload size={13} />}
                      <span>{t('projectList.publish')}</span>
                    </button>
                    <div className="ai00-x-wallpaper-nav__project-menu-divider" />
                    <button
                      type="button"
                      className="ai00-x-wallpaper-nav__project-menu-item is-danger"
                      onClick={() => { void handleDelete(project.id); }}
                    >
                      <Trash2 size={13} />
                      <span>{t('projectList.delete')}</span>
                    </button>
                  </div>,
                  portalTarget
                )}
              </div>
            );
          })
        )}
      </div>
    </nav>
  );
};

export default WallpaperNav;
