# dsh Agent 进化分阶段执行计划

> 决策依据与"为什么"：[参考/dsh-Agent进化路线研究-20260906.md](../参考/dsh-Agent进化路线研究-20260906.md)
> 日期：2026-09-06 ｜ 状态：P0/P1 主体已实施（见文末"自查修订与执行状态"）
> 惯例：每个里程碑（M）独立可提交、可验证；Rust 全部 release 构建验证；前端改完跑快速循环（`pnpm --dir src/web-ui build` → `node scripts/zip-dir.mjs` → 替换 `target\release\main.zip` → 重启客户端）。

## 自查修订记录（2026-09-06 执行前审查）

1. **M0.2 重大修正**：原计划"撤掉 `client_factory.rs` 默认 token 兜底"**不执行**。核实后发现 `AI00_S_INTERNAL_TOKEN` 及其默认值同时承担远端转发的 CSRF 豁免头（`fetchWithAuth`、`TokenManager`、XP 转发、`packages/shared/internalToken.ts`），且与服务器端 `default_internal_token` 一致是有意的开箱设计——撤掉会破坏远端调用与开箱体验，与 dsh 插件权限无关。修正为：**token 层保留，叠加 per-plugin scope 层**（bundled 全量放行 / 已标识第三方按 grants 文件 / 未标识只放行只读 BASIC scope）。
2. **M0.3 修正**：dsh 引擎**没有** `session.delete` RPC（只有 `session.rename`）——删除会话不可行，改为 rename + 原生 `session.fork`（引擎原生 RPC，`{sessionId, beforeSeq?, maxMessages?}` → `{sessionId}`）。
3. **M1.3 简化**：`session.create` 原生支持 `agentPreset` 参数，且 `DshAPI.ts` 早已实现透传——工作重心变为 `useAgentDelegate` 接线（`delegate(task, moduleId?)`）+ `agent-modules.ts` 多模块注册。
4. **行为修正**：`agent` 模块 `cwd` 从 `'none'` 改为 `'ask'`——旧代码虽标 none 但实际总是解析 cwd（代码任务需要工作目录与基线快照），改回 `ask` 保持行为一致，仅壁纸模块跳过 cwd。
5. **引擎原生能力核对**（读本机 dsh 0.1.1-rc.2 组件清单）：dsh 原生自带 compaction（含 tool-result-pruner）、sandbox（local + windows-acl + policy）、subagent（含 in-process driver + tool-subagent）、skill、jobs/schedule、session-checkpoint、token-meter 等——**M2/M3 的"引入社区插件"项实施前必须先核对这些原生组件**（如 rewind 优先调研原生 session-checkpoint-policy，memory 优先核对 dsh-agent 的 inbox/memory 机制），避免引入与原生重复的插件。
6. **工具卡去重**：`assistant/chunk` 的 block-end（tool-call 块）与 `tool/call` 事件是同一调用的两次表达，`foldEvents` 按 callId 去重合并，`tool/result` 按 `message.content[0].toolCallId` 回填。

## 依赖总览

```
M0.1 版本单一来源 ─┐
M0.2 权限 v1 ──────┤
M0.3 DshScene 补全 ─┼─（互不依赖，可并行）
M0.4 重启体验 ─────┘
M1.1 RWKV 工具真机验证 → M1.2 分层路由 v2（依赖 M1.1 结论）
M1.3 preset 本地通路（依赖 M0.x 无关，可并行）
M1.4 VRAM 联动（独立）
M1.5 本地多模态（独立，可滑入 P4）
M2.x 依赖 M0.4（重启体验稳定后再动会话级能力）
M3.x 依赖 M1.2（记忆摘要走本地路由）
M4.x 依赖 M0.2（权限 v1 是安全深化的地基）
```

---

## P0 基础加固

### M0.1 版本单一来源（0.5 天）

