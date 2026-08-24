 
import {
  ThemeConfig,
  ThemeId,
  ThemeMetadata,
  ThemeExport,
  ThemeValidationResult,
  ThemeEventType,
  ThemeEvent,
  ThemeEventListener,
  ThemeHooks,
  SYSTEM_THEME_ID,
  ThemeSelectionId,
} from '../types';
import {
  builtinThemes,
  getSystemPreferredDefaultThemeId,
  LEGACY_BUILTIN_THEME_FALLBACK,
} from '../presets';
import { configAPI } from '@/infrastructure/api';
import { monacoThemeSync } from '../integrations/MonacoThemeSync';
import { hueFromAccentColor, DEFAULT_ACCENT_HUE } from '../utils/accentGenerator';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ThemeService');

export class ThemeService {
  private themes: Map<ThemeId, ThemeConfig> = new Map();
  /** User choice from settings (including follow-system). */
  private themeSelection: ThemeSelectionId = SYSTEM_THEME_ID;
  /** Currently applied built-in or custom theme (never `system`). */
  private resolvedThemeId: ThemeId = getSystemPreferredDefaultThemeId();
  private systemThemeCleanup: (() => void) | null = null;
  private listeners: Map<ThemeEventType, Set<ThemeEventListener>> = new Map();
  private hooks: ThemeHooks = {};
  private _accentHue: number = DEFAULT_ACCENT_HUE;
  private _accentOverride: boolean = false;
  
  constructor() {
    this.initializeBuiltinThemes();
  }
  
  
  
   
  private initializeBuiltinThemes(): void {
    builtinThemes.forEach(theme => {
      this.themes.set(theme.id, theme);
    });
    log.info('Loaded builtin themes', { count: builtinThemes.length });
  }
  
   
  async initialize(): Promise<void> {
    try {
      const saved = await this.loadThemeSelection();

      if (saved === SYSTEM_THEME_ID) {
        await this.applyTheme(SYSTEM_THEME_ID);
      } else if (saved && this.themes.has(saved)) {
        await this.applyTheme(saved);
      } else if (saved && LEGACY_BUILTIN_THEME_FALLBACK[saved]) {
        // 裁撤的多风格预设（slate/midnight/china/cyber）→ 平滑落到同明暗档
        log.info('Migrating legacy builtin theme', { from: saved, to: LEGACY_BUILTIN_THEME_FALLBACK[saved] });
        await this.applyTheme(LEGACY_BUILTIN_THEME_FALLBACK[saved]);
      } else {
        const preInjectedThemeId = document.documentElement.getAttribute('data-theme');
        const migratedPreInjected = preInjectedThemeId && LEGACY_BUILTIN_THEME_FALLBACK[preInjectedThemeId]
          ? LEGACY_BUILTIN_THEME_FALLBACK[preInjectedThemeId]
          : preInjectedThemeId;
        if (migratedPreInjected && this.themes.has(migratedPreInjected as ThemeId)) {
          await this.applyTheme(migratedPreInjected as ThemeId);
        } else {
          await this.applyTheme(SYSTEM_THEME_ID);
        }
      }

      const savedHue = await this.loadAccentHue();
      if (savedHue >= 0) {
        this._accentHue = savedHue;
        this._accentOverride = true;
        this.applyOklchHue(savedHue);
      } else {
        const currentTheme = this.getCurrentTheme();
        this._accentHue = hueFromAccentColor(currentTheme.colors.accent[500]);
        this.applyOklchHue(this._accentHue);
      }

      this.loadUserThemes().catch(() => {
        
      });
    } catch (error) {
      log.error('Theme system initialization failed', error);
      
      await this.applyTheme(SYSTEM_THEME_ID);
    }
  }
  
   
  private async loadUserThemes(): Promise<void> {
    try {
      // Read the whole themes section so missing optional `custom` does not surface
      // as an expected backend error during startup.
      const themesConfig = await configAPI.getConfig('themes', {
        skipRetryOnNotFound: true,
      }) as { custom?: ThemeConfig[] } | undefined;
      const themes = themesConfig?.custom;
      
      if (Array.isArray(themes) && themes.length > 0) {
        themes.forEach(theme => {
          this.themes.set(theme.id, theme);
        });
        log.info('Loaded user themes', { count: themes.length });
      }
    } catch (_error) {
      
    }
  }
  
   
  private async loadThemeSelection(): Promise<ThemeSelectionId | null> {
    try {
      
      const raw = await configAPI.getConfig('themes.current', {
        skipRetryOnNotFound: true
      }) as string | undefined;
      
      if (raw === SYSTEM_THEME_ID) {
        return SYSTEM_THEME_ID;
      }
      return raw || null;
    } catch (_error) {
      return null;
    }
  }
  
  
  
   
  registerTheme(theme: ThemeConfig): void {
    if (theme.id === SYSTEM_THEME_ID) {
      log.error('Reserved theme id', { id: theme.id });
      throw new Error(`Theme id "${SYSTEM_THEME_ID}" is reserved`);
    }
    if (this.themes.has(theme.id)) {
      log.warn('Theme already exists, will override', { id: theme.id });
    }
    
    this.themes.set(theme.id, theme);
    this.emitEvent('theme:register', theme.id, theme);
    log.info('Theme registered', { id: theme.id, name: theme.name });
  }
  
   
  unregisterTheme(themeId: ThemeId): boolean {
    const theme = this.themes.get(themeId);
    if (!theme) {
      log.warn('Theme not found', { id: themeId });
      return false;
    }
    
    
    const isBuiltin = builtinThemes.some(t => t.id === themeId);
    if (isBuiltin) {
      log.error('Cannot delete builtin theme', { id: themeId });
      return false;
    }
    
    
    if (this.themeSelection === themeId) {
      void this.applyTheme(SYSTEM_THEME_ID);
    }
    
    this.themes.delete(themeId);
    this.emitEvent('theme:unregister', themeId, theme);
    log.info('Theme unregistered', { id: themeId, name: theme.name });
    
    
    this.saveUserThemes();
    
    return true;
  }
  
   
  getTheme(themeId: ThemeId): ThemeConfig | undefined {
    return this.themes.get(themeId);
  }
  
   
  getCurrentTheme(): ThemeConfig {
    return this.themes.get(this.resolvedThemeId) || builtinThemes[0];
  }
  
   
  /** User selection for UI (may be `system`). */
  getCurrentThemeId(): ThemeSelectionId {
    return this.themeSelection;
  }

