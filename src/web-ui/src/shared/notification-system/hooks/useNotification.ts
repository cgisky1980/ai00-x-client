 

import { useCallback, useMemo } from 'react';
import { notificationService } from '../services/NotificationService';
import {
  ToastOptions,
  ProgressOptions,
  PersistentOptions,
  SilentOptions,
  ProgressController
} from '../types';

export interface UseNotificationReturn {
   
  success: (message: string, options?: ToastOptions) => string;
   
  error: (message: string, options?: ToastOptions) => string;
   
  warning: (message: string, options?: ToastOptions) => string;
   
  info: (message: string, options?: ToastOptions) => string;
   
  progress: (options: ProgressOptions) => ProgressController;
   
  persistent: (options: PersistentOptions) => string;
   
  silent: (options: SilentOptions) => string;
   
  dismiss: (id: string) => void;
   
  dismissAll: () => void;
}

 
export function useNotification(): UseNotificationReturn {
  const success = useCallback((message: string, options?: ToastOptions) => {
    return notificationService.success(message, options);
  }, []);

  const error = useCallback((message: string, options?: ToastOptions) => {
    return notificationService.error(message, options);
  }, []);

  const warning = useCallback((message: string, options?: ToastOptions) => {
    return notificationService.warning(message, options);
  }, []);

  const info = useCallback((message: string, options?: ToastOptions) => {
    return notificationService.info(message, options);
  }, []);

  const progress = useCallback((options: ProgressOptions) => {
    return notificationService.progress(options);
  }, []);

  const persistent = useCallback((options: PersistentOptions) => {
    return notificationService.persistent(options);
  }, []);

  const silent = useCallback((options: SilentOptions) => {
    return notificationService.silent(options);
  }, []);

  const dismiss = useCallback((id: string) => {
    notificationService.dismiss(id);
  }, []);

  const dismissAll = useCallback(() => {
    notificationService.dismissAll();
  }, []);

  // Return a stable object reference: the object identity must not change across
  // renders, otherwise consumers using it as a useCallback/useEffect dependency
  // (e.g. DshPluginsConfig) will loop infinitely (re-render -> new object -> effect
  // refires -> setState -> re-render).
  return useMemo(() => ({
    success,
    error,
    warning,
    info,
    progress,
    persistent,
    silent,
    dismiss,
    dismissAll
  }), [success, error, warning, info, progress, persistent, silent, dismiss, dismissAll]);
}

