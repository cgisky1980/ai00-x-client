# AGENTS.md

## Project Overview

Ai00-X is an AI agent-driven programming environment built with Rust and TypeScript, using Desktop architecture sharing a common core library.

### Architecture Layers

```
src/
├── crates/events/         # Event definitions (platform-agnostic)
├── crates/ai-adapters/    # AI client adapters (Anthropic/OpenAI/Gemini)
├── crates/core/           # Core business logic (95%+ code reuse)
│   ├── util/              # Utilities layer (errors, types, process mgmt)
│   ├── infrastructure/    # Infrastructure layer (AI client, storage, events, filesystem)
│   ├── service/           # Service layer (workspace, config, Git, MCP, LSP, SSH...)
│   ├── agent/             # Agent layer
│   │   ├── core/          # Core data model (Session, Message, DialogTurn)
│   │   ├── events/        # Agent event system (queue, router)
│   │   ├── execution/     # Execution engine (ExecutionEngine, StreamProcessor)
│   │   ├── tools/         # Tool system (registry, permissions, pipeline)
│   │   ├── agents/        # Agent implementations (CoreAgent, PlanMode, DebugMode...)
│   │   ├── session/       # Session management (compression, caching)
│   │   ├── coordination/  # Coordination layer (Coordinator, Scheduler)
│   │   ├── persistence/   # Persistence manager
│   │   ├── insights/      # Insights service
│   │   ├── image_analysis/# Image analysis
│   │   └── workspace/     # Workspace binding
│   ├── function_agents/   # Function agents (GitFunctionAgent, StartchatFunctionAgent)
│   └── miniapp/           # MiniApp runtime (JS Worker, export, permissions)
├── crates/transport/      # Transport adapters (Tauri)
├── crates/api-layer/      # Platform-agnostic API handlers
├── crates/relay/          # Remote connect relay (HTTP<->WebSocket bridge)
├── crates/webdriver/      # WebDriver implementation (browser automation)
├── apps/desktop/          # Tauri 2.0 desktop app
├── web-ui/                # React frontend
├── underlay-ui/           # Desktop pet / underlying UI
└── loader-ui/             # Loader UI
```

### Key Design Principles

1. **Dependency Injection** - Services receive dependencies via constructors
2. **EventEmitter Pattern** - Use `Arc<dyn EventEmitter>` not `AppHandle`
3. **TransportAdapter Pattern** - Abstract communication across platforms
4. **Platform Agnostic Core** - No platform-specific dependencies in core

### Tech Stack

- **Backend**: Rust 2021, Tokio, Tauri 2.0, Axum, Salvo
- **Frontend**: React 18, TypeScript, Vite, Zustand, SCSS
- **Package Manager**: pnpm (monorepo via workspace)

## Development Commands

**重要提示**：桌面客户端通过统一 API 与 Ai00-Salvo 后端通信。后端源码为私有仓库，不包含在本公开仓库中。启动桌面应用前，请先部署并启动 Ai00-Salvo 服务，并配置客户端连接（含 `AI00_S_INTERNAL_TOKEN` 环境变量，用于 CSRF 豁免）。

```bash
# Desktop
pnpm run desktop:dev             # Dev mode (web + Rust HMR)
pnpm run desktop:dev:raw         # Raw tauri dev (no wrapper script)

# Desktop build
pnpm run desktop:build           # Production build
pnpm run desktop:build:fast      # Quick build (debug, no bundle)
pnpm run desktop:build:exe       # Windows exe
pnpm run desktop:build:nsis      # Windows NSIS installer

# Frontend
pnpm run dev:web                 # Pure web dev
pnpm run build:web               # Build web
pnpm run lint:web                # ESLint
pnpm run lint:web:fix            # Auto-fix
pnpm run type-check:web          # TypeScript type checking

# E2E testing
pnpm run e2e:test                # All E2E tests
pnpm run e2e:test:l0             # Level 0 (basic)
pnpm run e2e:test:l0:all         # Level 0 all
pnpm run e2e:test:l1             # Level 1
pnpm run e2e:test:smoke          # Smoke test
pnpm run e2e:test:chat           # Chat flow test

# MiniApp builds
pnpm run build:all               # web + loader + zip

# Desktop packaging (NSIS on Windows)
pnpm run desktop:build:nsis      # Windows NSIS installer

# Rust commands (always use --release for builds/tests)
cargo fmt --all                          # Format code
cargo clippy --all-targets -- -D warnings # Lint check (see Code Quality rules)
cargo check --release                    # Quick compile check
cargo build --release                    # Production build
cargo run --release                      # Run in release mode
cargo test --release -p ai00-x-core      # Run core tests
cargo test --release -p ai00-x-desktop   # Run desktop tests
cargo test --release -p ai00-x-relay     # Run relay tests
cargo test --release --all               # Run all tests
```

