/**
 * Confirm dialog renderer, mounted at the app root
 */

import React from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { useConfirmDialogStore } from './confirmService';

export const ConfirmDialogRenderer: React.FC = () => {
  const { isOpen, options, confirm, cancel, close } = useConfirmDialogStore();

  if (!options) {
    return null;
  }

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={close}
      onConfirm={confirm}
      onCancel={cancel}
      title={options.title}
      message={options.message}
      type={options.type}
      confirmText={options.confirmText}
      cancelText={options.cancelText}
      confirmDanger={options.confirmDanger}
      showCancel={options.showCancel}
      preview={options.preview}
      previewMaxHeight={options.previewMaxHeight}
    />
  );
};

export default ConfirmDialogRenderer;
