/**
 * WallpaperDesignView — AI-powered wallpaper creation entry point.
 *
 * Simplified flow: choose a style or describe what you want,
 * then immediately start designing with the AI agent.
 * The preview window opens automatically when the session starts.
 */

import React, { useCallback, useState, useEffect } from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { i18nService } from '@/infrastructure/i18n';
import { Wand2, ArrowRight, Loader2, FolderOpen, Monitor } from 'lucide-react';
import { Button } from '@/component-library';
import { wallpaperAPI } from '@/infrastructure/api/service-api/WallpaperAPI';
import { configAPI } from '@/infrastructure/api';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { findWallpaperProjectSession } from '@/app/utils/projectSessionWorkspace';
import { openMainSession } from '@/flow_chat/services/sessionNavigation';
import './WallpaperDesignView.scss';

interface StyleCardData {
  id: string;
  emoji: string;
  color: string;
  prompt: string;
}

const STYLE_CARDS: StyleCardData[] = [
  { id: 'starfield', emoji: '\u{1F30C}', color: '#6366f1', prompt: 'A beautiful star field with twinkling stars and a subtle nebula background' },
  { id: 'matrix', emoji: '\u{2B1C}', color: '#22c55e', prompt: 'Matrix-style green code rain falling down, with a dark background' },
  { id: 'waves', emoji: '\u{1F30A}', color: '#3b82f6', prompt: 'Colorful floating particles that slowly drift and pulse like ocean waves' },
  { id: 'aurora', emoji: '\u{1F308}', color: '#f59e0b', prompt: 'Smooth morphing gradient like aurora borealis, full screen' },
  { id: 'visualizer', emoji: '\u{1F3B5}', color: '#ef4444', prompt: 'An audio spectrum visualizer with bars that react to sound' },
  { id: 'clock', emoji: '\u{1F550}', color: '#8b5cf6', prompt: 'A minimal digital clock centered on screen, with a sleek modern font' },
];

interface ProjectItem {
  dirName: string;
  name: string;
  createdAt: string;
  projectPath?: string;
}

