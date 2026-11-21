/**
 * ThemeService —— 皮肤 × 明暗（规范 v1.0 第二节）
 *
 * 两个选择，各自持久化：
 *   明暗：themes.current = 'ai00-x-dark' | 'ai00-x-light' | 'system'
 *   皮肤：themes.skin    = 内置皮肤 id 或用户皮肤 id（用户皮肤存 themes.skins: Skin[]）
 *
 * 生效方式只有「属性 + 样式表」，**不写任何 inline 变量**：
 *   <html data-skin data-theme data-theme-type data-buttons data-radius data-motion>
 *   内置皮肤的种子块已在 design-system css/skins.css 里；
 *   用户皮肤由 skinCss() 生成后写入唯一的 <style id="ai00-skin">。
 * 所有 token 都是 var(--skin-*) 的派生公式，换种子即整体换肤。
 */
import {
  ThemeConfig,
  ThemeId,
  ThemeMetadata,
  ThemeEventType,
  ThemeEvent,
  ThemeEventListener,
  ThemeHooks,
  SYSTEM_THEME_ID,
  ThemeSelectionId,
} from '../types';
import {
  BUILTIN_THEME_IDS,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  getSystemPreferredDefaultThemeId,
  LEGACY_BUILTIN_THEME_FALLBACK,
  modeOfThemeId,
  themeConfigFromSkin,
} from '../presets';
import { configAPI } from '@/infrastructure/api';
import { monacoThemeSync } from '../integrations/MonacoThemeSync';
import { createLogger } from '@/shared/utils/logger';
import {
  builtinSkins,
  checkSkin,
  DEFAULT_SKIN_ID,
  parseSkin,
  skinAttributes,
  skinCss,
  type Skin,
} from '@ai00-x/design-system/skin';

const log = createLogger('ThemeService');

/**
 * 选择项的 localStorage 镜像键：多 WebView2 窗口间 BroadcastChannel 不保证送达，
 * 窗口获得焦点时据此自检收敛（SettingsSyncService.resyncFromStorage）。
 */
export const SKIN_STORAGE_KEY = 'ai00-x:skin';
export const THEME_SELECTION_STORAGE_KEY = 'ai00-x:theme-selection';

const USER_SKIN_STYLE_ID = 'ai00-skin';

function mirrorToStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (_error) {
    /* 镜像只是兜底通道 */
  }
}

const isBuiltinSkin = (id: string) => builtinSkins.some((s) => s.id === id);

export class ThemeService {
  /** 设置里的明暗选择（可为 system） */
  private themeSelection: ThemeSelectionId = SYSTEM_THEME_ID;
  /** 实际生效的明暗档 id（不会是 system） */
  private resolvedThemeId: ThemeId = getSystemPreferredDefaultThemeId();
  private skinId: string = DEFAULT_SKIN_ID;
  private userSkins: Skin[] = [];
  private currentTheme: ThemeConfig;
  private systemThemeCleanup: (() => void) | null = null;
  private listeners: Map<ThemeEventType, Set<ThemeEventListener>> = new Map();
  private hooks: ThemeHooks = {};
  /** initialize 幂等守卫（入口与 themeStore 都会调） */
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.currentTheme = themeConfigFromSkin(this.getSkin(), modeOfThemeId(this.resolvedThemeId));
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      await this.loadUserSkins();
      this.skinId = await this.loadSkinSelection();

