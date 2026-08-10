# AGENTS.md

## 项目概述

Ai00-X 是 AI 代理驱动的编程环境，使用 Rust 和 TypeScript 构建，采用桌面端架构共享核心库。

### 架构层次

```
src/
├── crates/events/         # 事件定义（平台无关）
├── crates/ai-adapters/    # AI 客户端适配器（Anthropic/OpenAI/Gemini）
├── crates/core/           # 核心业务逻辑（95%+ 代码复用）
│   ├── util/              # 工具层（错误、类型、进程管理）
│   ├── infrastructure/    # 基础设施层（AI 客户端、存储、事件、文件系统）
│   ├── service/           # 服务层（工作区、配置、Git、MCP、LSP、SSH…）
│   ├── agent/             # Agent 层
│   │   ├── core/          # 核心数据模型（Session, Message, DialogTurn）
│   │   ├── events/        # Agent 事件系统（队列、路由）
│   │   ├── execution/     # 执行引擎（ExecutionEngine, StreamProcessor）
│   │   ├── tools/         # 工具系统（注册、权限、管道）
│   │   ├── agents/        # Agent 实现（CoreAgent, PlanMode, DebugMode…）
│   │   ├── session/       # 会话管理（压缩、缓存）
│   │   ├── coordination/  # 协调层（Coordinator, Scheduler）
│   │   ├── persistence/   # 持久化管理器
│   │   ├── insights/      # 洞察服务
│   │   ├── image_analysis/# 图像分析
│   │   └── workspace/     # 工作区绑定
│   ├── function_agents/   # 功能 Agent（GitFunctionAgent, StartchatFunctionAgent）
│   └── miniapp/           # MiniApp 运行时（JS Worker, 导出、权限）
├── crates/transport/      # 传输适配器（Tauri）
├── crates/api-layer/      # 平台无关处理器
├── crates/relay/          # 远程连接中继（HTTP↔WebSocket 桥）
├── crates/webdriver/      # WebDriver 实现（浏览器自动化）
├── apps/desktop/          # Tauri 2.0 桌面应用
├── web-ui/                # React 前端
├── underlay-ui/           # 桌宠/底层 UI
└── loader-ui/             # 加载器 UI
```

### 核心设计原则

1. **依赖注入** - 服务通过构造函数接收依赖
2. **EventEmitter 模式** - 使用 `Arc<dyn EventEmitter>` 而非 `AppHandle`
3. **TransportAdapter 模式** - 跨平台抽象通信
4. **平台无关核心** - Core 不包含平台特定依赖

### 技术栈

- **后端**: Rust 2021, Tokio, Tauri 2.0, Axum, Salvo
- **前端**: React 18, TypeScript, Vite, Zustand, SCSS
- **包管理**: pnpm (monorepo via workspace)

## 开发命令

```bash
# 桌面端开发
pnpm run desktop:dev             # 开发模式（web + Rust 热重载）
pnpm run desktop:dev:raw         # 直接 tauri dev（无脚本包装）

# 桌面端构建
pnpm run desktop:build           # 生产构建
pnpm run desktop:build:fast      # 快速构建（debug, 不打包）
pnpm run desktop:build:exe       # Windows exe
pnpm run desktop:build:nsis      # Windows NSIS 安装包

# 前端
pnpm run dev:web                 # 纯 web 开发
pnpm run build:web               # 构建 web
pnpm run lint:web                # ESLint
pnpm run lint:web:fix            # 自动修复
pnpm run type-check:web          # TypeScript 类型检查

# 端到端测试
pnpm run e2e:test                # 全部 E2E 测试
pnpm run e2e:test:l0             # 级别 0（基础）
pnpm run e2e:test:l0:all         # 级别 0（全部）
pnpm run e2e:test:l1             # 级别 1
pnpm run e2e:test:smoke          # 冒烟测试
pnpm run e2e:test:chat           # 聊天流测试

# MiniApp 构建
pnpm run build:all               # web + loader + zip

# 桌面打包（Windows 使用 NSIS）
pnpm run desktop:build:nsis      # Windows NSIS 安装包

# Rust 测试（需要手动运行）
cargo test -p ai00-x-core
cargo test -p ai00-x-desktop
cargo test -p ai00-x-relay
```

