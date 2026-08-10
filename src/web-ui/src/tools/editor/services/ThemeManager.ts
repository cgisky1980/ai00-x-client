/**
 * Monaco theme manager (singleton).
 * Handles theme registration, switching, and change event subscription.
 */

import * as monaco from 'monaco-editor';
import { Ai00XDarkThemeMetadata } from '../themes/ai00-x-dark.theme';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ThemeManager');

export interface ThemeChangeEvent {
  previousThemeId: string;
  currentThemeId: string;
}

type ThemeChangeListener = (event: ThemeChangeEvent) => void;

class ThemeManager {
  private static instance: ThemeManager;
  
  private registeredThemes = new Set<string>();
  private currentThemeId: string = Ai00XDarkThemeMetadata.id;
  private listeners: ThemeChangeListener[] = [];
  private initialized = false;
  
  private constructor() {}
  
  public static getInstance(): ThemeManager {
    if (!ThemeManager.instance) {
      ThemeManager.instance = new ThemeManager();
    }
    return ThemeManager.instance;
  }
  
  /**
   * Initialize theme system (idempotent).
   */
  public initialize(): void {
    if (this.initialized) {
      return;
    }
    
    this.syncWithThemeService();
    
    this.initialized = true;
  }
  
  /**
   * Register a theme. Returns false if already registered.
   */
  public registerTheme(
    id: string,
    theme: monaco.editor.IStandaloneThemeData
  ): boolean {
    if (this.registeredThemes.has(id)) {
      return false;
    }
    
    try {
      monaco.editor.defineTheme(id, theme);
      this.registeredThemes.add(id);
      return true;
    } catch (error) {
      log.error('Failed to register theme', { themeId: id, error });
      return false;
    }
  }
  
  public forceRegisterTheme(
    id: string,
    theme: monaco.editor.IStandaloneThemeData
  ): void {
    try {
      monaco.editor.defineTheme(id, theme);
      this.registeredThemes.add(id);
    } catch (error) {
      log.error('Failed to force register theme', { themeId: id, error });
    }
  }
  
  public setTheme(themeId: string): void {
    if (themeId === this.currentThemeId) {
      return;
    }
    
    const previousThemeId = this.currentThemeId;
    
    try {
      monaco.editor.setTheme(themeId);
      this.currentThemeId = themeId;
      
      log.debug('Theme changed', { previousThemeId, currentThemeId: themeId });
      
      this.notifyListeners({
        previousThemeId,
        currentThemeId: themeId,
      });
    } catch (error) {
      log.error('Failed to set theme', { themeId, error });
    }
  }
  
  public getCurrentThemeId(): string {
    return this.currentThemeId;
  }
  
  public getDefaultThemeId(): string {
    return Ai00XDarkThemeMetadata.id;
  }
  
  public isThemeRegistered(id: string): boolean {
    return this.registeredThemes.has(id);
  }
  
  public getRegisteredThemes(): string[] {
    return Array.from(this.registeredThemes);
  }
  
  /**
   * Subscribe to theme changes. Returns unsubscribe function.
   */
  public onThemeChange(listener: ThemeChangeListener): () => void {
    this.listeners.push(listener);
    
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }
  
  private async syncWithThemeService(): Promise<void> {
    try {
      const { themeService } = await import('@/infrastructure/theme');
      const currentTheme = themeService.getCurrentTheme();
      const { monacoThemeSync } = await import('@/infrastructure/theme/integrations/MonacoThemeSync');
      
      if (currentTheme) {
        const themeId = currentTheme.monaco 
          ? currentTheme.id 
          : (currentTheme.type === 'dark' ? this.getDefaultThemeId() : 'vs');
        
        this.currentThemeId = themeId;
        monacoThemeSync.syncTheme(currentTheme);
      }
      
    } catch (error) {
      log.warn('Could not sync with ThemeService', error);
      monaco.editor.setTheme(this.getDefaultThemeId());
    }
  }
  
  private notifyListeners(event: ThemeChangeEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        log.error('Error in theme change listener', error);
      }
    });
  }
}

export const themeManager = ThemeManager.getInstance();
export default ThemeManager;