  /** Actually applied theme id (never `system`). */
  getResolvedThemeId(): ThemeId {
    return this.resolvedThemeId;
  }

  getAccentHue(): number {
    return this._accentHue;
  }

  isAccentOverride(): boolean {
    return this._accentOverride;
  }

  private accentHueSaveTimer: ReturnType<typeof setTimeout> | null = null;

  async setAccentHue(hue: number): Promise<void> {
    this._accentHue = hue;
    this._accentOverride = true;
    // 立即应用 CSS，视觉无延迟
    this.applyOklchHue(hue);

    // Debounce 配置保存 + 事件广播，避免滑条拖动时后端刷屏
    // 也不发 theme:after-change 事件 — store 已直接设置 accentHue，
    // 事件会触发监听器重新读取 service 覆盖更新的值，导致跳动
    if (this.accentHueSaveTimer) clearTimeout(this.accentHueSaveTimer);
    this.accentHueSaveTimer = setTimeout(() => {
      this.saveAccentHue(hue).catch(() => {});
      import('@/infrastructure/services/infra/SettingsSyncService').then(({ settingsSyncService }) => {
        settingsSyncService.broadcast('accent-hue:changed', hue);
      }).catch(() => {});
    }, 300);
  }

  async clearAccentOverride(): Promise<void> {
    this._accentOverride = false;
    await this.saveAccentHue(-1);
    const currentTheme = this.getCurrentTheme();
    this._accentHue = hueFromAccentColor(currentTheme.colors.accent[500]);
    this.applyOklchHue(this._accentHue);
    this.emitEvent('theme:after-change', this.resolvedThemeId, currentTheme, currentTheme);
    import('@/infrastructure/services/infra/SettingsSyncService').then(({ settingsSyncService }) => {
      settingsSyncService.broadcast('accent-hue:changed', -1);
    });
  }

