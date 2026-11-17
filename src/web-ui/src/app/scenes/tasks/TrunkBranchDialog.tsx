/**
 * TrunkBranchDialog — 主干分支守卫弹窗（P3）。
 *
 * 项目停在 main/master 上时，建任务前先让用户选：开一条任务分支再继续 /
 * 明知有风险也照旧 / 取消。宿主管线负责真正建分支（`createTaskBranch`）。
 */
import React from 'react';
import { Button, Modal } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { TrunkDecision } from '../projects/projectGit';
import './TrunkBranchDialog.scss';

export interface TrunkBranchRequest {
  branch: string;
  dir: string;
  taskTitle: string;
}

export interface TrunkBranchDialogProps {
  request: TrunkBranchRequest | null;
  onDecision: (decision: TrunkDecision) => void;
}

export const TrunkBranchDialog: React.FC<TrunkBranchDialogProps> = ({ request, onDecision }) => {
  const { t } = useI18n('common');
  const branch = request?.branch ?? '';

  return (
    <Modal
      isOpen={request !== null}
      onClose={() => onDecision('cancel')}
      size="small"
      showCloseButton={false}
      closeOnOverlayClick={false}
      contentBare
    >
      <div className="ai00-x-trunk-dialog">
        <h2 className="ai00-x-trunk-dialog__title">
          {t('nav.workbenchWindow.projects.trunk.title', { branch })}
        </h2>
        <p className="ai00-x-trunk-dialog__text">
          {t('nav.workbenchWindow.projects.trunk.message', { branch })}
        </p>
        {request?.taskTitle && (
          <p className="ai00-x-trunk-dialog__task">{request.taskTitle}</p>
        )}
        <div className="ai00-x-trunk-dialog__actions">
          <Button variant="secondary" size="medium" onClick={() => onDecision('cancel')}>
            {t('nav.workbenchWindow.projects.trunk.cancel')}
          </Button>
          <Button variant="ghost" size="medium" onClick={() => onDecision('proceed')}>
            {t('nav.workbenchWindow.projects.trunk.proceed')}
          </Button>
          <Button variant="primary" size="medium" onClick={() => onDecision('branch')}>
            {t('nav.workbenchWindow.projects.trunk.create')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
