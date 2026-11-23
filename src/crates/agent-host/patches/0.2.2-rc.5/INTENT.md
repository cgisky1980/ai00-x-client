# 引擎 0.2.2-rc.5 的 Ai00-X patch 资产目录

## 本目录是什么

`@deepseek-ai/dsh@0.2.2-rc.5` 专用的编排 patch 资产（版本限定）。
`dsh_manager::ensure_orchestration_patch` 按 `dsh_versions.gen.rs` 的当前
版本加载同名目录；**引擎升级时必须新建对应版本目录并逐行核对**，缺失目录
= 启动期显式报错（不静默回退）。

## 文件清单

| 文件 | 角色 | 占位符 |
|---|---|---|
| `orchestration-head.patch.yml` | 静态头：bundled-skills 挂载；编排者 persona 由 workbench preset 生成层写入 | `{BUNDLED_SKILLS_DIR}` |
| `hooks-row.yml.tmpl` | Claude Code 兼容 hooks 桥挂载行（insert 段） | `{CONFIG_PATH}` |
| `mcp-row.yml.tmpl` | MCP 桥接行骨架（insert 段，transport 动态体由代码追加） | `{SERVER_NAME}` `{TRANSPORT_BODY}` |
| `capability-rows.yml.tmpl` | 能力包挂载行：computer-use（Cua 驱动）；包本体由 install_capability_packages 全局安装 | 无 |

帮手（worker）行**不在本目录**：由 `dsh_manager::build_worker_rows` 按
`<DSH_HOME>/agent-workers/*.md` 现算（见下「帮手 → preset 迁移」）。

## 0.2.0-rc.2 → 0.2.2-rc.5 的破坏性变更（本目录的由来）

1. **`persona` / `toolFilter` / `backgroundMode` 三项从 subagent 工具配置移除**
   （`@deepseek-ai/dsh-tool-subagent` Config：`provider` / `toolName` /
   `modelSelection` / `modelDiscovery` / `agentOptions` / `agentPreset` /
   `allowedAgentPresets` / `maxDepth`）。上游 README 明确：**工具配置里出现
   `persona` 或 `toolFilter` 会在加载时报迁移错误**，故旧版帮手行必须迁移。
2. **后台委派成为唯一形态**：每次调用立即返回 `started subagent <childId>`，
   完成后发通知；`backgroundMode: continuable` 语义内建，无需也不能再配。
3. **子代理（帮手）组合改由 agent preset 声明**：
   `@deepseek-ai/dsh-agent-preset`（`config.id` + `config.plugins`）挂在
   `@deepseek-ai/dsh-agent-preset-registry`（web-app bundle 已挂载）下，
   subagent 行用 `agentPreset: <id>` 选择。persona 由 preset 内的
   `@deepseek-ai/dsh-persona`（`config.prefix`）声明，工具子集由 preset
   `plugins` 里的工具行声明（不再有 `toolFilter`）。
4. **`@deepseek-ai/dsh-hooks-claude-code` 从主包依赖中移除**
   （同时移除的还有 `dsh-hooks-codex` / `dsh-webhook`(+github) / `dsh-tool-ralph`
   / `dsh-experimental-schedule-bundle`，我们都没用）。包本体仍按同版本发布，
   但 profile 里的解析链看不到它（引擎按 profile 目录解析 patch 行插件），
   因此改由 `dsh_manager::ensure_profile_plugin_packages` 显式装入 profile
   （插件本体 + 运行时需要的 peer：`dsh-hook-protocol` / `dsh-llm` /
   `dsh-agent` / `dsh-tools` / `dsh-session` / `dsh-subagent` /
   `dsh-working-directory` / `@deepseek-ai/cordis`）。
5. **`system-prompt` 行没有 `persona` 键**（0.2.0-rc.2 也没有）：只有
   `personaPrefix` / `personaSuffix` / `toolOrder` / `includeHarnessIdentity` /
   `includeRuntimeContext`。旧目录写 `config.persona` 的覆写一直是空转。
6. base 层新增/调整（无需动作，dump 已核实）：`remote-access`、
   `working-directory` + `tool-working-directory`、`web-deepseek-api`、
   `tool-executor-native` / `tool-executor-ptc(disabled)`；移除
   `skill-badge` / `tool-subagent-list-agents` / `tool-ralph`；
   `fs-observation-policy` 默认 disabled、`tool-fs` 默认 `applyPatch: false`；
   `session-title-llm.maxOutputTokens` 64 → 4096。
7. **preset 组合已存在但工具事件变了**：0.2.0-rc.2 的 standard preset 用
   `modelSelectionSettings: true` + `backgroundMode`；0.2.2 改为
   `modelSelection: true` + `modelDiscovery: true`，并新增
   `tool-schedule` / `time-context` / `tool-plugin-market` 行。

## 帮手 → preset 迁移（build_worker_rows）

