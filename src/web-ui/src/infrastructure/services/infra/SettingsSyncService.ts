import { themeService } from '@/infrastructure/theme';
import { i18nService } from '@/infrastructure/i18n';
import type { LocaleId } from '@/infrastructure/i18n/types';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('SettingsSyncService');

type SettingsEventType = 'theme:changed' | 'accent-hue:changed' | 'language:changed' | 'workspace:changed';

interface SettingsSyncMessage {
  type: SettingsEventType;
  source: string;
  payload: unknown;
}

const CHANNEL_NAME = 'ai00-x-settings-sync';

class SettingsSyncServiceImpl {
  private channel: BroadcastChannel | null = null;
  private windowId: string;
  private initialized = false;
  private syncing = false;
  private unsubWorkspace: (() => void) | null = null;

  constructor() {
    this.windowId = `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  start(): void {
    if (this.initialized) return;

    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent<SettingsSyncMessage>) => {
        void this.handleMessage(event.data);
      };
      this.initialized = true;
      log.info('Settings sync started', { windowId: this.windowId });
    } catch (error) {
      log.warn('BroadcastChannel not available, cross-window sync disabled', error);
    }

    this.unsubWorkspace = workspaceManager.addEventListener((event) => {
      if (event.type === 'workspace:switched' || event.type === 'workspace:active-changed') {
        const ws = event.type === 'workspace:switched'
          ? (event as { workspace: { id: string } }).workspace
          : (event as { workspace: { id: string } | null }).workspace;
        if (ws?.id) {
          this.broadcast('workspace:changed', ws.id);
        }
      }
    });
  }

  stop(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    if (this.unsubWorkspace) {
      this.unsubWorkspace();
      this.unsubWorkspace = null;
    }
    this.initialized = false;
  }

  broadcast(type: SettingsEventType, payload: unknown): void {
    if (!this.channel || this.syncing) return;
    const message: SettingsSyncMessage = {
      type,
      source: this.windowId,
      payload,
    };
    this.channel.postMessage(message);
  }

  private async handleMessage(message: SettingsSyncMessage): Promise<void> {
    if (!message || message.source === this.windowId) return;

    log.info('Received settings sync', { type: message.type, source: message.source });

    this.syncing = true;
    try {
      switch (message.type) {
        case 'theme:changed':
          await this.syncTheme(message.payload as string);
          break;
        case 'accent-hue:changed':
          await this.syncAccentHue(message.payload as number);
          break;
        case 'language:changed':
          await this.syncLanguage(message.payload as string);
          break;
        case 'workspace:changed':
          await this.syncWorkspace(message.payload as string);
          break;
      }
    } finally {
      this.syncing = false;
    }
  }

  private async syncTheme(themeId: string): Promise<void> {
    try {
      const current = themeService.getCurrentThemeId();
      if (current === themeId) return;
      await themeService.applyTheme(themeId);
      log.info('Synced theme from other window', { themeId });
    } catch (error) {
      log.warn('Failed to sync theme', error);
    }
  }

  private async syncAccentHue(hue: number): Promise<void> {
    try {
      const current = themeService.getAccentHue();
      if (current === hue) return;
      await themeService.setAccentHue(hue);
      log.info('Synced accent hue from other window', { hue });
    } catch (error) {
      log.warn('Failed to sync accent hue', error);
    }
  }

  private async syncLanguage(locale: string): Promise<void> {
    try {
      const current = i18nService.getCurrentLocale();
      if (current === locale) return;
      await i18nService.changeLanguage(locale as LocaleId);
      log.info('Synced language from other window', { locale });
    } catch (error) {
      log.warn('Failed to sync language', error);
    }
  }

  private async syncWorkspace(workspaceId: string): Promise<void> {
    try {
      const state = workspaceManager.getState();
      if (state.activeWorkspaceId === workspaceId) return;
      await workspaceManager.setActiveWorkspace(workspaceId);
      log.info('Synced workspace from other window', { workspaceId });
    } catch (error) {
      log.warn('Failed to sync workspace', error);
    }
  }
}

export const settingsSyncService = new SettingsSyncServiceImpl();
