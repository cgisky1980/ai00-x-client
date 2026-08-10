import React, { useCallback } from 'react';
import { Modal, CubeLoading, Button } from '@/component-library';
import { useSandboxCreationStore } from '../../store/SandboxCreationStore';
import { useI18n } from '@/infrastructure/i18n';
import './SandboxCreationModal.scss';

const phaseI18nKey: Record<string, string> = {
  detecting: 'flow-chat:sandboxCreation.phases.detecting',
  staging: 'flow-chat:sandboxCreation.phases.staging',
  'creating-worktree': 'flow-chat:sandboxCreation.phases.creatingWorktree',
  finalizing: 'flow-chat:sandboxCreation.phases.finalizing',
};

export const SandboxCreationModal: React.FC = () => {
  const { isVisible, sessionName, phase, onCancel, hide } = useSandboxCreationStore();
  const { t } = useI18n();

  const handleCancel = useCallback(() => {
    if (onCancel) {
      onCancel();
    }
    hide();
  }, [onCancel, hide]);

  if (!isVisible) return null;

  const phaseText = t(phaseI18nKey[phase] || phaseI18nKey.detecting);

  return (
    <Modal
      isOpen={isVisible}
      onClose={() => {}}
      title={t('flow-chat:sandboxCreation.title')}
      size="small"
      showCloseButton={false}
      closeOnOverlayClick={false}
    >
      <div className="sandbox-creation-modal">
        <div className="sandbox-creation-modal__loading">
          <CubeLoading size="medium" />
        </div>
        <div className="sandbox-creation-modal__info">
          <div className="sandbox-creation-modal__session-name">{sessionName}</div>
          <div className="sandbox-creation-modal__phase">{phaseText}</div>
        </div>
        <div className="sandbox-creation-modal__actions">
          <Button variant="ghost" size="small" onClick={handleCancel}>
            {t('flow-chat:sandboxCreation.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