| 项 | 内容 |
|---|---|
| 改动 | 1) 新增 `packages/shared/agent-versions.json`：`{nodeVersion, dshNpmSpec, bundledPlugins[]}`；2) `scripts/generate-agent-versions.cjs` 生成 `packages/shared/src/agentVersions.ts` + Rust 常量文件 `src/apps/desktop/src/agent_versions.gen.rs`（照 server-endpoints 生成模式）；3) `dsh_manager.rs:28-30` 改用生成常量；4) `scripts/dsh-plugin-check.mjs` resolveNodeDir 改读同一 JSON |
| 涉及 | `dsh_manager.rs`、`scripts/dsh-plugin-check.mjs`、`packages/shared/*`、`scripts/generate-agent-versions.cjs` |
| 验证 | `node scripts/generate-agent-versions.cjs` 两端产物一致；`node scripts/dsh-plugin-check.mjs <本地好包>` 不再需要 `AI00X_CHECK_NODE_DIR` 即可跑绿 |
| 风险 | 低；生成脚本失败回退手工双写（临时） |

### M0.2 per-plugin 权限 v1（2-3 天）

| 项 | 内容 |
|---|---|
| 改动 | 1) `internal_api.rs`：路由按 scope 分组常量表 `{path前缀 → scope}`（notify/wallpaper/todo/xp/plan/git）；2) 插件回呼要求带 `X-Ai00-Plugin-Id` header；宿主维护 `pluginId → granted scopes`（来源：安装时市场 manifest permissions + bundled 全量）；未授权 scope 返回 403 + `X-Ai00-Required-Scope`；3) bundled 插件（ai-bridge/tools）默认全量授权，第三方逐项授权；4) 未授权时宿主 emit `dsh://permission-requested`，DshScene 弹授权卡（复用 ApprovalCard 交互，持久化授权到 `%APPDATA%/Ai00-X/dsh/plugin-grants.json`）；5) `client_factory.rs:31` `DEFAULT_AI00_S_INTERNAL_TOKEN` 兜底移除：无 env 时内部 API 面不挂载（fail-closed），启动日志显式说明 |
| 涉及 | `internal_api.rs`、`dsh_manager.rs`（grants 读写 + 事件）、`DshAPI.ts`、`useDshChat.ts`、`DshScene.tsx`（授权卡）、`DshPluginsConfig.tsx`（权限列展示已授权 scope）、i18n `settings/dsh-plugins.json` |
| 验证 | curl 矩阵：bundled 插件 id + 正确 token → 200；伪造第三方插件 id 调 `/ai00-internal/xp` → 403；授权后重放 → 200；无 token → 401；`AI00_S_INTERNAL_TOKEN` 未设时 2100 上无 `/ai00-internal/*` 路由 |
| 风险 | dsh 引擎侧第三方插件**不会自动带** Plugin-Id header——第三方插件需自行声明；v1 先对 bundled 强制、第三方缺 header 按"未授权"处理并日志提示（诚实降级，不是假安全）；市场提交模板更新说明此约定 |
| 回滚 | grants 机制独立模块，revert 单 commit |

### M0.3 DshScene 渲染与会话管理补全（1-2 天）

| 项 | 内容 |
|---|---|
| 改动 | 1) `DshAPI.ts` `foldEvents` 补 tool-result 类事件的折叠卡数据结构；2) `DshScene.tsx` 新增工具调用折叠卡（工具名 + 参数摘要 + 结果/错误，点击展开），样式走 design-system token；3) 会话列表项接 `session.rename`（引擎已有）与删除确认；4) 引擎 Failed 态（重试耗尽）加"重启引擎"按钮 → `invoke('dsh_stop')` + `dsh_ensure_ready`（需 dsh_manager 暴露重置重试计数的命令 `dsh_restart`） |
| 验证 | 真机：触发 ai00_notify 工具调用 → 折叠卡出现且结果可展开；重命名/删除会话刷新列表正常；手工 kill sidecar 5 次触发 Failed → 按钮重启恢复 |
| 风险 | foldEvents 事件类型清单需抓真机 mux 帧核对（沿用 WS 监听脚本抓帧法） |

### M0.4 装卸重启体验（1 天）