/** Error boundary — shows a fallback UI instead of a blank page */
class WallpaperErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string | null }
> {
  state = { hasError: false, error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="wallpaper-design" style={{ textAlign: 'center', padding: '4rem' }}>
          <h2 style={{ color: 'var(--color-text-primary)' }}>{i18nService.t('common:wallpaper.somethingWentWrong')}</h2>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
            {this.state.error || i18nService.t('common:wallpaper.unknownError')}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export const WallpaperDesignView: React.FC = () => {
  const { t } = useI18n('scenes/wallpaper');
  const [description, setDescription] = useState('');
  const [selectedStyle, setSelectedStyle] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingProjects, setExistingProjects] = useState<ProjectItem[]>([]);

  // Load existing projects
  useEffect(() => {
    wallpaperAPI.listWorkspaceProjects()
      .then((projects) => {
        setExistingProjects(
          projects.map((p) => ({
            dirName: p.id,
            name: p.name,
            createdAt: p.createdAt,
            projectPath: p.projectPath,
          })),
        );
      })
      .catch(() => setExistingProjects([]));
  }, []);

  // Start a wallpaper design session
  const startDesign = useCallback(async (prompt: string, name?: string) => {
    if (!prompt.trim()) return;
    setError(null);
    setIsCreating(true);

    try {
      const projectName = name || (prompt.length > 30 ? prompt.slice(0, 30) + '...' : prompt);
      const result = await wallpaperAPI.createWorkspaceProject(projectName);

      const existingSession = findWallpaperProjectSession(result.projectPath);

      let sessionId: string;
      if (existingSession) {
        sessionId = existingSession.sessionId;
      } else {
        const manager = FlowChatManager.getInstance();
        sessionId = await manager.createChatSession(
          { workspacePath: result.projectPath },
          'Wallpaper',
        );
      }

      await openMainSession(sessionId);

      const fullPrompt = `Project: ${projectName}\n\n${prompt}`;
      const manager = FlowChatManager.getInstance();
      await manager.sendMessage(fullPrompt, sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  }, []);

  const handleStyleClick = useCallback((style: StyleCardData) => {
    setSelectedStyle(style.id);
    startDesign(style.prompt, t(`styles.${style.id}.label`, { defaultValue: style.id }));
  }, [startDesign, t]);

  const handleSubmit = useCallback(() => {
    startDesign(description.trim());
  }, [description, startDesign]);

  const handleContinueDesign = useCallback(async (project: ProjectItem) => {
    setError(null);
    setIsCreating(true);

    try {
      const projectPath = project.projectPath;
      if (!projectPath) {
        setError('Project path not available');
        return;
      }

      const existing = flowChatStore.getSessionsByWorkspacePath(projectPath);
      if (existing.length === 0) {
        try {
          await flowChatStore.initializeFromDisk(projectPath);
        } catch {
          // Non-critical
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  }, []);

  const handleApplyToDesktop = useCallback(async (project: ProjectItem) => {
    try {
      const projectPath = project.projectPath;
      if (!projectPath) return;
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
    } catch (err) {
      console.error('Failed to apply wallpaper:', err);
    }
  }, []);

  if (isCreating) {
    return (
      <div className="wallpaper-design">
        <div className="wallpaper-design__inner">
          <div className="wallpaper-design__creating">
            <Loader2 size={40} className="wallpaper-design__spinner" />
            <h3 className="wallpaper-design__creating-title">{t('creating')}</h3>
            <p className="wallpaper-design__creating-desc">
              {t('openingDesign', { defaultValue: 'Opening design session...' })}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wallpaper-design">
      <div className="wallpaper-design__inner">
        {/* Hero */}
        <div className="wallpaper-design__hero">
          <div className="wallpaper-design__icon">
            <Wand2 size={28} strokeWidth={1.5} />
          </div>
          <h1 className="wallpaper-design__title">{t('title')}</h1>
          <p className="wallpaper-design__subtitle">
            {t('subtitleInstant', { defaultValue: 'Describe your dream wallpaper and start designing instantly' })}
          </p>
        </div>

        {/* Style cards */}
        <div className="wallpaper-design__styles">
          <h3 className="wallpaper-design__section-title">{t('chooseStyle')}</h3>
          <div className="wallpaper-design__cards">
            {STYLE_CARDS.map((style) => (
              <button
                key={style.id}
                type="button"
                className={[
                  'wallpaper-design__card',
                  selectedStyle === style.id && 'wallpaper-design__card--selected',
                ].filter(Boolean).join(' ')}
                style={{ '--card-color': style.color } as React.CSSProperties}
                onClick={() => handleStyleClick(style)}
                disabled={isCreating}
              >
                <span className="wallpaper-design__card-emoji">{style.emoji}</span>
                <span className="wallpaper-design__card-label">
                  {t(`styles.${style.id}.label`)}
                </span>
                <span className="wallpaper-design__card-desc">
                  {t(`styles.${style.id}.desc`)}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="wallpaper-design__divider">
          <span>{t('orDescribe')}</span>
        </div>

        {/* Free-form description */}
        <div className="wallpaper-design__form">
          <textarea
            className="wallpaper-design__input"
            placeholder={t('placeholder')}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setSelectedStyle(null);
              setError(null);
            }}
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <Button
            className="wallpaper-design__btn"
            onClick={handleSubmit}
            disabled={!description.trim() || isCreating}
          >
            {t('startDesign', { defaultValue: 'Start Designing' })}
            <ArrowRight size={16} />
          </Button>
        </div>

        {/* Existing projects */}
        {existingProjects.length > 0 && (
          <div className="wallpaper-design__existing">
            <h3 className="wallpaper-design__section-title">
              <FolderOpen size={16} />
              {t('existingProjects', { defaultValue: 'Your Projects' })}
            </h3>
            <div className="wallpaper-design__project-list">
              {existingProjects.map((project) => (
                <div key={project.dirName} className="wallpaper-design__project-item">
                  <div className="wallpaper-design__project-info">
                    <span className="wallpaper-design__project-name">{project.name}</span>
                    <span className="wallpaper-design__project-date">
                      {new Date(project.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="wallpaper-design__project-actions">
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => handleContinueDesign(project)}
                    >
                      {t('continueDesign', { defaultValue: 'Continue' })}
                    </Button>
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => handleApplyToDesktop(project)}
                      title={t('applyToDesktop', { defaultValue: 'Apply to Desktop' })}
                    >
                      <Monitor size={14} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <p className="wallpaper-design__error">{error}</p>}
      </div>
    </div>
  );
};

export default function WallpaperDesignViewWithBoundary() {
  return (
    <WallpaperErrorBoundary>
      <WallpaperDesignView />
    </WallpaperErrorBoundary>
  );
}