  private applyOklchHue(hue: number): void {
    const root = document.documentElement;
    const themeType = root.getAttribute('data-theme-type');
    const chroma = themeType === 'dark' ? 0.20 : 0.12;
    root.style.setProperty('--hue', String(Math.max(0, hue)));
    if (hue < 0) {
      const grayLevel = Math.abs(hue) / 90;
      root.style.setProperty('--chroma', '0');
      root.style.setProperty('--gray-level', String(Math.min(1, grayLevel)));
    } else {
      root.style.setProperty('--chroma', String(chroma));
      root.style.setProperty('--gray-level', '0');
    }
  }
  
   
  getThemeList(): ThemeMetadata[] {
    return Array.from(this.themes.values()).map(theme => ({
      id: theme.id,
      name: theme.name,
      type: theme.type,
      description: theme.description,
      author: theme.author,
      version: theme.version,
      builtin: builtinThemes.some(t => t.id === theme.id),
    }));
  }
  
  
  
   
  private detachSystemThemeListener(): void {
    if (this.systemThemeCleanup) {
      this.systemThemeCleanup();
      this.systemThemeCleanup = null;
    }
  }

  private attachSystemThemeListener(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    if (this.systemThemeCleanup) {
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (this.themeSelection !== SYSTEM_THEME_ID) {
        return;
      }
      const next = getSystemPreferredDefaultThemeId();
      if (next === this.resolvedThemeId) {
        return;
      }
      void this.applyResolvedTheme(next);
    };
    mq.addEventListener('change', handler);
    this.systemThemeCleanup = () => mq.removeEventListener('change', handler);
  }

  private async applyResolvedTheme(resolvedId: ThemeId): Promise<void> {
    const theme = this.themes.get(resolvedId);
    if (!theme) {
      log.error('Theme not found', { id: resolvedId });
      throw new Error(`Theme ${resolvedId} not found`);
    }

    const oldTheme = this.getCurrentTheme();

    try {
      if (this.hooks.beforeChange) {
        await this.hooks.beforeChange(theme, oldTheme);
      }
      this.emitEvent('theme:before-change', resolvedId, theme, oldTheme);

      this.resolvedThemeId = resolvedId;

      this.injectCSSVariables(theme);

      if (this._accentOverride) {
        this.applyOklchHue(this._accentHue);
      } else {
        this._accentHue = hueFromAccentColor(theme.colors.accent[500]);
        this.applyOklchHue(this._accentHue);
      }

      try {
        monacoThemeSync.syncTheme(theme);
      } catch (error) {
        log.warn('Monaco Editor theme sync failed', error);
      }

      if (this.hooks.afterChange) {
        await this.hooks.afterChange(theme, oldTheme);
      }
      this.emitEvent('theme:after-change', resolvedId, theme, oldTheme);

      log.info('Theme applied', { id: resolvedId, name: theme.name, selection: this.themeSelection });
    } catch (error) {
      log.error('Failed to apply theme', error);
      throw error;
    }
  }