### E2E 测试详细说明

E2E 测试位于 `tests/e2e/`，使用 WebDriverIO 和 Tauri 集成。
- 页面对象模式：`tests/e2e/page-objects/`
- 测试规范：`tests/e2e/specs/`
- 辅助工具：`tests/e2e/helpers/`
- 配置：`tests/e2e/config/`
- 测试数据：`tests/e2e/fixtures/`

详见 `tests/e2e/E2E-TESTING-GUIDE.md`。

## 关键规则

### 日志规范

**规则：** 仅英文、禁止 emoji、结构化数据、避免冗余日志

- **前端**: `src/web-ui/LOGGING.md` - 使用 `createLogger('ModuleName')`
- **后端**: `src/crates/LOGGING.md` - 使用 `log::{info, debug, ...}` 宏

### 传输层

**核心代码中禁止使用平台特定 API：**
- ❌ `use tauri::AppHandle`
- ✅ `use ai00_x_events::EventEmitter`

### Tauri 命令

**命名规范：** 命令 `snake_case`，Rust `snake_case`，TypeScript `camelCase`

**始终使用结构化请求格式：**

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

### Agent 模块路径

所有 Agent 相关代码已从 `agentic/` 迁移到 `agent/`：
- 旧路径：`src/crates/core/src/agentic/`（已删除）
- 新路径：`src/crates/core/src/agent/`
- 事件：`src/crates/events/src/agent.rs`（取代旧的 `agentic.rs`）
- API 适配器：`src/apps/desktop/src/api/agent_api.rs`（取代旧的 `agentic_api.rs`）
- 前端事件监听器：`AgentEventListener.ts`（取代旧的 `AgenticEventListener.ts`）
- i18n 键：`settings/agent-tools.json`（取代旧的 `agentic-tools.json`）

### 前端复用

开发前端功能时，复用现有基础设施：
- **主题**: `infrastructure/theme/` - useTheme, useThemeToggle
- **国际化**: `infrastructure/i18n/` + `locales/` - useI18n, t()
- **组件**: `component-library/` - 共享 UI 组件
- **状态**: 各模块内的 Zustand Store
- **API**: `infrastructure/api/service-api/` - AgentAPI, ConfigAPI, SessionAPI 等

## Agent 系统

### 架构总览

```
DialogScheduler (接收用户消息)
    ↓
ConversationCoordinator (编排对话轮次)
    ├── Agent 选择（RouterAgent / 用户指定）
    ├── Prompt 构建（PromptBuilder + 嵌入提示词模板）
    ├── ExecutionEngine（多轮模型调用循环）
    │   ├── RoundExecutor → 每次模型请求
    │   ├── StreamProcessor → SSE 流处理
    │   └── ToolPipeline → 工具执行（含并发）
    ├── SessionManager（会话生命周期 + 上下文管理）
    │   ├── ContextStore（消息管理）
    │   ├── PromptCache（提示词缓存）
    │   └── Compression（压缩策略：fallback / microcompact）
    └── PersistenceManager（持久化到 .ai00-x/sessions/{id}/）
```

### Agent 类型