      const saved = await this.loadThemeSelection();
      if (saved === SYSTEM_THEME_ID || !saved) {
        await this.applyTheme(SYSTEM_THEME_ID);
      } else if (BUILTIN_THEME_IDS.includes(saved)) {
        await this.applyTheme(saved);
      } else if (LEGACY_BUILTIN_THEME_FALLBACK[saved]) {
        log.info('Migrating legacy builtin theme', { from: saved, to: LEGACY_BUILTIN_THEME_FALLBACK[saved] });
        await this.applyTheme(LEGACY_BUILTIN_THEME_FALLBACK[saved]);
      } else {
        // 旧版自定义 ThemeConfig id：按其明暗档落位
        const legacy = await this.legacyCustomThemeType(saved);
        await this.applyTheme(legacy === 'light' ? DEFAULT_LIGHT_THEME_ID : legacy === 'dark' ? DEFAULT_DARK_THEME_ID : SYSTEM_THEME_ID);
      }
    } catch (error) {
      log.error('Theme system initialization failed', error);
      await this.applyTheme(SYSTEM_THEME_ID);
    }
  }

  /* ---------------- 读写配置 ---------------- */

  private async loadThemeSelection(): Promise<ThemeSelectionId | null> {
    try {
      const raw = (await configAPI.getConfig('themes.current', { skipRetryOnNotFound: true })) as string | undefined;
      return raw || null;
    } catch (_error) {
      return null;
    }
  }

  private async legacyCustomThemeType(id: string): Promise<'dark' | 'light' | null> {
    try {
      const custom = (await configAPI.getConfig('themes.custom', { skipRetryOnNotFound: true })) as
        | Array<{ id?: string; type?: string }>
        | undefined;
      const hit = Array.isArray(custom) ? custom.find((t) => t?.id === id) : undefined;
      return hit?.type === 'light' || hit?.type === 'dark' ? hit.type : null;
    } catch (_error) {
      return null;
    }
  }

  private async saveThemeSelection(selection: ThemeSelectionId): Promise<void> {
    mirrorToStorage(THEME_SELECTION_STORAGE_KEY, selection);
    try {
      await configAPI.setConfig('themes.current', selection);
    } catch (error) {
      log.warn('Failed to save current theme ID', error);
    }
  }

  /** 皮肤选择；旧版 themes.style（风格包）一律落到默认皮肤 */
  private async loadSkinSelection(): Promise<string> {
    try {
      const raw = await configAPI.getConfig('themes.skin', { skipRetryOnNotFound: true });
      if (typeof raw === 'string' && this.hasSkin(raw)) return raw;
    } catch (_error) {
      /* 未设置 */
    }
    return DEFAULT_SKIN_ID;
  }

  private async saveSkinSelection(id: string): Promise<void> {
    mirrorToStorage(SKIN_STORAGE_KEY, id);
    try {
      await configAPI.setConfig('themes.skin', id);
    } catch (error) {
      log.warn('Failed to save skin id', error);
    }
  }

  /** 读用户皮肤（逐个 parse；坏数据丢弃并记日志，不阻断启动） */
  async loadUserSkins(): Promise<void> {
    try {
      const raw = await configAPI.getConfig('themes.skins', { skipRetryOnNotFound: true });
      const list = Array.isArray(raw) ? raw : [];
      this.userSkins = list.flatMap((item) => {
        const { skin, errors } = parseSkin(item);
        if (!skin || isBuiltinSkin(skin.id)) {
          if (errors.length) log.warn('Dropped invalid user skin', { errors });
          return [];
        }
        return [skin];
      });
    } catch (_error) {
      this.userSkins = [];
    }
  }

  private async saveUserSkins(): Promise<void> {
    try {
      await configAPI.setConfig('themes.skins', this.userSkins);
    } catch (error) {
      log.warn('Failed to save user skins', error);
    }
  }

  /* ---------------- 皮肤 ---------------- */

  getSkinId(): string {
    return this.skinId;
  }

  getSkin(id: string = this.skinId): Skin {
    return (
      this.userSkins.find((s) => s.id === id) ??
      builtinSkins.find((s) => s.id === id) ??
      builtinSkins.find((s) => s.id === DEFAULT_SKIN_ID)!
    );
  }

  hasSkin(id: string): boolean {
    return isBuiltinSkin(id) || this.userSkins.some((s) => s.id === id);
  }

  isBuiltinSkin(id: string): boolean {
    return isBuiltinSkin(id);
  }

  /** 内置在前、用户皮肤在后 */
  getSkins(): Skin[] {
    return [...builtinSkins, ...this.userSkins];
  }

  async applySkin(id: string, options: { persist?: boolean } = {}): Promise<void> {
    const next = this.hasSkin(id) ? id : DEFAULT_SKIN_ID;
    const persist = options.persist !== false;
    this.skinId = next;
    if (persist) await this.saveSkinSelection(next);
    this.render();
    this.emitEvent('skin:after-change', this.resolvedThemeId, this.currentTheme);
    log.info('Skin applied', { id: next, persisted: persist });
    if (persist) {
      import('@/infrastructure/services/infra/SettingsSyncService').then(({ settingsSyncService }) => {
        settingsSyncService.broadcast('skin:changed', next);
      });
    }
  }

  /**
   * 保存（新建或覆盖）一份用户皮肤。对比度 error 拒绝保存；内置 id 不可覆盖。
   * 返回规范化后的皮肤。
   */
  async saveUserSkin(raw: unknown): Promise<Skin> {
    const { skin, errors } = parseSkin(raw);
    if (!skin) throw new Error(errors.join('\n'));
    if (isBuiltinSkin(skin.id)) throw new Error(`「${skin.id}」是内置皮肤 id，请换一个`);
    const bad = checkSkin(skin).filter((i) => i.level === 'error');
    if (bad.length) {
      throw new Error(bad.map((i) => `${i.mode === 'dark' ? '暗色' : '亮色'}·${i.label} ${i.ratio.toFixed(2)} < ${i.min}`).join('\n'));
    }
    const idx = this.userSkins.findIndex((s) => s.id === skin.id);
    if (idx >= 0) this.userSkins[idx] = skin;
    else this.userSkins.push(skin);
    await this.saveUserSkins();
    if (this.skinId === skin.id) this.render();
    this.emitEvent('skin:register', this.resolvedThemeId, this.currentTheme);
    this.broadcastSkinsChanged();
    return skin;
  }

  async deleteUserSkin(id: string): Promise<boolean> {
    if (isBuiltinSkin(id)) return false;
    const before = this.userSkins.length;
    this.userSkins = this.userSkins.filter((s) => s.id !== id);
    if (this.userSkins.length === before) return false;
    await this.saveUserSkins();
    if (this.skinId === id) await this.applySkin(DEFAULT_SKIN_ID);
    this.emitEvent('skin:unregister', this.resolvedThemeId, this.currentTheme);
    this.broadcastSkinsChanged();
    return true;
  }

  /** 导出为 .ai00skin.json 文本 */
  exportSkin(id: string): string {
    const { format, ...rest } = this.getSkin(id);
    return `${JSON.stringify({ format, ...rest }, null, 2)}\n`;
  }

  private broadcastSkinsChanged(): void {
    import('@/infrastructure/services/infra/SettingsSyncService').then(({ settingsSyncService }) => {
      settingsSyncService.broadcast('skins:changed', this.skinId);
    });
  }

  /** 其他窗口改了用户皮肤：重读配置并重绘 */
  async reloadUserSkins(): Promise<void> {
    await this.loadUserSkins();
    if (!this.hasSkin(this.skinId)) this.skinId = DEFAULT_SKIN_ID;
    this.render();
    this.emitEvent('skin:register', this.resolvedThemeId, this.currentTheme);
  }

  /**
   * 预览：把一份未保存的皮肤临时套到界面上（编辑器实时预览用）。传 null 结束预览。
   * 不持久化、不广播。
   */
  previewSkin(skin: Skin | null): void {
    this.render(skin ?? undefined);
  }

  /* ---------------- 明暗 ---------------- */

  getCurrentTheme(): ThemeConfig {
    return this.currentTheme;
  }

  /** 设置里的选择（可为 system） */
  getCurrentThemeId(): ThemeSelectionId {
    return this.themeSelection;
  }

  getResolvedThemeId(): ThemeId {
    return this.resolvedThemeId;
  }

  getThemeList(): ThemeMetadata[] {
    return [DEFAULT_LIGHT_THEME_ID, DEFAULT_DARK_THEME_ID].map((id) => {
      const t = themeConfigFromSkin(this.getSkin(), modeOfThemeId(id));
      return { id, name: id === DEFAULT_DARK_THEME_ID ? 'Dark' : 'Light', type: t.type, builtin: true };
    });
  }

  private detachSystemThemeListener(): void {
    this.systemThemeCleanup?.();
    this.systemThemeCleanup = null;
  }

  private attachSystemThemeListener(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function' || this.systemThemeCleanup) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (this.themeSelection !== SYSTEM_THEME_ID) return;
      const next = getSystemPreferredDefaultThemeId();
      if (next !== this.resolvedThemeId) void this.applyResolvedTheme(next);
    };
    mq.addEventListener('change', handler);
    this.systemThemeCleanup = () => mq.removeEventListener('change', handler);
  }

  private async applyResolvedTheme(resolvedId: ThemeId): Promise<void> {
    const oldTheme = this.currentTheme;
    const next = themeConfigFromSkin(this.getSkin(), modeOfThemeId(resolvedId));
    await this.hooks.beforeChange?.(next, oldTheme);
    this.emitEvent('theme:before-change', resolvedId, next, oldTheme);
    this.resolvedThemeId = resolvedId;
    this.render();
    await this.hooks.afterChange?.(this.currentTheme, oldTheme);
    this.emitEvent('theme:after-change', resolvedId, this.currentTheme, oldTheme);
    log.info('Theme applied', { id: resolvedId, selection: this.themeSelection, skin: this.skinId });
  }

  async applyTheme(themeId: ThemeId | typeof SYSTEM_THEME_ID): Promise<void> {
    const id = LEGACY_BUILTIN_THEME_FALLBACK[themeId] ?? themeId;
    if (id !== SYSTEM_THEME_ID && !BUILTIN_THEME_IDS.includes(id)) {
      throw new Error(`Theme ${themeId} not found`);
    }
    this.detachSystemThemeListener();
    this.themeSelection = id;
    await this.saveThemeSelection(id);
    if (id === SYSTEM_THEME_ID) {
      this.attachSystemThemeListener();
      await this.applyResolvedTheme(getSystemPreferredDefaultThemeId());
    } else {
      await this.applyResolvedTheme(id);
    }
    import('@/infrastructure/services/infra/SettingsSyncService').then(({ settingsSyncService }) => {
      settingsSyncService.broadcast('theme:changed', id);
    });
  }

  /* ---------------- 渲染：只写属性与一个 <style> ---------------- */

  private render(override?: Skin): void {
    const skin = override ?? this.getSkin();
    const mode = modeOfThemeId(this.resolvedThemeId);
    this.currentTheme = themeConfigFromSkin(skin, mode);
    if (typeof document === 'undefined') return;

    const root = document.documentElement;
    root.setAttribute('data-theme', this.resolvedThemeId);
    root.setAttribute('data-theme-type', mode);
    for (const [k, v] of Object.entries(skinAttributes(skin))) root.setAttribute(k, v);

    // 内置皮肤由 css/skins.css 供给；用户皮肤 / 预览写唯一的 <style>
    let style = document.getElementById(USER_SKIN_STYLE_ID) as HTMLStyleElement | null;
    if (override || !isBuiltinSkin(skin.id)) {
      if (!style) {
        style = document.createElement('style');
        style.id = USER_SKIN_STYLE_ID;
        document.head.appendChild(style);
      }
      style.textContent = skinCss(skin, `html[data-skin='${skin.id}']`);
    } else if (style) {
      style.remove();
    }

    try {
      monacoThemeSync.syncTheme(this.currentTheme);
    } catch (error) {
      log.warn('Monaco Editor theme sync failed', error);
    }
  }

  /* ---------------- 事件 ---------------- */

  on(eventType: ThemeEventType, listener: ThemeEventListener): () => void {
    if (!this.listeners.has(eventType)) this.listeners.set(eventType, new Set());
    this.listeners.get(eventType)!.add(listener);
    return () => {
      this.listeners.get(eventType)?.delete(listener);
    };
  }

  private emitEvent(type: ThemeEventType, themeId: ThemeId, theme?: ThemeConfig, previousTheme?: ThemeConfig): void {
    const event: ThemeEvent = { type, themeId, theme, previousTheme, timestamp: Date.now() };
    this.listeners.get(type)?.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        log.error('Event listener execution failed', { type, error });
      }
    });
  }

  registerHooks(hooks: ThemeHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }
}

export const themeService = new ThemeService();
