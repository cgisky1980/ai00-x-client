# Component Library

Ai00-X component library built with SCSS and BEM naming, unified dark theme.

## Components

- Markdown: rendering with GFM and syntax highlighting; preview at `/markdown-preview.html`
- Button: variants, sizes, and loading state
- Card: container with variant/hoverable
- Loading: indicator with size/variant
- Modal: ESC/backdrop close and locks background scroll

## Usage

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

## Styling

- BEM naming
- SCSS variables and mixins for theming
- Transition: `transition: all 0.2s ease;`

## Structure

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

## Development

1. Create a folder under `components/`
2. Implement `.tsx` and `.scss`
3. Export via the component `index.ts` and `components/index.ts`
4. Register preview in `registry.tsx`

## Notes

- Dark theme only
- Import via `@components` alias
- Components support standard HTML attributes
