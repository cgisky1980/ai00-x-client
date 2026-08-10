/**
 * Build MiniApp theme payload from main app ThemeConfig.
 * Maps to --ai00-x-* CSS variables for iframe theme sync.
 */
import type { ThemeConfig, ThemeType } from '@/infrastructure/theme/types';

export interface MiniAppThemePayload {
  type: ThemeType;
  id: string;
  vars: Record<string, string>;
}

export function buildMiniAppThemeVars(theme: ThemeConfig | null): MiniAppThemePayload | null {
  if (!theme) return null;

  const { colors, effects, typography } = theme;
  const vars: Record<string, string> = {};

  vars['--ai00-x-bg'] = colors.background.primary;
  vars['--ai00-x-bg-secondary'] = colors.background.secondary;
  vars['--ai00-x-bg-tertiary'] = colors.background.tertiary;
  vars['--ai00-x-bg-elevated'] = colors.background.elevated;

  vars['--ai00-x-text'] = colors.text.primary;
  vars['--ai00-x-text-secondary'] = colors.text.secondary;
  vars['--ai00-x-text-muted'] = colors.text.muted;

  vars['--ai00-x-accent'] = colors.accent[500];
  vars['--ai00-x-accent-hover'] = colors.accent[600];

  vars['--ai00-x-success'] = colors.semantic.success;
  vars['--ai00-x-warning'] = colors.semantic.warning;
  vars['--ai00-x-error'] = colors.semantic.error;
  vars['--ai00-x-info'] = colors.semantic.info;

  vars['--ai00-x-border'] = colors.border.base;
  vars['--ai00-x-border-subtle'] = colors.border.subtle;

  vars['--ai00-x-element-bg'] = colors.element.base;
  vars['--ai00-x-element-hover'] = colors.element.medium;

  if (effects?.radius) {
    vars['--ai00-x-radius'] = effects.radius.base;
    vars['--ai00-x-radius-lg'] = effects.radius.lg;
  }

  if (typography?.font) {
    vars['--ai00-x-font-sans'] = typography.font.sans;
    vars['--ai00-x-font-mono'] = typography.font.mono;
  }

  if (colors.scrollbar) {
    vars['--ai00-x-scrollbar-thumb'] = colors.scrollbar.thumb;
    vars['--ai00-x-scrollbar-thumb-hover'] = colors.scrollbar.thumbHover;
  } else {
    vars['--ai00-x-scrollbar-thumb'] =
      theme.type === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.15)';
    vars['--ai00-x-scrollbar-thumb-hover'] =
      theme.type === 'dark' ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.28)';
  }

  return {
    type: theme.type,
    id: theme.id,
    vars,
  };
}