  async applyTheme(themeId: ThemeId | typeof SYSTEM_THEME_ID): Promise<void> {
    if (themeId !== SYSTEM_THEME_ID && !this.themes.has(themeId)) {
      log.error('Theme not found', { id: themeId });
      throw new Error(`Theme ${themeId} not found`);
    }

    this.detachSystemThemeListener();

    if (themeId === SYSTEM_THEME_ID) {
      this.themeSelection = SYSTEM_THEME_ID;
      await this.saveThemeSelection(SYSTEM_THEME_ID);
      this.attachSystemThemeListener();
      const resolved = getSystemPreferredDefaultThemeId();
      await this.applyResolvedTheme(resolved);
    } else {
      this.themeSelection = themeId;
      await this.saveThemeSelection(themeId);
      await this.applyResolvedTheme(themeId);
    }

    import('@/infrastructure/services/infra/SettingsSyncService').then(({ settingsSyncService }) => {
      settingsSyncService.broadcast('theme:changed', themeId);
    });
  }
  
   
  private injectCSSVariables(theme: ThemeConfig): void {
    const root = document.documentElement;
    const { colors, effects, motion, typography } = theme;

    if (colors.background.tooltip) {
      root.style.setProperty('--color-bg-tooltip', colors.background.tooltip);
    }

    if (colors.scrollbar) {
      root.style.setProperty('--scrollbar-thumb', colors.scrollbar.thumb);
      root.style.setProperty('--scrollbar-thumb-hover', colors.scrollbar.thumbHover);
    }

    if (colors.purple) {
      Object.entries(colors.purple).forEach(([key, value]) => {
        root.style.setProperty(`--color-purple-${key}`, value);
      });
    }

    root.style.setProperty('--color-success', colors.semantic.success);
    root.style.setProperty('--color-success-bg', colors.semantic.successBg);
    root.style.setProperty('--color-success-border', colors.semantic.successBorder);
    root.style.setProperty('--color-warning', colors.semantic.warning);
    root.style.setProperty('--color-warning-bg', colors.semantic.warningBg);
    root.style.setProperty('--color-warning-border', colors.semantic.warningBorder);
    root.style.setProperty('--color-error', colors.semantic.error);
    root.style.setProperty('--color-error-bg', colors.semantic.errorBg);
    root.style.setProperty('--color-error-border', colors.semantic.errorBorder);
    root.style.setProperty('--color-info', colors.semantic.info);
    root.style.setProperty('--color-info-bg', colors.semantic.infoBg);
    root.style.setProperty('--color-info-border', colors.semantic.infoBorder);
    root.style.setProperty('--color-highlight', colors.semantic.highlight);
    root.style.setProperty('--color-highlight-bg', colors.semantic.highlightBg);

    if (colors.purple) {
      root.style.setProperty('--border-purple-subtle', colors.purple[200]);
      root.style.setProperty('--border-purple', colors.purple[400]);
    }

    const sceneViewportBorder = theme.layout?.sceneViewportBorder ?? true;
    root.style.setProperty(
      '--scene-viewport-border-width',
      sceneViewportBorder ? '1px' : '0'
    );

    root.style.setProperty('--git-color-branch', colors.git.branch);
    root.style.setProperty('--git-color-branch-bg', colors.git.branchBg);
    root.style.setProperty('--git-color-branch-bg-hover', colors.git.branchBg);
    root.style.setProperty('--git-color-branch-border', colors.git.branchBg);
    root.style.setProperty('--git-color-changes', colors.git.changes);
    root.style.setProperty('--git-color-changes-bg', colors.git.changesBg);
    root.style.setProperty('--git-color-changes-bg-hover', colors.git.changesBg);
    root.style.setProperty('--git-color-changes-border', colors.git.changesBg);
    root.style.setProperty('--git-color-added', colors.git.added);
    root.style.setProperty('--git-color-added-bg', colors.git.addedBg);
    root.style.setProperty('--git-color-added-bg-hover', colors.git.addedBg);
    root.style.setProperty('--git-color-deleted', colors.git.deleted);
    root.style.setProperty('--git-color-deleted-bg', colors.git.deletedBg);
    root.style.setProperty('--git-color-deleted-bg-hover', colors.git.deletedBg);
    root.style.setProperty('--git-color-deleted-border', colors.git.deletedBg);
    root.style.setProperty('--git-color-staged', colors.git.staged);
    root.style.setProperty('--git-color-staged-bg', colors.git.stagedBg);
    root.style.setProperty('--git-color-staged-bg-hover', colors.git.stagedBg);
    root.style.setProperty('--git-color-staged-border', colors.git.stagedBg);
    root.style.setProperty('--git-color-pull', colors.git.branch);
    root.style.setProperty('--git-color-pull-bg', colors.git.branchBg);
    root.style.setProperty('--git-color-pull-bg-hover', colors.git.branchBg);
    root.style.setProperty('--git-color-push', colors.git.staged);
    root.style.setProperty('--git-color-push-bg', colors.git.stagedBg);
    root.style.setProperty('--git-color-push-bg-hover', colors.git.stagedBg);

    if (effects?.shadow) {
      Object.entries(effects.shadow).forEach(([key, value]) => {
        root.style.setProperty(`--shadow-${key}`, value);
      });
    }

    if (effects?.glow) {
      root.style.setProperty('--glow-purple', effects.glow.purple);
      root.style.setProperty('--glow-mixed', effects.glow.mixed);
      root.style.setProperty('--glow-shadow-purple', effects.glow.purple);
      root.style.setProperty('--glow-shadow-mixed', effects.glow.mixed);
    }

    if (effects?.blur) {
      Object.entries(effects.blur).forEach(([key, value]) => {
        root.style.setProperty(`--blur-${key}`, value);
      });
    }

    if (effects?.radius) {
      Object.entries(effects.radius).forEach(([key, value]) => {
        root.style.setProperty(`--radius-${key}`, value);
        root.style.setProperty(`--size-radius-${key}`, value);
      });
    }

    if (effects?.spacing) {
      Object.entries(effects.spacing).forEach(([key, value]) => {
        root.style.setProperty(`--spacing-${key}`, value);
        root.style.setProperty(`--size-gap-${key}`, value);
      });
    }

    if (effects?.opacity) {
      root.style.setProperty('--opacity-disabled', String(effects.opacity.disabled));
      root.style.setProperty('--opacity-hover', String(effects.opacity.hover));
      root.style.setProperty('--opacity-focus', String(effects.opacity.focus));
      root.style.setProperty('--opacity-overlay', String(effects.opacity.overlay));
    }

    if (motion?.duration) {
      Object.entries(motion.duration).forEach(([key, value]) => {
        root.style.setProperty(`--motion-${key}`, value);
      });
    }

    if (motion?.easing) {
      Object.entries(motion.easing).forEach(([key, value]) => {
        root.style.setProperty(`--easing-${key}`, value);
      });
    }

    if (typography?.font) {
      root.style.setProperty('--font-sans', typography.font.sans);
      root.style.setProperty('--font-mono', typography.font.mono);
      root.style.setProperty('--font-family-sans', typography.font.sans);
      root.style.setProperty('--font-family-mono', typography.font.mono);
    }

    if (typography?.weight) {
      Object.entries(typography.weight).forEach(([key, value]) => {
        root.style.setProperty(`--font-weight-${key}`, String(value));
      });
    }

    if (typography?.size) {
      Object.entries(typography.size).forEach(([key, value]) => {
        root.style.setProperty(`--font-size-${key}`, value);
      });
    }

    if (typography?.lineHeight) {
      Object.entries(typography.lineHeight).forEach(([key, value]) => {
        root.style.setProperty(`--line-height-${key}`, String(value));
      });
    }

    const windowControlsConfig = theme.components?.windowControls;
    if (windowControlsConfig) {
      root.style.setProperty('--window-control-close-dot', windowControlsConfig.close.dot);
      root.style.setProperty('--window-control-close-dot-shadow', windowControlsConfig.close.dotShadow || 'none');
      root.style.setProperty('--window-control-close-hover-bg', windowControlsConfig.close.hoverBg);
      root.style.setProperty('--window-control-close-hover-color', windowControlsConfig.close.hoverColor);
      root.style.setProperty('--window-control-close-hover-border', windowControlsConfig.close.hoverBorder);
      root.style.setProperty('--window-control-close-hover-shadow', windowControlsConfig.close.hoverShadow || 'none');
      root.style.setProperty('--window-control-default-color', windowControlsConfig.common.defaultColor);
      root.style.setProperty('--window-control-default-dot', windowControlsConfig.common.defaultDot);
      root.style.setProperty('--window-control-disabled-dot', windowControlsConfig.common.disabledDot);
      root.style.setProperty('--window-control-flow-gradient', windowControlsConfig.common.flowGradient || 'none');
    } else {
      root.style.setProperty('--window-control-close-dot', colors.semantic.error);
      root.style.setProperty('--window-control-close-dot-shadow', 'none');
      root.style.setProperty('--window-control-close-hover-bg', colors.semantic.errorBg);
      root.style.setProperty('--window-control-close-hover-color', colors.semantic.error);
      root.style.setProperty('--window-control-close-hover-border', colors.semantic.errorBorder);
      root.style.setProperty('--window-control-close-hover-shadow', 'none');
      root.style.setProperty('--window-control-default-color', colors.text.primary);
      root.style.setProperty('--window-control-default-dot', colors.text.muted);
      root.style.setProperty('--window-control-disabled-dot', colors.text.disabled);
      root.style.setProperty('--window-control-flow-gradient', 'none');
    }

    root.setAttribute('data-theme', theme.id);
    root.setAttribute('data-theme-type', theme.type);
  }
  
   
  private async saveThemeSelection(selection: ThemeSelectionId): Promise<void> {
    try {
      await configAPI.setConfig('themes.current', selection);
    } catch (error) {
      log.warn('Failed to save current theme ID', error);
    }
  }