### E2E Test Details

E2E tests live in `tests/e2e/`, built on WebDriverIO + Tauri integration.
- Page objects: `tests/e2e/page-objects/`
- Specs: `tests/e2e/specs/`
- Helpers: `tests/e2e/helpers/`
- Config: `tests/e2e/config/`
- Fixtures: `tests/e2e/fixtures/`

See `tests/e2e/E2E-TESTING-GUIDE.md` for complete details.

## Critical Rules

### Code Quality Standards

#### General Development Rules

1. **Build Configuration**: Always use release mode for Rust builds
   - `cargo run --release` instead of `cargo run`
   - `cargo build --release` instead of `cargo build`
   - Debug mode (`cargo build`) only for quick syntax checks during development

2. **Iterative Development**: Follow "small steps, quick iterations" principle
   - Complete one logical change at a time
   - Verify each step before moving to the next
   - Commit only when a complete, working feature/fix is done
   - Avoid large, monolithic changes spanning multiple unrelated areas

3. **Testing Discipline**
   - Do NOT create test files haphazardly
   - All test files must be placed in the `tests/` directory
   - Clean up test files AND any generated artifacts (logs, temp files, build outputs) after testing
   - Use existing test infrastructure (`tests/e2e/`, `#[cfg(test)]` modules) when possible
   - Prefer inline unit tests (`#[test]` in source) over separate test files for Rust

4. **Reference Directory**
   - Project reference materials are stored in `参考/` directory
   - Important project information, library references, and design documents reside here
   - After completing major milestones or significant changes, document key decisions and findings in `参考/` for future maintenance
   - Check `参考/` first before starting major features to understand existing context

5. **Python Environment**
   - Use `uv` exclusively for Python package management
   - NEVER use `pip` directly
   - Use `uv add`, `uv remove`, `uv run`, `uv pip install` (if needed) for all Python operations

---

#### Rust Project Quality Rules

**Mandatory Checks (run regularly, fix ALL errors and warnings):**

1. **Formatting**: Run `cargo fmt --all` before committing
   - Config: Uses default rustfmt (2021 edition)
   - Ensures consistent code style across the codebase

2. **Linting**: Run `cargo clippy --all-targets --all-features -- -D warnings`
   - **Core anti-pattern lints** (always enforced, treat as errors):
     - `unwrap_used` - Use proper error handling with `?` or `expect()` with descriptive messages
     - `expect_used` - Only use when absolutely certain; prefer `?` for error propagation
     - `panic` - Avoid in production code; use `Result` type instead
     - `todo!()` / `unimplemented!()` - Must be resolved before merging
     - `dbg!()` macro - Must be removed before committing (use proper logging instead)
     - `print_stdout` / `print_stderr` - Use the `log` crate macros instead
   - **Strict lint set** (pedantic/nursery/cargo): Enable selectively via environment variable for focused improvements, not all at once to avoid error avalanches
   - **Test code exception**: Test modules may use `#[allow(clippy::unwrap_used)]` for convenience, but document why
   - Fix warnings in priority order: address highest-count lints first with representative samples, then batch-fix patterns