| 项 | 内容 |
|---|---|
| 改动 | 1) `restart_engine_for_plugins`（`dsh_manager.rs:935-942`）加 `tokio::sync::Mutex` 防并发重启；2) 重启全程 emit `dsh://phase(restarting)` → DshScene 顶条"引擎重启中…"；3) 前端 mux 重连成功后自动重拉 `session.list` 恢复会话列表（现有重连逻辑增强） |
| 验证 | 市场 UI 安装/停用/卸载各一次：全程顶条可见、完成后会话列表自动恢复、无 503 白屏；连续快速点两次停用/启用无竞态崩溃（日志确认单次重启） |

---

## P1 本地/远程混合深化（差异化核心）

### M1.1 RWKV 本地工具调用真机验证（0.5 天 + 真机）

| 项 | 内容 |
|---|---|
| 前提 | 真机 G1x 模型；提示词模板已就位（见参考文档第四节） |
| 步骤 | 1) headless 一键测：`dsh --profile ai00x "读取我的知行列表并通知我"`（网关强制 rwkv-local）；2) WS 抓帧核对 tool/call 事件形态；3) 记录失败模式（工具 JSON 解析/续写垃圾）入参考文档 |
| 验收 | 本地 RWKV 完成一次真实"ai00_todo_read → 汇总 → ai00_notify"任务；5/5 次稳定 |
| 出口 | 通过 → M1.2 放开；不通过 → 保持强制远程，M1.2 只做类别分流（标题/摘要类），工具放开转入 backlog |

### M1.2 网关分层路由 v2（2-3 天，依赖 M1.1）

| 项 | 内容 |
|---|---|
| 改动 | 1) `ai_gateway.rs`：请求类别判定器——`无 tools && payload < 阈值 && (system 含摘要/标题特征 || 历史占比高)` → 归类 `aux`；2) `aux` 类默认 `rwkv-local`，失败自动降级远端重试一次（复用 401 重试骨架 `ai_gateway.rs:380`）；3) M1.1 通过则：R0/R1 + 工具 ⊆ 本地白名单（ai00_notify/ai00_todo_read/ai00_focus_log/ai00_plan_read）→ 本地，其余仍远程；4) 路由决策日志打 `[DshGateway] route class=X tier=Y model=Z`（进 ai.log） |
| 基线 | 改造前跑 10 个典型策窗口任务记录远端 token 消耗（dsh usage 帧求和） |
| 验收 | 同批任务重放，远端 token 降 ≥ 30%；aux 类误路由无感（降级兜底）；`ai00-auto` 显式选择行为不变 |
| 风险 | 判定阈值过激伤质量——先保守阈值 + 日志观察一周再收紧 |

### M1.3 agent preset 本地通路（1 天，可与 M0 并行）

| 项 | 内容 |
|---|---|
| 改动 | 1) `agent-modules.ts` 的 `AgentModule` 增加 `agentPreset` 字段并实际下发（现固定 `getAgentModule('agent')`）；2) `useAgentDelegate` session.create 传 preset（核对 dsh session.create 参数契约）；3) Rust 侧 `.agent-presets` 增加 `ai00x-research` 示例（模型档位注明 rwkv-local 供 aux 用的写法按 dsh agent.cordis.yml 契约调研后定） |
| 验证 | 策窗口选择不同模块 → dsh 会话 system prompt/模型符合 preset；ai00x-wallpaper preset 生效 |

### M1.4 VRAM 与 dsh 会话联动（0.5 天）

| 项 | 内容 |
|---|---|
| 改动 | 1) Tauri 命令 `dsh_session_created`（或在 `open_task_window openDsh` 链路内）→ `vram_set_active_context('agent')`；2) dsh 会话 idle 检测：前端 mux 断开超 10 分钟 → `vram_set_active_context('idle')` 允许 RWKV 进入正常驱逐档 |
| 验证 | 新建 dsh 会话 → `vram_list_engines` 显示 rwkv warmup；关闭窗口 10 分钟后 tier 下降 |

### M1.5 本地多模态（收尾，可滑入 P4）

