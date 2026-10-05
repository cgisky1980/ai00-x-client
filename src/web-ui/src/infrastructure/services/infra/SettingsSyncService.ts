import {
  themeService,
  STYLE_PACK_STORAGE_KEY,
  THEME_SELECTION_STORAGE_KEY,
} from '@/infrastructure/theme';
import { i18nService } from '@/infrastructure/i18n';
import type { LocaleId } from '@/infrastructure/i18n/types';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('SettingsSyncService');

type SettingsEventType = 'theme:changed' | 'style:changed' | 'language:changed' | 'workspace:changed';

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
  private unsubResync: (() => void) | null = null;

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

    // 兜底收敛：即使 BroadcastChannel 完全失效（多 WebView2 窗口间不保证投递），
    // 本窗口在获得焦点/重新可见时也会自检并补齐风格与明暗（见 resyncFromStorage）。
    this.attachResync();
  }

  /**
   * 窗口获得焦点 / 重新可见时，直接读 localStorage 镜像（同源共享，不依赖消息投递），
   * 与当前值不一致就自行补齐。只写不广播，避免跨窗口回声。
   */
  private attachResync(): void {
    if (this.unsubResync) return;
    const resync = () => this.resyncFromStorage();
    window.addEventListener('focus', resync);
    document.addEventListener('visibilitychange', resync);
    this.unsubResync = () => {
      window.removeEventListener('focus', resync);
      document.removeEventListener('visibilitychange', resync);
    };
  }

  private resyncFromStorage(): void {
    try {
      const style = localStorage.getItem(STYLE_PACK_STORAGE_KEY);
      const currentStyle = themeService.getStylePackId();
      if (style && style !== currentStyle) {
        log.info('Resync style pack from storage', { from: currentStyle, to: style });
        void themeService.applyStylePack(style, { persist: false });
      }

      const theme = localStorage.getItem(THEME_SELECTION_STORAGE_KEY);
      const currentTheme = themeService.getCurrentThemeId();
      if (theme && theme !== currentTheme) {
        log.info('Resync theme from storage', { from: currentTheme, to: theme });
        void themeService.applyTheme(theme);
      }
    } catch (_error) {
      /* localStorage 不可用（隐私模式等）→ 跳过兜底，不影响消息通道 */
    }
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
    if (this.unsubResync) {
      this.unsubResync();
      this.unsubResync = null;
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
        case 'style:changed':
          await this.syncStylePack(message.payload as string);
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

  private async syncStylePack(stylePackId: string): Promise<void> {
    try {
      const current = themeService.getStylePackId();
      if (current === stylePackId) return;
      await themeService.applyStylePack(stylePackId);
      log.info('Synced style pack from other window', { stylePackId });
    } catch (error) {
      log.warn('Failed to sync style pack', error);
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
