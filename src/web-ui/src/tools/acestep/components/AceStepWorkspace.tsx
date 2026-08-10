import React, { lazy, Suspense } from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useAceStepEvents } from '../hooks/useAceStep';
import './AceStepWorkspace.scss';
import '../views/views.scss';

const ChatCreateView = lazy(() => import('../views/ChatCreateView'));

/**
 * AceStepWorkspace — music creation workspace.
 *
 * Hosts the ChatCreateView (LLM-driven conversational music creation).
 * The headless PlayerEngine + cross-window PlayerBridge live at the main
 * window root (ChatWindowApp), so this workspace stays a pure creation UI.
 */
const AceStepWorkspace: React.FC = () => {
  const { t } = useI18n('acestep');

  // Register Tauri event listeners at the workspace level so they stay active
  // regardless of which view is mounted (chat streaming, generation progress).
  useAceStepEvents();

  return (
    <div className="ai00-x-acestep-workspace">
      <div className="ai00-x-acestep-workspace__main">
        <Suspense fallback={<div className="ai00-x-acestep-workspace__loading">{t('loading', { defaultValue: 'Loading...' })}</div>}>
          <ChatCreateView />
        </Suspense>
      </div>
    </div>
  );
};

export default AceStepWorkspace;