| 项 | 内容 |
|---|---|
| 改动 | 1) 内置多模态 GGUF 入 `BUILTIN_GGUF`（`llama_server_manager.rs:857-861`）；2) vision 模型抽象（`image_processing.rs:30-70`）允许解析到 `gguf-local:<path>`；3) dsh 侧图片消息经网关转本地 llama-server OpenAI 兼容接口验证 mtmd placeholder 生效 |
| 验收 | DshScene 发图 → 本地模型返回图像描述（断网验证纯本地） |

---

## P2 上下文与会话治理

### M2.1 turn-rewind spike（1 天，先决策后实施）

| 项 | 内容 |
|---|---|
| 步骤 | 1) 过 `dsh-plugin-check.mjs` 装入 dsh-turn-rewind；2) 审计其 change ledger 与我们 `ai00_task_complete` git 快照（`tools/index.js:464-562`）是否双账本冲突；3) 出决策：引入（M2.1a：市场上架 + DshScene 回滚入口）或自研薄版（M2.1b：git 快照点 + turn 指针回退，宿主侧新命令） |
| 验收 | spike 报告落 参考/（决策记录格式照第四节） |

### M2.2 token 组成面板（1-2 天）

| 项 | 内容 |
|---|---|
| 步骤 | 1) 评估 dsh-context 引入（同 M2.1 流程）；2) 引入则 DshScene 加"上下文"侧板入口展示；不引入则自研薄版：usage 帧（foldEvents 已有 finish/usage）聚合按 block 类别展示 token 占比 |
| 验收 | DshScene 可见当前会话 token 组成；与 dsh usage 帧数字对账 |

### M2.3 evals 进环：DoD 验证命令（1-2 天）

| 项 | 内容 |
|---|---|
| 改动 | 1) 计划 MD"## 验收"条目支持 `` - `{cmd: npm test}` `` 形式；2) `ai00_task_complete`（`dsh-plugins/tools/src/index.js:464-562`）在勾选判定前逐条执行验证命令、捕获输出，失败条目直接报错自纠（沿用现有 DoD 报错通道）；3) 命令白名单：仅 cwd 相对路径、禁网络类命令（初始白名单由宿主配置）；4) 知行计划模板（web-ui 侧）加格式提示 |
| 验收 | 带验证命令的任务：命令失败 → agent 收到失败输出继续修；全过 → 完成入账；无验证命令任务行为不变 |

### M2.4 会话 fork（1-2 天）

| 项 | 内容 |
|---|---|
| 步骤 | 1) 调研 dsh 引擎 fork/clone 能力（0.1.x 有无 session.clone RPC）；2) 有 → DshScene 会话菜单加"派生"；无 → 自研：任务书 prompt 重建 + 历史摘要注入（摘要走 M1.2 aux 本地路由）；3) 策窗口入口：任务卡"重派 agent"按钮 |
| 验收 | 长任务失败后派生新会话，携带任务书与失败摘要重新执行 |

---

## P3 记忆与自动化

### M3.1 跨会话记忆（3-4 天，依赖 M1.2）

| 项 | 内容 |
|---|---|
| 改动 | 1) 策展引入 dsh-memory-evolve（市场门禁流程 + 权限审读）；2) 宿主侧新 `/ai00-internal/memory` CRUD（`internal_api.rs`，存储照知行模式）；3) 记忆演进/压缩请求在 ai-bridge 标注 `aux-memory` 类别 → M1.2 判定器走 rwkv-local；4) 设置页"Agent 记忆"管理入口（列表/搜索/删除，i18n 新 namespace） |
| 验收 | 跨会话记忆生效（会话 A 告知偏好 → 会话 B 引用）；记忆条目 100% 本地摘要生成；用户可查删 |
| 风险 | memory-evolve 若强绑官方存储路径 → 自研薄版（会话结束时摘要提取 + prompt 注入 `<memory>` 块，实现在 ai-bridge 层） |

### M3.2 定时自动化（2-3 天）

