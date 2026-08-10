/**
 * React hook for AceStep music generation.
 *
 * Subscribes to Tauri events for progress and completion, and exposes
 * store actions to components.
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAceStepStore } from '../store/acestepStore';
import type {
  AceStepLlmChunkEvent,
  AceStepLlmDoneEvent,
  AceStepProgressEvent,
} from '../types';

/**
 * Register Tauri event listeners for ACE-Step progress + chat streaming events.
 *
 * Call this once at the workspace level (e.g. in AceStepWorkspace) so the
 * listeners stay active regardless of which view is mounted. Uses
 * `useAceStepStore.getState()` (no subscription) to avoid re-rendering the
 * caller on every chunk.
 */
export function useAceStepEvents() {
  useEffect(() => {
    const unlistenProgress = listen<AceStepProgressEvent>(
      'acestep_progress',
      (event) => {
        useAceStepStore.getState().setProgress(event.payload);
      },
    );

    const unlistenDone = listen('acestep_generate_done', () => {
      useAceStepStore.getState().setProgress(null);
    });

    // Chat streaming events.
    // IMPORTANT: Both chunk and done events carry a sessionId. We MUST
    // filter out events whose sessionId doesn't match the store's
    // currentChatSessionId. Without this filter, a stale done event from
    // the main conversation stream can be processed during a subagent
    // stream (race condition: main stream's done event arrives after
    // executeLyricsWriterAndContinue has already set isSubagentStream=true),
    // causing finishStreaming to enter the isSubagentStream path with the
    // wrong content — which is the root cause of "调用歌词 subagent
    // displayed but subagent never executes".
    const unlistenChunk = listen<AceStepLlmChunkEvent>(
      'acestep_llm_chunk',
      (event) => {
        const store = useAceStepStore.getState();
        if (
          event.payload.sessionId &&
          store.currentChatSessionId &&
          event.payload.sessionId !== store.currentChatSessionId
        ) {
          return;
        }
        store.appendChunk(event.payload.delta);
      },
    );

    const unlistenChatDone = listen<AceStepLlmDoneEvent>(
      'acestep_llm_done',
      (event) => {
        const store = useAceStepStore.getState();
        if (
          event.payload.sessionId &&
          store.currentChatSessionId &&
          event.payload.sessionId !== store.currentChatSessionId
        ) {
          return;
        }
        store.finishStreaming(
          event.payload.fullText,
          event.payload.status,
          event.payload.error,
        );
      },
    );

    // Refresh status and local model list on mount.
    useAceStepStore.getState().refreshStatus();
    useAceStepStore.getState().refreshLocalModels();
    // Load persisted sessions (auto-restores the most recent or creates new).
    useAceStepStore.getState().loadSessions();

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenDone.then((fn) => fn());
      unlistenChunk.then((fn) => fn());
      unlistenChatDone.then((fn) => fn());
    };
  }, []);
}

/**
 * Convenience hook: registers event listeners (via `useAceStepEvents`) and
 * returns the full store for components that need reactive access to all
 * state. Prefer selective `useAceStepStore(s => ...)` selectors in components
 * that only need specific slices.
 */
export function useAceStep() {
  useAceStepEvents();
  return useAceStepStore();
}
