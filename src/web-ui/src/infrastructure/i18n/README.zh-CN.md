# 前端国际化（i18n）

## 快速使用

```typescript
import { useI18n } from '@/infrastructure/i18n';

const { t } = useI18n('components');
<span>{t('section.key')}</span>
```

## 核心 API

### `useI18n(namespace)`

```typescript
const { t } = useI18n('components');

t('dialog.confirm.ok');
t('session.title', { id: 123 });
```

多命名空间：

```typescript
const { t } = useI18n('components');
const { t: tSettings } = useI18n('settings');
```

常用返回值：

```typescript
const {
  t,
  currentLanguage,
  changeLanguage,
  isReady,
  formatDate,
  formatNumber,
} = useI18n('components');
```

非 React 环境：

```typescript
import { i18nService } from '@/infrastructure/i18n';

i18nService.t('namespace:section.key');
```

## 翻译文件

路径：`src/web-ui/src/locales/{zh-CN,en-US}/`

| 命名空间 | 文件 | 用途 |
|----------|------|------|
| `common` | `common.json` | 通用文本 |
| `components` | `components.json` | UI 组件 |
| `flow-chat` | `flow-chat.json` | 聊天功能 |
| `settings` | `settings.json` | 设置页 |
| `errors` | `errors.json` | 错误信息 |
| `panels/*` | `panels/*.json` | 面板 |
| `settings/*` | `settings/*.json` | 设置子页 |

## 添加翻译

1. 在 `locales/zh-CN/` 与 `locales/en-US/` 的对应 JSON 同步新增 key：

```json
// locales/zh-CN/components.json
{
  "myFeature": {
    "title": "我的功能",
    "desc": "共 {{count}} 项"
  }
}

// locales/en-US/components.json
{
  "myFeature": {
    "title": "My Feature",
    "desc": "{{count}} items"
  }
}
```

2. 在组件中使用：

```typescript
const { t } = useI18n('components');
t('myFeature.title');
t('myFeature.desc', { count: 5 });
```

## 约定

- 命名空间为文件名（去掉 `.json`），子目录用 `/` 分隔
- key 使用点号分隔：`section.subsection.key`
- 插值使用 `{{variable}}`
- 两种语言必须同步更新