| 类型 | ID | 说明 |
|------|----|------|
| CoreAgent | `Core` | 核心 Agent：Think-Plan-Execute-Review 工作流 |
| RouterAgent | `Router` | 路由 Agent：判断用户意图并路由到合适子 Agent |
| PlanMode | `Plan` | 先规划后执行模式 |
| DebugMode | `Debug` | 调试模式：插桩取证→根因定位 |
| DeepResearchAgent | `DeepResearch` | 深度研究 Agent |
| ExploreAgent | `Explore` | 探索 Agent |
| FileFinderAgent | `FileFinder` | 文件查找 Agent |
| CodeReviewAgent | `CodeReview` | 代码审查 Agent |
| InitAgent | `Init` | 初始化 Agent |
| GenerateDocAgent | `GenerateDoc` | 文档生成 Agent |
| CustomSubagent | 自定义 | 用户/项目自定义子 Agent（通过 Markdown 定义） |

### 工具系统

工具注册在 `agent/tools/registry.rs`：

```rust
// 注册方式
registry.register(Arc::new(BashTool::new(workspace_services)));
```

**工具类型：**
- **文件系统**: Read, Write, Edit, Delete, LS, Glob, Grep, GetFileDiff
- **执行**: Bash, TerminalControl
- **Git**: Git
- **计算机使用**: ComputerUse (含鼠标点击/定位/输入), ComputerUseResult
- **MCP**: ListMCPPrompts, GetMCPPrompt, ListMCPResources, ReadMCPResource
- **Web**: WebSearch, WebFetch
- **Agent 控制**: SessionControl, SessionHistory, SessionMessage, SelfControl, ControlHub
- **辅助**: AskUserQuestion, TodoWrite, Task, Skill, Cron, Log
- **生成式 UI**: GenerativeUI
- **Mermaid**: MermaidInteractive
- **计划**: CreatePlan
- **MiniApp**: InitMiniApp
- **代码审查**: CodeReview

### 新工具开发

1. 在 `agent/tools/implementations/` 下创建文件
2. 实现 `Tool` trait（定义于 `agent/tools/framework.rs`）
3. 定义 `serde` 输入/输出类型
4. 在 `implementations/mod.rs` 导出
5. 在 `agent/tools/registry.rs` 注册
6. 如果是默认工具，在对应 Agent 的 `default_tools()` 中添加

### 提示词系统

提示词模板编译时嵌入在 `agent/agents/prompts/` 中，通过 `build.rs` → `embedded_agents_prompt.rs` 生成。
- 所有 prompt 模板是独立的 `.md` 文件
- Agent 通过 `prompt_template_name()` 引用模板
- `PromptBuilder` 处理动态上下文注入（项目上下文、工作区结构等）

### 会话持久化

位置：`.ai00-x/sessions/{session_id}/`

## 前端架构

### 核心模块

- **infrastructure/** - 基础设施层：状态管理、配置、国际化、主题、事件总线、服务 API
- **component-library/** - 共享 UI 组件库
- **flow_chat/** - 聊天流 UI：
  - `FlowChatManager` - 统一管理器（单例）
  - `flow-chat-manager/` - 模块化实现（EventHandler, Message, Session, ToolEvent, TextChunk...）
  - `state-machine/` - 状态机（SessionStateMachine）
  - `store/` - Zustand 状态管理（FlowChatStore）
  - `hooks/` - React hooks（useFlowChat, useMessageSender, useAutoScroll...）
- **app/** - 应用场景（agents, settings, profile, components）
- **tools/** - 工具模块（editor, git, terminal, file-explorer, lsp, mermaid, snapshot）
- **features/** - 特性（ssh-remote）
- **locales/** - 翻译文件（en-US, zh-CN）

## 前端调试

本地日志接收服务器位于 `scripts/debug-log-server.mjs`。

**启动服务器：**
```bash
node scripts/debug-log-server.mjs
# 监听 http://127.0.0.1:7469，写入 debug-agent.log
```

**打点代码（单行 fetch）：**
```typescript
fetch('http://127.0.0.1:7469/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'file.ts:LINE',message:'desc',data:{k:v},timestamp:Date.now()})}).catch(()=>{});
```

**清空日志：**
```bash
curl -X POST http://127.0.0.1:7469/clear
```

日志写入项目根目录的 `debug-agent.log` 文件，NDJSON 格式。
