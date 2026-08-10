# 字体说明

本目录提供 Web UI 的字体资源与配置说明。

## 目录结构

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

- 用途：代码编辑器与终端
- 来源：https://github.com/tonsky/FiraCode
- 许可证：SIL Open Font License 1.1 (OFL-1.1)
- 本地许可证：`FiraCode/LICENSE.txt`

| 字重 | 文件 | 用途 |
|------|------|------|
| 400 | FiraCode-Regular.woff2 | 常规代码 |
| 500 | FiraCode-Medium.woff2 | 强调 |
| 600 | FiraCode-SemiBold.woff2 | 关键字 |
| 300-700 | FiraCode-VF.woff2 | 可变字体 |

## 字体配置

UI 文本使用系统字体栈（苹方/微软雅黑/系统无衬线字体），不包含 CJK 字体以减小仓库体积。

代码字体：
```scss
'Fira Code', Consolas, 'Courier New', monospace
```

界面字体：
```scss
'PingFang SC', 'Microsoft YaHei', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'SF Pro Display', Roboto, sans-serif
```

## 注意事项

- 使用 `font-display: swap` 提升显示速度
- 编辑器已启用连字（`fontLigatures: true`）
- 字体缺失时会降级到系统字体
- 如需使用自定义 CJK 字体，可将字体文件放入 `fonts/` 目录并在 `fonts.css` 中添加相应 `@font-face` 规则