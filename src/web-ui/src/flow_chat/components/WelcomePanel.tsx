/**
 * Welcome panel shown in the empty chat state.
 * Layout mirrors WelcomeScene: centered container, left-aligned content.
 * Differentiates greetings by session mode (code, task, cowork, wallpaper).
 */

import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import CoworkExampleCards from './CoworkExampleCards';
import './WelcomePanel.css';

interface WelcomePanelProps {
  onQuickAction?: (command: string) => void;
  className?: string;
  sessionMode?: string;
  workspacePath?: string;
}

export const WelcomePanel: React.FC<WelcomePanelProps> = ({
  onQuickAction,
  className = '',
  sessionMode,
  workspacePath: _workspacePath = '',
}) => {
  const { t } = useTranslation('flow-chat');
  const sessionModeLower = (sessionMode || '').toLowerCase();
  const isCoworkSession = sessionModeLower === 'cowork';
  const isTaskSession = sessionModeLower === 'task';

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    const s = isCoworkSession ? 'Cowork' : isTaskSession ? 'Task' : '';
    if (hour >= 5 && hour < 12) return { title: t('welcome.greetingMorning'), subtitle: t(`welcome.subtitleMorning${s}`) };
    if (hour >= 12 && hour < 18) return { title: t('welcome.greetingAfternoon'), subtitle: t(`welcome.subtitleAfternoon${s}`) };
    if (hour >= 18 && hour < 23) return { title: t('welcome.greetingEvening'), subtitle: t(`welcome.subtitleEvening${s}`) };
    return { title: t('welcome.greetingNight'), subtitle: t(`welcome.subtitleNight${s}`) };
  }, [t, isCoworkSession, isTaskSession]);

  const tagline = greeting.subtitle;
  const aiPartnerKey = isCoworkSession ? 'welcome.aiPartnerCowork' : isTaskSession ? 'welcome.aiPartnerTask' : 'welcome.aiPartner';

  const handleQuickActionClick = useCallback((cmd: string) => {
    onQuickAction?.(cmd);
  }, [onQuickAction]);

  return (
    <div className={`welcome-panel ${className}`}>
      <div className="welcome-panel__content">
        {/* Greeting */}
        <div className="welcome-panel__greeting">
          <div className="welcome-panel__greeting-inner">
            <div className="welcome-panel__greeting-text">
              <h1 className="welcome-panel__heading">
                {greeting.title}，{t(aiPartnerKey)}
              </h1>
              <p className="welcome-panel__tagline">{tagline}</p>
            </div>
          </div>
        </div>

        {/* Cowork examples */}
        {isCoworkSession && (
          <div className="welcome-panel__cowork">
            <CoworkExampleCards resetKey={0} onSelectPrompt={p => handleQuickActionClick(p)} />
          </div>
        )}
      </div>
    </div>
  );
};

export default WelcomePanel;