3. **Error Handling Best Practices**
   - Use `thiserror` for library error types, `anyhow` for application binaries
   - Propagate errors with `?` operator; avoid swallowing errors
   - Provide context when converting errors (use `.context()` from anyhow)
   - Never use empty `catch_unwind` or ignore `Result` values without explicit `let _ =`

4. **Type Safety**
   - Avoid `as` casts for numeric conversions; use `try_from()`/`try_into()`
   - Use newtypes for domain-specific IDs and values instead of raw `u64`/`String`
   - Leverage the type system to prevent invalid states (make illegal states unrepresentable)

5. **Concurrency Safety**
   - Prefer `tokio::sync` primitives over `std::sync` for async code
   - Document locking order when multiple mutexes are held
   - Avoid `unwrap()` on lock guards; handle poisoning explicitly
   - Use `Arc<dyn EventEmitter>` instead of platform-specific handles (see Transport Layer rules)

6. **Async/Await Patterns**
   - Mark async functions with `#[instrument]` from tracing for better diagnostics
   - Use `tokio::spawn` with named tasks via `tracing::Span::current()` for debugging
   - Avoid `.await` while holding non-async locks; use `tokio::sync::Mutex` for async contexts

**Verification Commands:**
```bash
cargo fmt --all -- --check               # Check formatting (CI)
cargo fmt --all                         # Auto-fix formatting
cargo clippy --all-targets -- -D warnings  # Core lint check
cargo test --release --all              # Run all tests in release mode
cargo check --release                   # Quick compile check
```

---

#### JavaScript/TypeScript Project Quality Rules

**Mandatory Checks (run regularly, fix ALL errors and warnings):**

1. **Package Management**
   - Use `pnpm` exclusively for all JS/TS projects (monorepo via pnpm-workspace.yaml)
   - NEVER use `npm` or `yarn` directly
   - Use `pnpm add`, `pnpm remove`, `pnpm run` for all operations
   - Keep `pnpm-lock.yaml` in sync and committed

2. **Type Checking**: TypeScript strict mode is enforced
   - Run type checks before committing: `pnpm run type-check:web` (for web-ui) or `pnpm tsc --noEmit` for other packages
   - No implicit `any` types; use explicit type annotations or proper generics
   - Avoid type assertions (`as T`) unless absolutely necessary; use type guards instead
   - All public APIs must have complete type signatures

3. **Linting**: ESLint with project configuration
   - Run lint: `pnpm run lint:web` (for web-ui)
   - Auto-fix: `pnpm run lint:web:fix`
   - Fix all ESLint errors and warnings before committing
   - Follow existing ESLint config in each package (see `eslint.config.mjs` in web-ui)

4. **React/Frontend Best Practices**
   - Use functional components with hooks exclusively
   - Follow hooks rules: only call hooks at top level, only in React components/custom hooks
   - Memoize expensive computations with `useMemo`/`useCallback` appropriately
   - Use proper key props in lists (avoid index as key when possible)
   - Follow existing infrastructure patterns (see Frontend Reuse section)

5. **State Management**
   - Use Zustand stores following existing patterns (see `flow-chat-manager/store/`)
   - Keep state normalized; avoid deeply nested state objects
   - Use selectors to prevent unnecessary re-renders
   - Prefer local component state for UI-only state; use global stores sparingly

6. **Code Style**
   - Use existing SCSS modules/styled patterns per project
   - Follow component-library conventions for new UI components
   - Use `createLogger('ModuleName')` for all frontend logging (see Logging rules)
   - i18n: All user-facing strings must use `t()` from useI18n hook, no hard-coded strings

7. **Import Organization**
   - Group imports: React/external -> internal absolute -> relative
   - Use path aliases defined in tsconfig.json (`@/`, `~/`, etc.) consistently
   - Avoid circular dependencies

**Verification Commands:**
```bash
pnpm install                           # Install dependencies
pnpm run lint:web                      # Run ESLint
pnpm run lint:web:fix                  # Auto-fix lint issues
pnpm run type-check:web                # TypeScript type check
pnpm run build:web                     # Production build
pnpm run dev:web                       # Development server
```

