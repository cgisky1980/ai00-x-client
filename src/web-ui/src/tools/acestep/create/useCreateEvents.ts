/**
 * useCreateEvents — Tauri event wiring for the create section.
 *
 * Decoupled from the retired acestepStore: generation progress lands in
 * the create store, scoped to whichever creation is generating.
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { AceStepProgressEvent } from '../types';
import { useCreateStore } from './createStore';

export function useCreateEvents(): void {
  useEffect(() => {
    const unlistenProgress = listen<AceStepProgressEvent>('acestep_progress', (event) => {
      useCreateStore.setState({ progress: event.payload });
    });
    const unlistenDone = listen('acestep_generate_done', () => {
      useCreateStore.setState({ progress: null });
    });
    return () => {
      void unlistenProgress.then((fn) => fn());
      void unlistenDone.then((fn) => fn());
    };
  }, []);
}
