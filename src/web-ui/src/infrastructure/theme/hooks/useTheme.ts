 

import { useEffect, useMemo } from 'react';
import { useThemeStore } from '../store/themeStore';
import { themeService } from '../core/ThemeService';
import { ThemeType, SYSTEM_THEME_ID } from '../types';
export function useTheme() {
  const {
    currentTheme,
    currentThemeId,
    themes,
    skinId,
    skins,
    loading,
    error,
    initialize,
    setTheme,
    setSkin,
    refreshThemes,
  } = useThemeStore();


  useEffect(() => {
    if (!currentTheme && !loading) {
      initialize();
    }
  }, [currentTheme, loading, initialize]);

  return {
    theme: currentTheme,
    themeId: currentThemeId,
    themeType: currentTheme?.type || 'dark' as ThemeType,
    themes,
    /** 皮肤（规范 v1.0）：当前 id / 全部皮肤 / 切换 */
    skinId,
    skins,
    setSkin,
    loading,
    error,
    setTheme,
    refreshThemes,
    isDark: currentTheme?.type === 'dark',
    isLight: currentTheme?.type === 'light',
  };
}

 
export function useThemeConfig() {
  const { theme } = useTheme();
  
  return useMemo(() => {
    if (!theme) {
      return null;
    }
    
    return {
      colors: theme.colors,
      effects: theme.effects,
      motion: theme.motion,
      typography: theme.typography,
    };
  }, [theme]);
}

 
export function useThemeColors() {
  const { theme } = useTheme();
  return theme?.colors || null;
}

 
export function useThemeEffects() {
  const { theme } = useTheme();
  return theme?.effects || null;
}

 
export function useThemeToggle() {
  const { themeId, themes, setTheme, isDark, isLight } = useTheme();

  const anchorThemeId =
    themeId === SYSTEM_THEME_ID ? themeService.getResolvedThemeId() : (themeId ?? '');
  
  
  const toggleTheme = () => {
    const targetType = isDark ? 'light' : 'dark';
    const targetTheme = themes.find(t => t.type === targetType);
    
    if (targetTheme) {
      setTheme(targetTheme.id);
    }
  };
  
  
  const nextTheme = () => {
    const currentIndex = Math.max(0, themes.findIndex(t => t.id === anchorThemeId));
    const nextIndex = (currentIndex + 1) % themes.length;
    const nextTheme = themes[nextIndex];
    
    if (nextTheme) {
      setTheme(nextTheme.id);
    }
  };
  
  
  const prevTheme = () => {
    const currentIndex = Math.max(0, themes.findIndex(t => t.id === anchorThemeId));
    const prevIndex = (currentIndex - 1 + themes.length) % themes.length;
    const prevTheme = themes[prevIndex];
    
    if (prevTheme) {
      setTheme(prevTheme.id);
    }
  };
  
  return {
    toggleTheme,
    nextTheme,
    prevTheme,
    isDark,
    isLight,
  };
}




