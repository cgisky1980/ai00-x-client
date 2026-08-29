
import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('VramAPI');

/** Governed engine status snapshot (mirrors Rust `VramEngineStatus`). */
export interface VramEngineStatus {
  engineId: string;
  displayName: string;
  priority: number;
  contexts: string[];
  resident: boolean;
  busy: boolean;
  lastUsedMs: number;
  estimateVramMb: number | null;
  keepAliveSecs: number;
}

/** Engine residency change event payload (`vram-engine-state`). */
export interface VramEngineStateEvent {
  engineId: string;
  displayName: string;
  resident: boolean;
  reason: string;
}

/** VRAM manager API — engine registry, manual release, activity context. */
export class VramAPI {
  /** List all governed engines (dynamic; plugin engines included). */
  async listEngines(): Promise<VramEngineStatus[]> {
    try {
      return await api.invoke<VramEngineStatus[]>('vram_list_engines');
    } catch (error) {
      log.error('vram_list_engines failed', error);
      throw createTauriCommandError('vram_list_engines', error, {});
    }
  }

  /** Manually unload one engine ("release now"). */
  async evictEngine(engineId: string): Promise<void> {
    try {
      await api.invoke('vram_evict_engine', { engineId });
    } catch (error) {
      log.error('vram_evict_engine failed', error);
      throw createTauriCommandError('vram_evict_engine', error, { engineId });
    }
  }

  /** Report the current activity context (tool page switching). */
  async setActiveContext(context: string | null): Promise<void> {
    try {
      await api.invoke('vram_set_active_context', { context });
    } catch (error) {
      log.error('vram_set_active_context failed', error);
      // Non-fatal: context reporting must never break the UI.
    }
  }
}

export const vramAPI = new VramAPI();