---

### Logging

**Rules:** English only, no emojis, structured data, avoid verbose logging

- **Frontend**: `src/web-ui/LOGGING.md` - Use `createLogger('ModuleName')`
- **Backend**: `src/crates/LOGGING.md` - Use `log::{info, debug, ...}` macros

### Transport Layer

**Never use platform-specific APIs in core code:**
- ❌ `use tauri::AppHandle`
- ✅ `use ai00_x_events::EventEmitter`

### Tauri Commands

**Naming:** Commands `snake_case`, Rust `snake_case`, TypeScript `camelCase`

**Always use structured request format:**

```rust
#[tauri::command]
pub async fn your_command(
    state: State<'_, AppState>,
    request: YourRequest,
) -> Result<YourResponse, String>
```

```typescript
await api.invoke('your_command', { request: { ... } });
```

### Agent Module Rename

All agent code was renamed from `agentic/` to `agent/`:
- Old: `src/crates/core/src/agentic/` (deleted)
- New: `src/crates/core/src/agent/`
- Events: `src/crates/events/src/agent.rs` (replaces `agentic.rs`)
- API: `src/apps/desktop/src/api/agent_api.rs` (replaces `agentic_api.rs`)
- Frontend event listener: `AgentEventListener.ts` (replaces `AgenticEventListener.ts`)
- i18n keys: `settings/agent-tools.json` (replaces `agentic-tools.json`)

### Frontend Reuse

When developing frontend features, reuse existing infrastructure:
- **Theme**: `infrastructure/theme/` - useTheme, useThemeToggle
- **I18n**: `infrastructure/i18n/` + `locales/` - useI18n, t()
- **Components**: `component-library/` - shared UI components
- **State**: Zustand stores in each module
- **API**: `infrastructure/api/service-api/` - AgentAPI, ConfigAPI, SessionAPI, etc.

### Frontend Visual Specification

> **★ 权威来源已迁移（2026-08-23）**：Ai00-X 统一视觉设计规范 = **[参考/前端视觉设计规范-新东方极简.md](../参考/前端视觉设计规范-新东方极简.md)（新东方极简）**，token 单一事实来源 = **`packages/design-system/tokens/*.json`**（DTCG，1:1 直出 CSS 变量，`pnpm build` 生成 `css/tokens.css` 等产物）。
>
> **Agent 硬规则**：黛青 `--color-accent` 是唯一交互色；朱砂 `--color-brand-seal` 一屏一处（灵印或唯一 CTA）；LOGO=`<BrandMark>` 灵印（包组件）；品牌名一律 "Ai00-X"；表面走墨阶 token；门面大标题衬线（`--font-family-serif`）；机器输出 mono+tabular；backdrop-blur 仅浮层；签名动效（brush-reveal/ink-ripple）仅白名单五场景；禁止硬编码色值/px/z-index。
>
> 下表为 web-ui 存量 SCSS 编译期体系（`tokens.scss` 仍服务于 web-ui 编译期变量与 mixin；CSS 变量层与 design-system 同名兼容，新代码优先用包 token/组件）。新页面/新前端接入按规范第八节 checklist 逐项检查。

All UI MUST follow the design tokens defined in `src/web-ui/src/component-library/styles/tokens.scss`. Never hardcode spacing, radius, color, or z-index values — always use the corresponding CSS variable or SCSS token.

#### Design Tokens Source of Truth

- **SCSS tokens**: `src/web-ui/src/component-library/styles/tokens.scss`
- **CSS variables**: exported via `@mixin apply-design-tokens` (consumed through `:root`)
- **Usage**: prefer CSS variables (`var(--token, fallback)`) in component SCSS for runtime theme support; use SCSS variables (`$token`) only for compile-time calculations

#### Spacing / Padding (间距)

