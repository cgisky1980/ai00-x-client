import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import type { ThemeSelectionId } from '../types';
import './ThemeSelector.scss';

export interface ThemeSelectorProps {
    mode?: 'compact' | 'full';
    className?: string;
    onChange?: (themeId: ThemeSelectionId) => void;
}

/**
 * 明暗档切换器（换肤滑杆已随自定义调色功能移除——黛青唯一交互色，色板固定）
 */
export const ThemeSelector: React.FC<ThemeSelectorProps> = ({
    mode = 'compact',
    className = '',
    onChange,
}) => {
    const { themes, setTheme, isDark, loading } = useTheme();
    const { t } = useTranslation('common');

    const handleThemeTypeToggle = useCallback(async () => {
        const targetType = isDark ? 'light' : 'dark';
        const targetTheme = themes.find(t => t.type === targetType);
        if (targetTheme) {
            await setTheme(targetTheme.id);
            onChange?.(targetTheme.id);
        }
    }, [isDark, themes, setTheme, onChange]);

    if (mode === 'compact') {
        return (
            <div className={`theme-selector theme-selector--compact ${className}`}>
                <button
                    className="theme-selector__mode-btn"
                    onClick={handleThemeTypeToggle}
                    disabled={loading}
                    type="button"
                    title={isDark ? 'Switch to light' : 'Switch to dark'}
                >
                    {isDark ? <Sun size={14} /> : <Moon size={14} />}
                </button>
            </div>
        );
    }

    return (
        <div className={`theme-selector theme-selector--full ${className}`}>
            <div className="theme-selector__controls">
                <button
                    className={`theme-selector__mode-btn ${isDark ? 'theme-selector__mode-btn--active' : ''}`}
                    onClick={handleThemeTypeToggle}
                    disabled={loading}
                    type="button"
                >
                    {isDark ? <Moon size={14} /> : <Sun size={14} />}
                    <span>{isDark ? t('theme.dark') : t('theme.light')}</span>
                </button>
            </div>
        </div>
    );
};

export default ThemeSelector;
