# FlowChat Cards

用于展示 FlowChat 中工具执行过程与结果的卡片组件集合，统一暗色风格并支持多种显示模式。

## 组件

- BaseToolCard: 通用布局与状态管理基础
- ReadFileCard: 文件读取展示
- FileOperationCard: 写入、编辑、删除等文件操作展示
- SearchCard: 文本与文件搜索展示
- TerminalCard: 终端命令执行展示
- TaskCard: AI 任务执行展示
- TodoCard: 任务列表与状态展示
- WebSearchCard: 网页搜索与抓取展示

## 使用方式

```tsx
import {
  ReadFileCard,
  FileOperationCard,
  TerminalCard,
  getFlowChatCardConfig
} from '@component-library/components/FlowChatCards';

const config = getFlowChatCardConfig('Read');

<ReadFileCard displayMode="compact" status="completed" />;
```

## 显示模式

- `compact`: 聊天流快速展示
- `standard`: 常规卡片布局
- `detailed`: 展示完整输入与结果

```tsx
<ReadFileCard displayMode="standard" />
```

## 状态

- `pending` | `running` | `streaming` | `completed` | `error`

## 设计约定

- 统一暗色主题
- BEM 命名规范
- 工具按配置提供主题色

## 扩展开发

1. 在 `FlowChatCards/` 下新增组件目录与样式
2. 导出到 `FlowChatCards/index.ts`
3. 在配置中注册工具信息

## 相关文档

- [组件库总览](../README.md)
- [设计系统](../../DESIGN_TOKENS.md)
- [样式指南](../../styles/README.md)
