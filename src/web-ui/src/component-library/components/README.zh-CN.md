# 组件库

Ai00-X 组件库，使用 SCSS 与 BEM 命名规范，统一暗色主题。

## 组件

- Markdown: Markdown 渲染与高亮，支持 GFM；预览页面 `/markdown-preview.html`
- Button: 按钮，支持多种 variant/size 与 loading
- Card: 卡片容器，支持 variant/hoverable
- Loading: 加载指示器，支持 size/variant
- Modal: 模态框，支持 ESC/遮罩关闭并禁止背景滚动

## 使用方式

```tsx
import { Button, Card, Loading } from '@components';

function App() {
  return (
    <Card>
      <Button variant="primary">Click</Button>
      <Loading size="small" />
    </Card>
  );
}
```

## 样式规范

- 使用 BEM 命名
- 通过 SCSS 变量与混合控制主题
- 交互过渡：`transition: all 0.2s ease;`

## 目录结构

```
src/component-library/components/
├── Button/
│   ├── Button.tsx
│   ├── Button.scss
│   └── index.ts
├── Card/
├── Loading/
├── Modal/
├── index.ts
└── registry.tsx
```

## 开发指南

1. 在 `components/` 下创建组件目录
2. 实现 `.tsx` 与 `.scss`
3. 在组件 `index.ts` 与 `components/index.ts` 导出
4. 在 `registry.tsx` 注册预览

## 注意事项

- 仅提供暗色主题
- 使用 `@components` 路径别名导入
- 组件支持标准 HTML 属性