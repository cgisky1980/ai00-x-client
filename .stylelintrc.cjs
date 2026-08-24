// stylelint - hard-coded color / z-index / spacing / font-size guard
// (spec: 参考/前端视觉设计规范-新东方极简.md; E2/E5 演进见 参考/设计系统演进路线图.md)
// Goal:
//   1. color values must be var(--token) / color-mix(); hex/raw-rgba allowed only in
//      token sources, exempted legacy zones & scene palettes (see ignoreFiles).
//   2. z-index ≥ 100 must be var(--z-*)（全局层一律走 token 刻度）；
//      ≤99 的局部层叠（0–30 常见）迁移期容忍。
//   3. spacing（padding/margin/gap 系）：px/rem 必须走 --size-gap-* 刻度
//      （E5 已全量迁移；负值写 calc(var * -1)）；>64px 页面级留白与 em/%/视口单位豁免。
//   4. font-size：px/rem 必须走 --font-size-* 11 档刻度（E5 已全量迁移）；
//      em/%/相对关键字与 ≥36px 巨号豁免。
// Usage: pnpm lint:style
const strictValue = require('stylelint-declaration-strict-value');

// spacing 属性族（shorthand + logical + longhand；expandShorthand 展开 margin/padding）
const SPACING_PROPS = [
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-block', 'padding-block-start', 'padding-block-end',
  'padding-inline', 'padding-inline-start', 'padding-inline-end',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-block', 'margin-block-start', 'margin-block-end',
  'margin-inline', 'margin-inline-start', 'margin-inline-end',
  'gap', 'row-gap', 'column-gap',
];

const SPACING_IGNORE = [
  'auto', 'inherit', 'initial', 'unset', 'revert',
  'min-content', 'max-content', 'fit-content',
  '/^var\\(/',
  '/^calc\\(/',
  '/^clamp\\(/',                          // 响应式 clamp 合法（E5：值域含 token/视口单位）
  '/^min\\(/',
  '/^max\\(/',
  '/^0[a-z]*$/',                        // 0 / 0px
  '/^-?[\\d.]+(em|%)$/',                 // 相对单位（行内比例/百分比）
  '/^-?[\\d.]+(vh|vw|vmin|vmax|ch|ex|fr)$/', // 视口/轨道单位
  '/^(6[5-9]|[7-9]\\d|\\d{3,})px$/',     // >64px 页面级大留白（罕见，豁免）
];

const FONT_SIZE_IGNORE = [
  'inherit', 'initial', 'unset', 'revert', '0',
  'smaller', 'larger', 'xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large',
  '/^var\\(/',
  '/^calc\\(/',
  '/^clamp\\(/',                          // 响应式字号（display 流式）
  '/^[\\d.]+(em|%)$/',                   // 相对字号（跟父级缩放）
  '/^(3[6-9]|[4-9]\\d|\\d{3,})px$/',     // ≥36px 巨号（超出刻度，门面特例）
];

// 生成 per-property ignoreValues 键（属性键覆盖 '' 全局默认）
const spacingKeys = {};
for (const p of SPACING_PROPS) spacingKeys[p] = SPACING_IGNORE;

module.exports = {
  customSyntax: 'postcss-scss',
  plugins: [strictValue],
  rules: {
    'scale-unlimited/declaration-strict-value': [
      [
        'color', 'background-color', 'border-color', 'outline-color', 'fill', 'stroke',
        'caret-color', 'text-decoration-color', 'column-rule-color',
        'box-shadow', 'text-shadow',
        'z-index',
        'font-size',
        ...SPACING_PROPS,
      ],
      {
        expandShorthand: true, // expands background / border / outline / column-rule / margin / padding
        ignoreFunctions: false, // rgba()/hsl() must NOT slip through as "functions"
        // word-level: geometry tokens of shadows/borders are not colors — allow them
        ignoreKeywords: [
          'transparent', 'inherit', 'initial', 'unset', 'revert', 'currentColor', 'none',
          'inset', 'outset', 'solid', 'dashed', 'dotted', 'in', 'srgb', 'auto',
          // SCSS 插值算子（#{$a} * 2 等，词级拆分后单独成词）
          '/^\\*$/', '/^\\+$/', '/^\\/$/',
        ],
        // per-property ignore lists（属性键替换 '' 全局默认）
        ignoreValues: {
          // ---- 颜色属性（默认） ----
          '': [
            // segment-level: whole function/value strings
            '/^var\\(--[\\w-]+\\),?$/',
            '/^color-mix\\(/',
            '/^oklch\\(/',
            '/^calc\\(/',
            '/^(repeating-)?(linear|radial|conic)-gradient\\(/',
            // word-level: geometry tokens are not colors
            '/^-?[\\d.]+(px|rem|em|%|deg|vw|vh|ms|s)?$/',
            '/^(inset|outset),?$/',
          ],
          // ---- z-index：全局层（≥100）必须 var(--z-*)；局部层叠容忍 ≤99 ----
          'z-index': [
            '/^var\\(--[\\w-]+\\)$/',
            '/^calc\\(/',
            // 局部层叠：0–99（现状 0–30，留余量）
            '/^-?\\d{1,2}$/',
          ],
          // ---- font-size：--font-size-* 11 档刻度（10/11/12/13/14/15/16/18/22/26/32） ----
          'font-size': FONT_SIZE_IGNORE,
          // ---- spacing：--size-gap-* 刻度（1/2/4/6/…/64，Tailwind 式键×4px） ----
          ...spacingKeys,
        },
        disableFix: true,
      },
    ],
  },
  ignoreFiles: [
    '**/node_modules/**',
    '**/dist/**',
    'src/crates/relay/static/assets/**', // relay 前端构建产物
    'src/web-ui/public/**', // 第三方资产（monaco 等）
    'packages/design-system/tokens/**',
    'packages/design-system/css/tokens.css',
    'packages/design-system/css/tokens.standalone.css',
    'packages/design-system/css/tw-theme.css',
    'packages/design-system/css/texture.css',
    'src/web-ui/src/component-library/styles/**', // legacy token 定义区（运行时定义，非消费端）
    'src/web-ui/src/app/styles/**', // 同上：换肤核心
    'src/web-ui/src/infrastructure/theme/**', // 同上
    // Scene palettes (spec: 场景专属色板允许保留字面色值)
    'src/web-ui/src/tools/mermaid-editor/theme/**',
    'src/web-ui/src/tools/mermaid-editor/components/MermaidDiagramStyles.scss', // mermaid 图表色板
    'src/web-ui/src/component-library/components/Markdown/Markdown.scss', // markdown 内容渲染 GitHub 色板
    'src/web-ui/src/tools/file-system/styles/FileExplorer.scss', // 文件类型图标色板
    'src/web-ui/src/flow_chat/components/ChatInputPixelPet.scss', // 像素宠物 sprite 色板
  ],
};