| 项 | 内容 |
|---|---|
| 改动 | 1) 评估 dsh-automation 引入；2) 无论引入与否实现宿主侧派发：知行周期任务克隆时（`ai00_task_complete` 克隆分支）带 `auto_dispatch` 标记 → 宿主定时器（desktop 侧 `tokio` interval 任务）到期调 `dsh_ensure_ready` + headless 会话派发任务书 → 完成回调 `ai00_notify` + 卡片状态回写（复用 useAgentDelegate 的回写协议）；3) 设置页开关 + 免打扰时段 |
| 验收 | 周期任务开启自动派发 → 到期自动建会话执行 → 完成通知 + 知行状态流转；引擎未运行时自动拉起 |
| 风险 | 无人值守派发的工具审批：白名单任务（只读 + notify）自动批准，其余跳过并转人工队列 |

---

## P4 多智能体与安全深化

### M4.1 agent preset 多模块化（2 天）

- `agent-modules.ts` 扩展：`agent`（通用）/ `wallpaper`（openStudio）/ `research`（planHint + deep-research 风格）/ `code`（cwd 绑定志目录）；`useAgentDelegate` 按 todo 卡 tag 自动选模块；Rust `.agent-presets` 对应 cordis.yml（persona + 工具白名单 + 模型档位）。
- 验收：四类任务卡各建会话，system prompt 与工具集符合 preset。

### M4.2 子 agent 可视化（2-3 天）

- 抓真机 mux 帧确认 dsh 子 agent 事件形态（session/subagent 类帧或嵌套 step）；DshScene 嵌套折叠卡（父工具卡内子 agent 流式内容，参照老系统 TaskToolDisplay 交互但走 dsh 帧协议）；不侵入引擎。
- 验收：触发子 agent 的任务在 DshScene 可见父子层级与子 agent 流式输出。

### M4.3 dsh-agent-teams / dsh-deep-research 评估（1 天 spike）

- 过检测流水线 + 权限审读（两者均需 `X-Ai00-Plugin-Id` 约定配合 M0.2）+ 真机小任务试用 → 决策记录落 参考/。

### M4.4 安全深化（2 天）

1. DShScan 风险评分并入 `dsh-plugin-check.mjs` report（`riskScore` 字段，审核页展示）；
2. dsh-credentials-keyring 引入评估（凭证类插件依赖前置）；
3. sandbox-micro microVM 立项报告（对应 M0.2 中期真隔离；含与 sidecar 启动链的集成方案草案）。

---

## 里程碑汇总

| 阶段 | 里程碑 | 估时 | 依赖 |
|---|---|---|---|
| P0 | M0.1 版本单一来源 | 0.5d | — |
| P0 | M0.2 权限 v1 | 2-3d | — |
| P0 | M0.3 DshScene 补全 | 1-2d | — |
| P0 | M0.4 重启体验 | 1d | — |
| P1 | M1.1 RWKV 真机验证 | 0.5d | — |
| P1 | M1.2 分层路由 v2 | 2-3d | M1.1 |
| P1 | M1.3 preset 本地通路 | 1d | — |
| P1 | M1.4 VRAM 联动 | 0.5d | — |
| P1 | M1.5 本地多模态 | 1-2d | — |
| P2 | M2.1 rewind spike | 1d | M0.4 |
| P2 | M2.2 token 面板 | 1-2d | M0.3 |
| P2 | M2.3 evals 验证命令 | 1-2d | — |
| P2 | M2.4 会话 fork | 1-2d | M0.4 |
| P3 | M3.1 跨会话记忆 | 3-4d | M1.2 |
| P3 | M3.2 定时自动化 | 2-3d | M1.2 |
| P4 | M4.1 preset 多模块 | 2d | M1.3 |
| P4 | M4.2 子agent 可视化 | 2-3d | M0.3 |
| P4 | M4.3 teams/research 评估 | 1d | M0.2 |
| P4 | M4.4 安全深化 | 2d | M0.2 |

P0 全并行约 1 周；P0+P1 约 2-2.5 周；全路线约 5-6 周（不含前瞻候选）。

## 执行状态（2026-09-06）

