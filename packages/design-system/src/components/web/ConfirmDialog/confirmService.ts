/**
 * Confirm dialog service
 * Provides an imperative API and returns Promise<boolean>
 */

import { create } from 'zustand';
import type { ConfirmDialogType } from './ConfirmDialog';

export interface ConfirmDialogOptions {
  /** Title */
  title: string;
  /** Message content */
  message: React.ReactNode;
  /** Dialog type */
  type?: ConfirmDialogType;
  /** Confirm button text */
  confirmText?: string;
  /** Cancel button text */
  cancelText?: string;
  /** Whether the confirm button uses danger styling */
  confirmDanger?: boolean;
  /** Whether to show the cancel button */
  showCancel?: boolean;
  /** Preview content */
  preview?: string;
  /** Max preview height */
  previewMaxHeight?: number;
}

interface ConfirmDialogState {
  /** Is open */
  isOpen: boolean;
  /** Options */
  options: ConfirmDialogOptions | null;
  /** Resolve callback */
  resolve: ((value: boolean) => void) | null;
  
  /** Show the dialog */
  show: (options: ConfirmDialogOptions) => Promise<boolean>;
  /** Confirm */
  confirm: () => void;
  /** Cancel */
  cancel: () => void;
  /** Close */
  close: () => void;
}

export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  isOpen: false,
  options: null,
  resolve: null,

  show: (options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      set({
        isOpen: true,
        options,
        resolve,
      });
    });
  },

  confirm: () => {
    const { resolve } = get();
    if (resolve) {
      resolve(true);
    }
    set({
      isOpen: false,
      options: null,
      resolve: null,
    });
  },

  cancel: () => {
    const { resolve } = get();
    if (resolve) {
      resolve(false);
    }
    set({
      isOpen: false,
      options: null,
      resolve: null,
    });
  },

  close: () => {
    const { resolve } = get();
    if (resolve) {
      resolve(false);
    }
    set({
      isOpen: false,
      options: null,
      resolve: null,
    });
  },
}));

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return useConfirmDialogStore.getState().show(options);
}

export function confirmWarning(title: string, message: React.ReactNode, options?: Partial<ConfirmDialogOptions>): Promise<boolean> {
  return confirmDialog({
    title,
    message,
    type: 'warning',
    ...options,
  });
}

export function confirmDanger(title: string, message: React.ReactNode, options?: Partial<ConfirmDialogOptions>): Promise<boolean> {
  return confirmDialog({
    title,
    message,
    type: 'error',
    confirmDanger: true,
    ...options,
  });
}

export function confirmInfo(title: string, message: React.ReactNode, options?: Partial<ConfirmDialogOptions>): Promise<boolean> {
  return confirmDialog({
    title,
    message,
    type: 'info',
    showCancel: false,
    ...options,
  });
}
