/**
 * Thin overlay shell — transparent click-through window.
 *
 * Contains only: initMouseThrough + SettingsOverlayDialog.
 * All workspace functionality is in ChatWindowApp (chat.html).
 */
import React, { useEffect } from 'react';
import { initMouseThrough } from '@/infrastructure/overlay';
import SettingsOverlayDialog from '../scenes/settings/SettingsOverlayDialog';
import './AppLayout.scss';

interface AppLayoutProps {
  className?: string;
}

const AppLayout: React.FC<AppLayoutProps> = ({ className = '' }) => {
  useEffect(() => {
    const cleanup = initMouseThrough();
    return cleanup;
  }, []);

  const containerClassName = [
    'ai00-x-app-layout',
    'ai00-x-app-layout--overlay',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={containerClassName} data-testid="app-layout">
      <div
        className="ai00-x-overlay-dialogs no-penetrate"
        data-no-penetrate="true"
      >
        <SettingsOverlayDialog />
      </div>
    </div>
  );
};

export default AppLayout;
