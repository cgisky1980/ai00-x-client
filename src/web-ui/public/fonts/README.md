# Fonts

This directory contains font assets and configuration for the web UI.

## Structure

```
src/web-ui/public/fonts/
├── fonts.css
├── README.md
└── FiraCode/
    ├── FiraCode-Regular.woff2
    ├── FiraCode-Medium.woff2
    ├── FiraCode-SemiBold.woff2
    └── FiraCode-VF.woff2
```

## Fira Code

- Use: code editor and terminal
- Source: https://github.com/tonsky/FiraCode
- License: SIL Open Font License 1.1 (OFL-1.1)
- Local license: `FiraCode/LICENSE.txt`

| Weight | File | Usage |
|------|------|------|
| 400 | FiraCode-Regular.woff2 | Regular code |
| 500 | FiraCode-Medium.woff2 | Emphasis |
| 600 | FiraCode-SemiBold.woff2 | Keywords |
| 300-700 | FiraCode-VF.woff2 | Variable font |

## Font Stack

UI text uses the system font stack (PingFang SC / Microsoft YaHei / system sans-serif), so no bundled CJK font is required.

Mono:
```scss
'Fira Code', Consolas, 'Courier New', monospace
```

Sans:
```scss
'PingFang SC', 'Microsoft YaHei', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'SF Pro Display', Roboto, sans-serif
```

## Notes

- `font-display: swap` is enabled
- Editor ligatures are enabled (`fontLigatures: true`)
- Missing fonts fall back to system fonts
- To use a custom CJK font, drop the files into `fonts/` and add a matching `@font-face` in `fonts.css`