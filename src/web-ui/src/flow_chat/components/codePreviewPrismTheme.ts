/**
 * Prism themes for Flow Chat embedded code previews.
 * vscDarkPlus is for dark surfaces; oneLight matches light card backgrounds.
 */
import type { CSSProperties } from 'react';
import { oneLight, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

/** Match `.markdown-renderer` code blocks (`Markdown.scss` --markdown-font-mono). */
export const CODE_PREVIEW_FONT_FAMILY =
  'var(--markdown-font-mono, "Fira Code", "JetBrains Mono", Consolas, "Courier New", monospace)';

const PRE_KEY = 'pre[class*="language-"]' as const;
const CODE_KEY = 'code[class*="language-"]' as const;

export function buildCodePreviewPrismStyle(isLight: boolean): Record<string, CSSProperties> {
  const base = isLight ? oneLight : vscDarkPlus;
  return {
    ...base,
    [PRE_KEY]: {
      ...base[PRE_KEY],
      margin: 0,
      padding: 0,
      background: 'transparent',
      fontSize: '12px',
      lineHeight: '1.6',
      fontFamily: CODE_PREVIEW_FONT_FAMILY,
      fontWeight: 400,
    },
    [CODE_KEY]: {
      ...base[CODE_KEY],
      background: 'transparent',
      fontSize: '12px',
      lineHeight: '1.6',
      fontFamily: CODE_PREVIEW_FONT_FAMILY,
      fontWeight: 400,
    },
  };
}
