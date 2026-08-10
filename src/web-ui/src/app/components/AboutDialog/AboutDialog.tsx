/**
 * About dialog component.
 * Shows app version and license info.
 * Uses component library Modal.
 */

import React, { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Tooltip, Modal } from '@/component-library';
import { Copy, Check } from 'lucide-react';
import {
  getAboutInfo,
  formatVersion,
  formatBuildDate
} from '@/shared/utils/version';
import { createLogger } from '@/shared/utils/logger';
import './AboutDialog.scss';

const log = createLogger('AboutDialog');

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
  modalContainer?: HTMLElement;
}

export const AboutDialog: React.FC<AboutDialogProps> = ({
  isOpen,
  onClose,
  modalContainer,
}) => {
  const { t } = useI18n('common');
  const [copiedItem, setCopiedItem] = useState<string | null>(null);

  const aboutInfo = getAboutInfo();
  const { version, license } = aboutInfo;

  const copyToClipboard = async (text: string, itemId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedItem(itemId);
      setTimeout(() => setCopiedItem(null), 2000);
    } catch (err) {
      log.error('Failed to copy to clipboard', err);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('header.about')}
      showCloseButton={true}
      size="medium"
      container={modalContainer}
    >
      <div className="ai00-x-about-dialog__content">
        {/* Hero section - product info */}
        <div className="ai00-x-about-dialog__hero">
          <h1 className="ai00-x-about-dialog__title">{version.name}</h1>
          <div className="ai00-x-about-dialog__version-badge">
            {t('about.version', { version: formatVersion(version.version, version.isDev) })}
          </div>
          <div className="ai00-x-about-dialog__divider" />
          <div className="ai00-x-about-dialog__dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>

        {/* Scrollable area */}
        <div className="ai00-x-about-dialog__scrollable">
          <div className="ai00-x-about-dialog__info-section">
            <div className="ai00-x-about-dialog__info-card">
              <div className="ai00-x-about-dialog__info-row">
                <span className="ai00-x-about-dialog__info-label">{t('about.buildDate')}</span>
                <span className="ai00-x-about-dialog__info-value">
                  {formatBuildDate(version.buildDate)}
                </span>
              </div>

              {version.gitCommit && (
                <div className="ai00-x-about-dialog__info-row">
                  <span className="ai00-x-about-dialog__info-label">{t('about.commit')}</span>
                  <div className="ai00-x-about-dialog__info-value-group">
                    <span className="ai00-x-about-dialog__info-value ai00-x-about-dialog__info-value--mono">
                      {version.gitCommit}
                    </span>
                    <Tooltip content={t('about.copy')}>
                      <button
                        className="ai00-x-about-dialog__copy-btn"
                        onClick={() => copyToClipboard(version.gitCommit || '', 'commit')}
                      >
                        {copiedItem === 'commit' ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </Tooltip>
                  </div>
                </div>
              )}

              {version.gitBranch && (
                <div className="ai00-x-about-dialog__info-row">
                  <span className="ai00-x-about-dialog__info-label">{t('about.branch')}</span>
                  <span className="ai00-x-about-dialog__info-value">{version.gitBranch}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="ai00-x-about-dialog__footer">
          <p className="ai00-x-about-dialog__license">{license.text}</p>
          <p className="ai00-x-about-dialog__copyright">
            {t('about.copyright')}
          </p>
        </div>
      </div>
    </Modal>
  );
};

export default AboutDialog;