每个 `<DSH_HOME>/agent-workers/*.md` 生成 **一个** insert 行（2026-11-20 起）：

```
- id: preset-<presetId>          name: @deepseek-ai/dsh-agent-preset
    config.id = <presetId>；config.plugins =
      [persona(prefix=叶子规则+正文), agent-instructions(禁用 local 指令),
       <工具行…>, subagent-control(send_message), compaction 组,
       ai00-x-tools-restrict(deny 业务工具 + 引擎全局工具)]
```

委派工具行 `tool-subagent-<suffix>` **不再作为 profile 顶层行**：顶层行会让
每个会话（标准聊天 / 快速问答 / 工人自己）都看到 `code_worker` 等，既白付
schema token，又让快速问答能越界派发（实测）。现在它只由
`build_workbench_preset_row_from_standard` 写进 workbench / workbench-task
两个 preset；工人 preset 用 `ai00-x-tools-restrict` 的 deny 列表把继承来的
同名工具摘掉。

工具子集映射（frontmatter `tools:` → 插件行）：

| 帮手写的工具名 | 生成的行 |
|---|---|
| `read` / `read_image` / `write` / `edit` | `@deepseek-ai/dsh-tool-fs`（read/readImage/write/edit 布尔） |
| `glob` / `grep` | `@deepseek-ai/dsh-tool-fs-search` |
| `bash` | `@deepseek-ai/dsh-tool-bash`（win32 disabled） |
| `pwsh` | `@deepseek-ai/dsh-tool-pwsh`（非 win32 disabled） |
| `skill` | `@deepseek-ai/dsh-tool-skill` |
| `todo_write` | `@deepseek-ai/dsh-tool-todo` |
| `web_fetch` / `web_search` | `@deepseek-ai/dsh-tool-web` |

未知工具名 → 记 warn 后忽略（旧 `toolFilter` 能点名任意已注册工具，
preset 机制只能按插件行粗粒度挂载）。

## 意图与红线（为什么这么写）

1. **编排者 persona 归属**：`system-prompt.personaPrefix` 是**部署级**槽，
   会被 preset 内 `@deepseek-ai/dsh-persona` 以 scoped
   `deployment:persona-prefix` **覆盖**，因此静态头不再保留这份无效配置。
   `build_workbench_preset_row` 直接把编排者 persona 写进 workbench preset；
   standard 会话仍使用上游通用 coding persona。worker 同样使用 preset 内
   persona，但固定前置叶子执行规则，并禁用 `AGENTS.local.md` 等 local 指令，
   防止主代理的计划确认门禁泄漏到子代理。
2. **模型分工**（与 ai_gateway.rs 白名单同源约定）：
   - research_worker：只读六件套 + model=ai00-auto → 网关 SmartRouter /
     hybrid_tool_loop 判级 R0/R1 走本地 RWKV（零成本），失败自动远端；
   - local_code_worker：执行类工具 + model=rwkv-local → 默认本地执行与一次返工；
   - review_worker：只读证据 + model=ai00-api → 子任务评审（严格模式与高风险必经）；
   - code_worker：执行类工具 + model=ai00-api → 云端兜底与明确的云端修正。

   桌面端「模型组合」按阶段改写上述四个工人 md 的 `model:` 行（规划模型切主会话），
   组合切换后需重启引擎装载新 preset；引擎空闲时宿主会自动重启。
3. **工具名为引擎注册名**：dsh-tool-fs: read/read_image/edit/write、
   dsh-tool-fs-search: glob/grep、dsh-tool-pwsh: pwsh、dsh-tool-bash: bash、
   dsh-tool-skill: skill、dsh-tool-todo: todo_write、dsh-tool-web:
   web_fetch/web_search。改动组合后用 `dsh --profile ai00x --dump-config`
   验证（DSH_HOME 指向 dsh_home()）；组合 boot 时装配，sidecar 重启生效。
4. **0.2.2-rc.5 版本特有注意**：
   - web 服务端仍是显式 bundle `@deepseek-ai/dsh-web-app`（profile bundles
     必须挂载，缺它 boot 静默挂起零输出）；
   - `/api` 全量鉴权（token→cookie 链必需），`dsh --profile <name> [options]`
     形式不变；
   - preset 的服务提供方与消费方需同一 `cordis:group` 隔离 realm（我们只
     消费 web-app 已挂好的 registry，不自建）；
   - 沙箱实证：`dsh --profile ai00x --dump-config` 通过、引擎 headless boot
     后 `pluginInventory/list` 里帮手 subagent 行与 preset 行均 active；
     `dsh-computer-use` 两行因能力包不在 profile 解析链上而未激活
     （0.2.0 起即如此，属既有缺口，本次不动）。
5. **变更纪律**：patch 行为改动与引擎版本升级分开提交；升级时对照上游新版
   变更逐行核对本目录（参考 dsh-desktop 项目的 patches/ 目录做法）。
