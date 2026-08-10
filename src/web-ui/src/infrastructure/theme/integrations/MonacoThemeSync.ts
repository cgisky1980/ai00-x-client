 

import * as monaco from 'monaco-editor';
import { ThemeConfig } from '../types';
import { Ai00XDarkTheme } from '@/tools/editor/themes/ai00-x-dark.theme';
import { resolveCSSColorToHex } from '../utils/resolveCSSColor';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('MonacoThemeSync');



const SEMANTIC_HIGHLIGHTING_RULES = Ai00XDarkTheme.rules;

function getAi00xLightMonacoTheme(): monaco.editor.IStandaloneThemeData {
  return {
    base: 'vs',
    inherit: true,
    rules: SEMANTIC_HIGHLIGHTING_RULES,
    colors: convertColorsToHex({
      'focusBorder': '#00000000',
      'contrastBorder': '#00000000',
      'diffEditor.insertedTextBorder': '#00000000',
      'diffEditor.removedTextBorder': '#00000000',

      'editor.selectionBackground': 'rgba(15, 23, 42, 0.14)',
      'editor.selectionForeground': '#1e293b',
      'editor.inactiveSelectionBackground': 'rgba(15, 23, 42, 0.09)',
      'editor.selectionHighlightBackground': 'rgba(15, 23, 42, 0.10)',
      'editor.selectionHighlightBorder': 'rgba(15, 23, 42, 0.22)',
      'editor.wordHighlightBackground': 'rgba(15, 23, 42, 0.07)',
      'editor.wordHighlightStrongBackground': 'rgba(15, 23, 42, 0.11)',
    }),
  };
}

 
function convertToHexColor(color: string): string {
  if (!color) return color;
  
  
  if (color.startsWith('#')) {
    return color;
  }
  
  
  const rgbaMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i);
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1], 10);
    const g = parseInt(rgbaMatch[2], 10);
    const b = parseInt(rgbaMatch[3], 10);
    const a = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
    
    
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    const alphaHex = Math.round(a * 255).toString(16).padStart(2, '0');
    
    return `#${toHex(r)}${toHex(g)}${toHex(b)}${alphaHex}`;
  }
  
  
  return color;
}

 
function convertColorsToHex(colors: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors)) {
    result[key] = convertToHexColor(value);
  }
  return result;
}

 
export class MonacoThemeSync {
  private initialized = false;
  private currentThemeId: string | null = null;
  
   
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    
    try {
      const { themeService } = await import('@/infrastructure/theme');
      const currentTheme = themeService.getCurrentTheme();
      if (currentTheme) {
        this.syncTheme(currentTheme);
      }

      themeService.on('theme:after-change', (event) => {
        if (event.theme) {
          this.syncTheme(event.theme);
        }
      });

      this.initialized = true;
    } catch (error) {
      log.warn('Failed to initialize Monaco theme sync, falling back to default', error);
      try {
        monaco.editor.defineTheme('ai00-x-dark', Ai00XDarkTheme);
        this.initialized = true;
      } catch (innerError) {
        log.warn('Monaco Editor not loaded yet', innerError);
      }
    }
  }
  
   
  syncTheme(theme: ThemeConfig): void {
    try {
      let targetThemeId: string;
      
      if (theme.monaco) {
        const monacoTheme = this.convertToMonacoTheme(theme);
        monaco.editor.defineTheme(theme.id, monacoTheme);
        targetThemeId = theme.id;
        log.debug('Custom theme registered', { themeId: theme.id, themeName: theme.name });
      } else {
        const bgColor = resolveCSSColorToHex('--color-bg-scene') ?? theme.colors.background.scene;
        const minimapBg = resolveCSSColorToHex('--color-bg-scene') ?? theme.colors.background.scene;

        if (theme.type === 'dark') {
          targetThemeId = 'ai00-x-dark';
          monaco.editor.defineTheme('ai00-x-dark', this.patchThemeColors(Ai00XDarkTheme, bgColor, minimapBg));
        } else {
          targetThemeId = 'ai00-x-light';
          monaco.editor.defineTheme('ai00-x-light', this.patchThemeColors(getAi00xLightMonacoTheme(), bgColor, minimapBg));
        }
        log.debug('Using builtin theme', { themeId: targetThemeId });
      }
      
      monaco.editor.setTheme(targetThemeId);
      
      const editors = monaco.editor.getEditors();
      if (editors && editors.length > 0) {
        log.debug('Refreshing editor instances', { count: editors.length });
        editors.forEach((editor, index) => {
          try {
            editor.layout();
          } catch (err) {
            log.warn('Failed to refresh editor instance', { index, error: err });
          }
        });
      }
      
      this.currentThemeId = targetThemeId;
      log.info('Theme switched successfully', { themeName: theme.name, themeId: targetThemeId });
      
      window.dispatchEvent(new CustomEvent('monaco-theme-changed', {
        detail: { themeId: targetThemeId, theme }
      }));
    } catch (error) {
      log.error('Failed to sync theme', error);
    }
  }
  
   
  getCurrentThemeId(): string | null {
    return this.currentThemeId;
  }

  /**
   * Resolves which Monaco theme id should be active for the given app theme
   * (same rules as {@link syncTheme}).
   */
  getTargetMonacoThemeId(theme: ThemeConfig): string {
    if (theme.monaco) {
      return theme.id;
    }
    return theme.type === 'dark' ? 'ai00-x-dark' : 'ai00-x-light';
  }

  /**
   * Registers Ai00-X built-in and optional custom Monaco themes on the given Monaco instance.
   * Use from the Monaco React wrapper `beforeMount` hook so themes exist on the loader's Monaco
   * before the editor is created (avoids falling back to the default light theme).
   */
  registerThemesForEditorInstance(monacoInstance: typeof monaco, theme: ThemeConfig): string {
    try {
      const bgColor = resolveCSSColorToHex('--color-bg-scene') ?? theme.colors.background.scene;
      const minimapBg = resolveCSSColorToHex('--color-bg-scene') ?? theme.colors.background.scene;

      monacoInstance.editor.defineTheme('ai00-x-dark', this.patchThemeColors(Ai00XDarkTheme, bgColor, minimapBg));
      monacoInstance.editor.defineTheme('ai00-x-light', this.patchThemeColors(getAi00xLightMonacoTheme(), bgColor, minimapBg));

      if (theme.monaco) {
        monacoInstance.editor.defineTheme(theme.id, this.convertToMonacoTheme(theme));
        return theme.id;
      }
      return this.getTargetMonacoThemeId(theme);
    } catch (error) {
      log.error('registerThemesForEditorInstance failed', error);
      return 'ai00-x-dark';
    }
  }
  
   
  private patchThemeColors(
    baseTheme: monaco.editor.IStandaloneThemeData,
    bgColor?: string,
    minimapBg?: string,
  ): monaco.editor.IStandaloneThemeData {
    const colors = { ...baseTheme.colors };
    const rules = [...baseTheme.rules];

    if (bgColor) {
      colors['editor.background'] = bgColor;
      colors['editorGutter.background'] = bgColor;
      colors['editorOverviewRuler.background'] = bgColor;
      colors['editorCursor.background'] = bgColor;
      colors['scrollbar.shadow'] = bgColor;
      log.debug('Editor background patched', { bgColor });
    }

    if (minimapBg) {
      colors['minimap.background'] = minimapBg;
      rules.unshift({ background: minimapBg } as monaco.editor.ITokenThemeRule);
      log.debug('Minimap background patched', { minimapBg, rulesCount: rules.length });
    }

    return { ...baseTheme, colors, rules };
  }

  private convertToMonacoTheme(theme: ThemeConfig): monaco.editor.IStandaloneThemeData {
    const { monaco: monacoConfig, colors } = theme;
    const sceneBg = resolveCSSColorToHex('--color-bg-scene') ?? colors.background.scene;
    if (!monacoConfig) {
      const minimapBg = sceneBg;
      const themeRules = [
        { background: minimapBg },
        ...SEMANTIC_HIGHLIGHTING_RULES,
      ] as monaco.editor.ITokenThemeRule[];

      return {
        base: theme.type === 'dark' ? 'vs-dark' : 'vs',
        inherit: true,
        rules: themeRules,
        colors: convertColorsToHex({
          'editor.background': sceneBg,
          'editor.foreground': colors.text.primary,
          'editor.selectionBackground': colors.accent[300],
          'editorCursor.foreground': colors.accent[500],
          'editorGutter.background': sceneBg,
          'editorOverviewRuler.background': sceneBg,
          'editorCursor.background': sceneBg,
          'scrollbar.shadow': sceneBg,
          'minimap.background': minimapBg,
        }),
      };
    }
    
    
    
    const baseRules = monacoConfig.rules.length > 0
      ? monacoConfig.rules.map(rule => ({
          token: rule.token,
          foreground: rule.foreground,
          background: rule.background,
          fontStyle: rule.fontStyle,
        }))
      : SEMANTIC_HIGHLIGHTING_RULES;

    const themeRules = [
      { background: sceneBg },
      ...baseRules,
    ] as monaco.editor.ITokenThemeRule[];
    
    const themeData: monaco.editor.IStandaloneThemeData = {
      base: monacoConfig.base,
      inherit: monacoConfig.inherit,
      rules: themeRules,
      colors: this.mergeEditorColors(monacoConfig.colors, colors),
    };
    
    return themeData;
  }
  
   
  private mergeEditorColors(
    monacoColors: any,
    themeColors: ThemeConfig['colors']
  ): Record<string, string> {
    const sceneBg = resolveCSSColorToHex('--color-bg-scene') ?? themeColors.background.scene;

    const baseColors: Record<string, string> = {
      "editor.background": sceneBg,
      "editor.foreground": themeColors.text.primary,
      "editorLineNumber.foreground": themeColors.text.muted,
      "editorCursor.foreground": themeColors.accent[500],

      "editor.selectionBackground": themeColors.accent[300],
      "editor.inactiveSelectionBackground": themeColors.accent[200],
      "editor.selectionHighlightBackground": themeColors.accent[200],
      "editor.selectionHighlightBorder": themeColors.accent[400],
      "editor.wordHighlightBackground": themeColors.accent[100],
      "editor.wordHighlightStrongBackground": themeColors.accent[200],
      "editor.lineHighlightBackground": themeColors.background.secondary,

      "editorGutter.background": sceneBg,
      "editorOverviewRuler.background": sceneBg,
      "editorCursor.background": sceneBg,
      "scrollbar.shadow": sceneBg,
      "minimap.background": sceneBg,

      "scrollbarSlider.background": themeColors.scrollbar?.thumb ?? themeColors.accent[300],
      "scrollbarSlider.hoverBackground": themeColors.scrollbar?.thumbHover ?? themeColors.accent[400],
      "scrollbarSlider.activeBackground": themeColors.scrollbar?.thumbHover ?? themeColors.accent[500],

      focusBorder: "#00000000",
      contrastBorder: "#00000000",

      "diffEditor.insertedTextBorder": "#00000000",
      "diffEditor.removedTextBorder": "#00000000",
    };
    
    
    const mappedMonacoColors: Record<string, string> = {};
    if (monacoColors) {
      if (monacoColors.foreground) {
        mappedMonacoColors['editor.foreground'] = monacoColors.foreground;
      }
      if (monacoColors.lineHighlight) {
        mappedMonacoColors['editor.lineHighlightBackground'] = monacoColors.lineHighlight;
      }
      if (monacoColors.selection) {
        mappedMonacoColors['editor.selectionBackground'] = monacoColors.selection;
        
        
        const isLightSelection = this.isLightColor(monacoColors.selection);
        if (!isLightSelection) {
          
          mappedMonacoColors['editor.selectionForeground'] = '#FFFFFF';
        }
      }
      if (monacoColors.cursor) {
        mappedMonacoColors['editorCursor.foreground'] = monacoColors.cursor;
      }
      
      
      
      Object.keys(monacoColors).forEach(key => {
        if (!['background', 'foreground', 'lineHighlight', 'selection', 'cursor'].includes(key)) {
          mappedMonacoColors[key] = monacoColors[key];
        }
      });
    }
    
    
    
    const mergedColors = {
      ...baseColors,
      ...mappedMonacoColors,
    };
    
    
    
    const hexColors = convertColorsToHex(mergedColors);
    
    return hexColors;
  }
  
   
  private isLightColor(color: string): boolean {
    
    let rgb: number[];
    
    if (color.startsWith('rgba') || color.startsWith('rgb')) {
      
      const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        rgb = [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
      } else {
        return false;
      }
    } else if (color.startsWith('#')) {
      // #c8102e
      const hex = color.substring(1);
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      rgb = [r, g, b];
    } else {
      return false;
    }
    
    
    const [r, g, b] = rgb;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    
    
    return luminance > 0.5;
  }
  
   
  registerTheme(themeId: string, theme: ThemeConfig): void {
    try {
      const monacoTheme = this.convertToMonacoTheme(theme);
      monaco.editor.defineTheme(themeId, monacoTheme);
      log.debug('Theme registered', { themeId });
    } catch (error) {
      log.error('Failed to register theme', { themeId, error });
    }
  }
}


export const monacoThemeSync = new MonacoThemeSync();