| Token | CSS Variable | Value | Use Case |
|-------|-------------|-------|----------|
| `$size-gap-1` | `--spacing-1` | 4px | Tight gaps (icon-text, field label-input) |
| `$size-gap-2` | `--spacing-2` | 8px | Default small gap (between related elements) |
| `$size-gap-3` | `--spacing-3` | 12px | Field gap in forms |
| `$size-gap-4` | `--spacing-4` | 16px | Default content padding (modal/panel body) |
| `$size-gap-5` | `--spacing-5` | 20px | Section padding |
| `$size-gap-6` | `--spacing-6` | 24px | Large section gap |
| `$size-gap-8` | `--spacing-8` | 32px | Page-level gaps |

**Rules**:
- Modal/Dialog content padding: `var(--spacing-4, 16px)`
- Form field gap: `var(--spacing-3, 12px)`
- Label-to-input gap: `var(--spacing-1, 4px)`
- Button row gap: `var(--spacing-2, 8px)`

#### Border Radius (圆角)

| Token | CSS Variable | Value | Use Case |
|-------|-------------|-------|----------|
| `$size-radius-sm` | `--radius-sm` | 6px | Small elements (badges, inputs, tags) |
| `$size-radius-base` | `--radius-base` | 8px | Default (buttons, cards, cover previews) |
| `$size-radius-lg` | `--radius-lg` | 12px | Medium cards, radio covers |
| `$size-radius-xl` | `--radius-xl` | 16px | Large panels |
| `$size-radius-2xl` | `--radius-2xl` | 20px | Popups, floating windows (MusicPopup) |
| `$size-radius-full` | `--radius-full` | 9999px | Pills, avatars, circular buttons |

#### Colors (颜色)

**Backgrounds** (use CSS variables, follow light/dark theme):
- `--color-bg-primary` — app background
- `--color-bg-secondary` — panel/sidebar background
- `--color-bg-elevated` — modal/elevated surface
- `--element-bg-subtle` — subtle hover/overlay (rgba 0.10)
- `--element-bg-base` — default element background (rgba 0.19)
- `--element-bg-medium` — medium emphasis (rgba 0.28)