| 里程碑 | 状态 | 验证方式与结果 |
|---|---|---|
| M0.1 版本单一来源 | ✅ 完成 | `agent-versions.json` + `generate-agent-versions.cjs` 生成 TS/Rust 常量（幂等重跑一致）；`dsh_manager.rs` 与 `dsh-plugin-check.mjs` 同源；cargo check 通过 |
| M0.2 权限 v1 | ✅ 完成（Rust+插件侧） | `internal_api.rs` 双层鉴权（token + scope：bundled 全量 / grants / 未标识 BASIC）；grants 文件 + `dsh://permission-requested` 事件 + `dsh_plugin_grants_list/grant/revoke` 命令；tools 插件回呼带 `X-Ai00-Plugin-Id`；前端授权卡。curl 矩阵待真机 |
| M0.3 DshScene 补全 | ✅ 完成 | tool/call+tool/result 完整渲染（含 pending/错误态/结果块）；rename（行内编辑）；fork（原生 RPC）；Failed 态重启按钮 |
| M0.4 重启体验 | ✅ 完成 | `restart_lock` 串行化（并发装卸合并重启）；restarting phase 广播；mux 重连自动恢复会话列表与当前会话 history |
| M1.1 RWKV 真机验证 | ⏳ 待真机 | 需真机 G1x 模型；代码侧就绪（提示词模板已在） |
| M1.2 分层路由 v2 | ✅ 完成（默认保守） | 本地工具白名单（只读+通知类）+ env `AI00X_DSH_LOCAL_TOOLS=1` 开关（默认关，M1.1 验证后放开）；本地分支失败自动降级远程；单测 9/9（含白名单/开关默认值） |
| M1.3 preset 通路 | ✅ 完成 | `delegate(task, moduleId?)` + `agentPreset` 透传 + cwd 策略按模块生效 |
| M1.4 VRAM 联动 | ✅ 完成 | delegate + DshScene 新建会话 → `vram_set_active_context('agent')` 预测 warmup |
| M2.1 rewind spike | ⏳ 未开始 | 实施前先核对原生 session-checkpoint（自查修订 #5） |
| M2.2 token 面板 | ✅ 完成（薄版） | `aggregateUsage`（assistant/message usage 聚合）+ 侧栏 `↑输入 ↓输出 · 请求数` |
| M2.3 evals 验证命令 | ✅ 完成 | 计划验收条目 `{cmd: ...}` 由 ai00_task_complete 实际执行（cwd=snapshotDir，120s 超时，输出截断 2000 字符，拒绝嵌套 shell 展开）；失败输出回灌自纠 |
| M2.4 会话 fork | ✅ 完成 | 引擎原生 session.fork 接入（DshAPI + 侧栏 fork 按钮） |
| M3.x / M4.x | ⏳ 未开始 | M4.1 的模块注册与 preset 通路已随 M1.3 落地（壁纸模块 `ai00x-wallpaper`）；其余待后续批次 |
| 回归验证 | ✅ | `cargo test -p ai00-x-desktop`：53/53；`cargo clippy --all-targets`：0 警告；`tsc --noEmit`、ESLint、stylelint：0 违规；web-ui 生产构建通过 |

**待真机验证清单**（代码已就绪，需运行桌面客户端）：① 权限 403 → 授权卡 → 授予恢复全链路；② 插件装卸重启横幅 + 会话恢复；③ rename/fork UI；④ 用量面板与 usage 帧对账；⑤ M1.1 RWKV 工具链真机 5/5。

## 全局风险与回滚

1. **dsh 0.1.x 是 developer preview**：升级引擎版本可能破坏 ai-bridge/tools 契约——每次升级前跑 `dsh-plugin-check.mjs` + ai-bridge 5 单测；版本钉死在 agent-versions.json（M0.1）。
2. **混合路由质量回归**：保守阈值起步 + 全程路由日志 + 降级兜底；基线任务集（10 个）作为回归工具。
3. **第三方插件权限约定落地难**：M0.2 v1 只强制 bundled；市场审核加"是否声明 Plugin-Id"检查项过渡。
4. **每个里程碑独立 commit**：revert 不牵连；涉及引擎重启的改动（M0.4/M3.2）先在 dev profile 验证再进安装链。