  private async saveAccentHue(hue: number): Promise<void> {
    try {
      await configAPI.setConfig('themes.accentHue', hue);
    } catch (error) {
      log.warn('Failed to save accent hue', error);
    }
  }

  private async loadAccentHue(): Promise<number> {
    try {
      const raw = await configAPI.getConfig('themes.accentHue', {
        skipRetryOnNotFound: true,
      }) as number | undefined;
      if (typeof raw === 'number') return raw;
      return -1;
    } catch (_error) {
      return -1;
    }
  }

  private async saveUserThemes(): Promise<void> {
    try {
      const userThemes = Array.from(this.themes.values()).filter(
        theme => !builtinThemes.some(t => t.id === theme.id)
      );
      await configAPI.setConfig('themes.custom', userThemes);
    } catch (error) {
      log.warn('Failed to save user themes', error);
    }
  }
  
  
  
   
  exportTheme(themeId: ThemeId): ThemeExport | null {
    const theme = this.themes.get(themeId);
    if (!theme) {
      log.error('Theme not found', { id: themeId });
      return null;
    }
    
    const metadata: ThemeMetadata = {
      id: theme.id,
      name: theme.name,
      type: theme.type,
      description: theme.description,
      author: theme.author,
      version: theme.version,
      builtin: builtinThemes.some(t => t.id === theme.id),
    };
    
    return {
      schema: '2.0.0',
      theme,
      metadata,
      exportedAt: new Date().toISOString(),
    };
  }
  
  
  
   
  validateTheme(theme: ThemeConfig): ThemeValidationResult {
    const errors: ThemeValidationResult['errors'] = [];
    const warnings: ThemeValidationResult['warnings'] = [];
    
    
    if (!theme.id) {
      errors.push({ path: 'id', message: 'Missing theme id', code: 'MISSING_ID' });
    }
    if (!theme.name) {
      errors.push({ path: 'name', message: 'Missing theme name', code: 'MISSING_NAME' });
    }
    if (!theme.type || !['dark', 'light'].includes(theme.type)) {
      errors.push({ path: 'type', message: 'Invalid theme type', code: 'INVALID_TYPE' });
    }
    
    
    if (!theme.colors) {
      errors.push({ path: 'colors', message: 'Missing color configuration', code: 'MISSING_COLORS' });
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
  
  
  
   
  on(eventType: ThemeEventType, listener: ThemeEventListener): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    
    this.listeners.get(eventType)!.add(listener);
    
    
    return () => {
      this.listeners.get(eventType)?.delete(listener);
    };
  }
  
   
  private emitEvent(
    type: ThemeEventType,
    themeId: ThemeId,
    theme?: ThemeConfig,
    previousTheme?: ThemeConfig
  ): void {
    const event: ThemeEvent = {
      type,
      themeId,
      theme,
      previousTheme,
      timestamp: Date.now(),
    };
    
    const listeners = this.listeners.get(type);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(event);
        } catch (error) {
          log.error('Event listener execution failed', { type, error });
        }
      });
    }
  }
  
  
  
   
  registerHooks(hooks: ThemeHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }
}


export const themeService = new ThemeService();

