import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import type { ThemeSelectionId } from '../types';
import HueSlider from './HueSlider';
import './ThemeSelector.scss';

export interface ThemeSelectorProps {
    mode?: 'compact' | 'full';
    className?: string;
    onChange?: (themeId: ThemeSelectionId) => void;
}

export const ThemeSelector: React.FC<ThemeSelectorProps> = ({
    mode = 'compact',
    className = '',
    onChange,
}) => {
    const { themes, setTheme, accentHue, setAccentHue, isDark, loading } = useTheme();
    const { t } = useTranslation('common');

    const handleThemeTypeToggle = useCallback(async () => {
        const targetType = isDark ? 'light' : 'dark';
        const targetTheme = themes.find(t => t.type === targetType);
        if (targetTheme) {
            await setTheme(targetTheme.id);
            onChange?.(targetTheme.id);
        }
    }, [isDark, themes, setTheme, onChange]);

    const handleHueChange = useCallback(async (hue: number) => {
        await setAccentHue(hue);
    }, [setAccentHue]);

    if (mode === 'compact') {
        return (
            <div className={`theme-selector theme-selector--compact ${className}`}>
                <div className="theme-selector__hue-slider">
                    <HueSlider
                        hue={accentHue}
                        onChange={handleHueChange}
                        disabled={loading}
                    />
                </div>
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
            <div className="theme-selector__hue-section">
                <span className="theme-selector__hue-label">{t('theme.accent')}</span>
                <HueSlider
                    hue={accentHue}
                    onChange={handleHueChange}
                    disabled={loading}
                />
            </div>
        </div>
    );
};

export default ThemeSelector;
