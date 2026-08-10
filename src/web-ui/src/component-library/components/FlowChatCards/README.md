# FlowChat Cards

A set of card components that render tool execution progress and results in FlowChat. All cards follow a unified dark theme and support multiple display modes.

## Components

- BaseToolCard: base layout and status handling
- ReadFileCard: file read output
- FileOperationCard: write/edit/delete operations
- SearchCard: text and file search results
- TerminalCard: terminal command execution
- TaskCard: AI task execution
- TodoCard: task list and status
- WebSearchCard: web search and fetch results

## Usage

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

## Display Modes

- `compact`: quick view in chat stream
- `standard`: regular card layout
- `detailed`: full input and result view

```tsx
<ReadFileCard displayMode="standard" />
```

## Status

- `pending` | `running` | `streaming` | `completed` | `error`

## Design

- unified dark theme
- BEM naming
- tool-specific primary color from config

## Extending

1. Add component folder and styles under `FlowChatCards/`
2. Export in `FlowChatCards/index.ts`
3. Register tool config

## Related

- [Component library](../README.md)
- [Design tokens](../../DESIGN_TOKENS.md)
- [Styles](../../styles/README.md)