**Text**:
- `--color-text-primary` — primary text (#f8f8fa dark)
- `--color-text-secondary` — secondary text (#d6d6dc)
- `--color-text-muted` — muted/hint text (#b0b0b8)
- `--color-text-disabled` — disabled text

**Accents**:
- `--color-accent-400` / `--color-accent-500` (`#60a5fa`) — primary accent (blue)
- `--color-purple-500` (`#8b5cf6`) — secondary accent (purple)

**Semantic**:
- `--color-success` / `--color-success-bg` / `--color-success-border`
- `--color-warning` / `--color-warning-bg` / `--color-warning-border`
- `--color-error` / `--color-error-bg` / `--color-error-border`

**Borders**:
- `--border-subtle` (rgba 0.26) — subtle dividers
- `--border-base` (rgba 0.35) — default borders
- `--border-medium` (rgba 0.46) — emphasized borders
- `--border-strong` (rgba 0.60) — strong borders (hover/focus)

#### Shadows (阴影)

| Token | Value | Use Case |
|-------|-------|----------|
| `--shadow-xs` | `0 1px 2px rgba(0,0,0,0.9)` | Subtle elevation |
| `--shadow-sm` | `0 2px 4px rgba(0,0,0,0.8)` | Small cards |
| `--shadow-base` | `0 4px 8px rgba(0,0,0,0.7)` | Default elevation |
| `--shadow-lg` | `0 8px 16px rgba(0,0,0,0.6)` | Elevated cards |
| `--shadow-xl` | `0 12px 24px rgba(0,0,0,0.5)` | Modals |
| `--shadow-2xl` | `0 16px 32px rgba(0,0,0,0.4)` | Floating windows |

#### Z-index Layers (层级)

| Token | Value | Use Case |
|-------|-------|----------|
| `$z-base` | 0 | Default content |
| `$z-header` | 10 | Sticky headers |
| `$z-floating` | 50 | Floating elements |
| `$z-dropdown` | 60 | Dropdowns |
| `$z-overlay` | 100 | Overlays |
| `$z-drawer` | 150 | Drawers |
| `$z-modal` | 10000 | Modals (default) |
| `$z-modal-active` | 10050 | Active/dragging modal |
| `$z-toast` | 300 | Toasts |
| `$z-tooltip` | 350 | Tooltips |
| `$z-context-menu` | 500 | Context menus |

**Special high z-index ranges** (for overlay windows that float above modals):
- DynamicIsland: `50010`
- LyricsOverlay: `50011`
- MusicPopup: `50020`
- Modal inside MusicPopup: `50030` (must be higher than the popup that contains it)

**Rule**: When a Modal is opened from within a high-z-index floating window (e.g., MusicPopup), pass `overlayClassName` to the Modal and add a CSS rule to raise its z-index above the parent floating window.

#### Typography (字体)

- **Font family**: `var(--font-family-sans)` (Noto Sans SC, PingFang SC, Microsoft YaHei...)
- **Mono font**: `var(--font-family-mono)` (Fira Code, JetBrains Mono...)
- **Font sizes**: `--font-size-xs` (12px), `--font-size-sm` (13px), `--font-size-base` (14px), `--font-size-lg` (15px), `--font-size-xl` (16px)
- **Font weights**: normal=400, medium=500, semibold=600 (bold also 600 — no 700 to reduce font payload)

#### Motion (动效)

- `--motion-instant` (0.1s) — instant feedback (hover state)
- `--motion-fast` (0.15s) — fast transitions (button hover)
- `--motion-base` (0.3s) — default transitions (panel open/close)
- `--motion-slow` (0.6s) — slow animations (light flow effects)
- Default easing: `var(--easing-standard)` = `cubic-bezier(0.4, 0, 0.2, 1)`

#### Dialog/Modal Conventions (弹窗规范)

1. **Use `Modal` from `@/component-library`** — never create custom overlays
2. **Content padding**: wrap form content in a container with `padding: var(--spacing-4, 16px)`
3. **Form layout**: `display: flex; flex-direction: column; gap: var(--spacing-3, 12px)`
4. **Field layout**: `display: flex; flex-direction: column; gap: var(--spacing-1, 4px)` (label → input)
5. **Action buttons**: right-aligned, `gap: var(--spacing-2, 8px)`, with top border separator
6. **Error messages**: use `--color-error-bg` background, `--color-error` text, `--radius-sm` corners
7. **Z-index**: if opened from a floating window (z-index > 10000), pass `overlayClassName` and override z-index
8. **i18n**: always call `useI18n('namespace')` with the correct namespace — never `useI18n()` without namespace when keys start with a namespace prefix

#### i18n Rules (国际化规范)

1. **Always specify namespace**: `useI18n('acestep')`, `useI18n('vrm')`, etc.
2. **Key format**: when namespace is specified, omit the namespace prefix from keys
   - ✅ `useI18n('acestep')` + `t('share.dialog.title')`
   - ❌ `useI18n()` + `t('acestep.share.dialog.title')` (returns key string, not translation)
3. **Default namespace** is `'common'` — keys not in common.json will return the key string
4. **All user-facing strings** must use `t()` — no hardcoded strings

## Agent System

### Architecture Overview

```
DialogScheduler (receives user messages)
    |
    v
ConversationCoordinator (orchestrates turns)
    |-- Agent selection (RouterAgent / user-specified)
    |-- Prompt building (PromptBuilder + embedded prompt templates)
    |-- ExecutionEngine (multi-round model invocation loop)
    |   |-- RoundExecutor -> per-model-request
    |   |-- StreamProcessor -> SSE stream handling
    |   +-- ToolPipeline -> tool execution (with concurrency)
    |-- SessionManager (session lifecycle + context management)
    |   |-- ContextStore (message management)
    |   |-- PromptCache (prompt caching)
    |   +-- Compression (strategies: fallback / microcompact)
    +-- PersistenceManager (persists to .ai00-x/sessions/{id}/)
```

### Agent Types

| Type | ID | Description |
|------|----|-------------|
| CoreAgent | `Core` | Core agent: Think-Plan-Execute-Review workflow |
| RouterAgent | `Router` | Route user intent to appropriate sub-agent |
| PlanMode | `Plan` | Plan-then-execute mode |
| DebugMode | `Debug` | Debug mode: instrumentation -> root cause |
| DeepResearchAgent | `DeepResearch` | Deep research agent |
| ExploreAgent | `Explore` | Explore agent |
| FileFinderAgent | `FileFinder` | File finder agent |
| CodeReviewAgent | `CodeReview` | Code review agent |
| InitAgent | `Init` | Init agent |
| GenerateDocAgent | `GenerateDoc` | Documentation generator |
| CustomSubagent | custom | User/project-defined custom sub-agents (via Markdown) |

### Tool System

Tools registered in `agent/tools/registry.rs`:

Tool categories:
- **File system**: Read, Write, Edit, Delete, LS, Glob, Grep, GetFileDiff
- **Execution**: Bash, TerminalControl
- **Git**: Git
- **Computer Use**: ComputerUse (mouse click/locate/input), ComputerUseResult
- **MCP**: ListMCPPrompts, GetMCPPrompt, ListMCPResources, ReadMCPResource
- **Web**: WebSearch, WebFetch
- **Agent Control**: SessionControl, SessionHistory, SessionMessage, SelfControl, ControlHub
- **Utility**: AskUserQuestion, TodoWrite, Task, Skill, Cron, Log
- **Generative UI**: GenerativeUI
- **Mermaid**: MermaidInteractive
- **Planning**: CreatePlan, Playbook
- **MiniApp**: InitMiniApp
- **Code Review**: CodeReview

### Adding a New Tool

1. Create file in `agent/tools/implementations/`
2. Implement the `Tool` trait (defined in `agent/tools/framework.rs`)
3. Define `serde` input/output types
4. Export in `implementations/mod.rs`
5. Register in `agent/tools/registry.rs`
6. If it is a default tool, add to the relevant agent's `default_tools()`

### Prompt System

Prompt templates are embedded at compile time in `agent/agents/prompts/`, generated via `build.rs` -> `embedded_agents_prompt.rs`.
- Each prompt template is a standalone `.md` file
- Agents reference templates via `prompt_template_name()`
- `PromptBuilder` handles dynamic context injection (project context, workspace structure, etc.)

### Session Persistence

Location: `.ai00-x/sessions/{session_id}/`

## Frontend Architecture

### Core Modules

- **infrastructure/** - Theme, I18n, Config, State management, Event bus, Service API adapters
- **component-library/** - Shared UI components library
- **flow_chat/** - Chat flow UI:
  - `FlowChatManager` - Unified manager (singleton)
  - `flow-chat-manager/` - Modular implementation (EventHandler, Message, Session, ToolEvent, TextChunk...)
  - `state-machine/` - State machine (SessionStateMachine)
  - `store/` - Zustand state management (FlowChatStore)
  - `hooks/` - React hooks (useFlowChat, useMessageSender, useAutoScroll...)
- **app/** - Application scenes (agents, settings, profile, components)
- **tools/** - Feature modules (editor, git, terminal, file-explorer, lsp, mermaid, snapshot)
- **features/** - Features (ssh-remote)
- **locales/** - Translation files (en-US, zh-CN)

## Frontend Debugging

A local log receiver server is available at `scripts/debug-log-server.mjs`.

**Start the server:**
```bash
node scripts/debug-log-server.mjs
# Listens on http://127.0.0.1:7469, writes logs to debug-agent.log
```

**Instrument code (one-liner fetch):**
```typescript
fetch('http://127.0.0.1:7469/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'file.ts:LINE',message:'desc',data:{k:v},timestamp:Date.now()})}).catch(()=>{});
```

**Clear logs between runs:**
```bash
curl -X POST http://127.0.0.1:7469/clear
```

Logs are written to `debug-agent.log` in project root as NDJSON.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
