# LSP (Language Server Protocol)

Ai00-X’s plugin-based LSP implementation: completions, hover, definition, references, formatting, diagnostics, etc.

## Architecture (high level)

- **Backend (Rust)**: owns server lifecycle, plugin loading, JSON-RPC transport, and workspace-scoped state.
- **Frontend (TypeScript/React)**: integrates LSP features into Monaco and exposes a small API surface.

Frontend layout:

```
src/tools/lsp/
├── services/            # backend calls + Monaco integration
├── hooks/               # React-facing hooks
├── components/          # UI (plugin list, references panel)
├── types/               # shared type definitions
└── index.ts             # exports + initialize helper
```

## Usage

### Enable Monaco LSP integration

```ts
import { useMonacoLsp } from '@/tools/lsp';

useMonacoLsp(editor, languageId, filePath, true, workspacePath);
```

Notes:
- `workspacePath` is required to enable non-builtin Monaco languages.
- For builtin Monaco languages (`typescript`, `javascript`, `typescriptreact`, `javascriptreact`) LSP is handled elsewhere.

### Plugin management (UI/hook)

```ts
import { useLspPlugins } from '@/tools/lsp';

const { plugins, loading, error, installPlugin, uninstallPlugin, reload } = useLspPlugins();
```

Or use the ready-made component:

```ts
import { LspPluginList } from '@/tools/lsp';

<LspPluginList />
```

## Plugin package format

Plugin packages are `.vcpkg` files (ZIP under the hood):

```
my-language-lsp-1.0.0.vcpkg
├── manifest.json
├── bin/
│   ├── win-x64/...
│   ├── darwin-x64/...
│   └── linux-x64/...
└── config/ (optional)
```

`manifest.json` (example):

```json
{
  "id": "typescript-lsp",
  "name": "TypeScript Language Server",
  "version": "1.0.0",
  "author": "Microsoft",
  "description": "TypeScript and JavaScript language support",
  "server": {
    "command": "bin/${platform}-${arch}/typescript-language-server",
    "args": ["--stdio"],
    "env": {}
  },
  "languages": ["typescript", "javascript"],
  "file_extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  "capabilities": {
    "completion": true,
    "hover": true,
    "definition": true,
    "references": true,
    "rename": true,
    "formatting": true,
    "diagnostics": true
  },
  "min_ai00-x_version": "1.0.0"
}
```

## Debugging

- `initializeLsp()` sets up the extension registry and workspace initializer.
- `window.LspDiag` is installed as a lightweight debugging helper (see `src/tools/lsp/index.ts`).















