import React, { useCallback, useEffect } from 'react';
import SettingsDialog from './SettingsDialog';
import SettingsNav from './SettingsNav';
import SettingsScene from './SettingsScene';
import { useOverlayControlStore } from '@/app/stores/overlayControlStore';
import { useI18n } from '@/infrastructure/i18n';
import './SettingsOverlayDialog.scss';

const SettingsOverlayDialog: React.FC = () => {
  const { t } = useI18n('settings');
  const settingsDialogVisible = useOverlayControlStore((s) => s.settingsDialogVisible);
  const setSettingsDialogVisible = useOverlayControlStore((s) => s.setSettingsDialogVisible);
  const setFocusedPanel = useOverlayControlStore((s) => s.setFocusedPanel);

  const handleClose = useCallback(() => {
    setSettingsDialogVisible(false);
  }, [setSettingsDialogVisible]);

  useEffect(() => {
    if (settingsDialogVisible) {
      setFocusedPanel('settings-dialog');
    }
  }, [settingsDialogVisible, setFocusedPanel]);

  if (!settingsDialogVisible) return null;

  return (
    <SettingsDialog
      title={t('title', { defaultValue: 'Settings' })}
      defaultWidth={900}
      defaultHeight={600}
      onClose={handleClose}
    >
      <div className="ai00-x-settings-overlay">
        <div className="ai00-x-settings-overlay__nav">
          <SettingsNav />
        </div>
        <div className="ai00-x-settings-overlay__content">
          <SettingsScene showNav={false} />
        </div>
      </div>
    </SettingsDialog>
  );
};

export default SettingsOverlayDialog;
