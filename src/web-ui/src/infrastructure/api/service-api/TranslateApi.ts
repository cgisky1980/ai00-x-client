import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';

export interface TranslateTextRequest {
  text: string;
}

export interface TranslateTextResponse {
  translated: string;
  fromLang: string;
  toLang: string;
  elapsedMs: number;
}

/**
 * Selection translate: one-shot local RWKV translation. The target language
 * follows the configured UI language (`app.language`) on the Rust side.
 */
export class TranslateApi {
  async translate(request: TranslateTextRequest): Promise<TranslateTextResponse> {
    try {
      return await api.invoke<TranslateTextResponse>('translate_text', { request });
    } catch (error) {
      throw createTauriCommandError('translate_text', error, request);
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    try {
      await api.invoke('translate_set_enabled', { enabled });
    } catch (error) {
      throw createTauriCommandError('translate_set_enabled', error);
    }
  }

  async getEnabled(): Promise<boolean> {
    try {
      return await api.invoke<boolean>('translate_get_enabled');
    } catch (error) {
      throw createTauriCommandError('translate_get_enabled', error);
    }
  }
}

export const translateApi = new TranslateApi();
