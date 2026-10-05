# 引擎 0.2.0-rc.2 的 Ai00-X patch 资产目录

## 本目录是什么

`@deepseek-ai/dsh@0.2.0-rc.2` 专用的编排 patch 资产（版本限定）。
`dsh_manager::ensure_orchestration_patch` 按 `dsh_versions.gen.rs` 的当前
版本加载同名目录；**引擎升级时必须新建对应版本目录并逐行核对**，缺失目录
= 启动期显式报错（不静默回退）。

## 文件清单

| 文件 | 角色 | 占位符 |
|---|---|---|
| `orchestration-head.patch.yml` | 静态头：主对话 persona 覆写 + bundled-skills 挂载 | `{BUNDLED_SKILLS_DIR}` `{WORKER_NAMES}` |
| `hooks-row.yml.tmpl` | Claude Code 兼容 hooks 桥挂载行（insert 段） | `{CONFIG_PATH}` |
| `mcp-row.yml.tmpl` | MCP 桥接行骨架（insert 段，transport 动态体由代码追加） | `{SERVER_NAME}` `{TRANSPORT_BODY}` |
| `capability-rows.yml.tmpl` | 能力包挂载行：computer-use（Cua 驱动）；包本体由 install_capability_packages 全局安装 | 无 |

## 能力吸纳注记（2026-10-02）

- **computer-use**：挂载必须走 patch 行（`- name:` 行）——两包无 dsh.bundle
  声明，挂成 profile bundle 是空贡献（实测 dump 无差异）。包不在主包依赖里，
  需全局安装（install_capability_packages，registry 降级链，best-effort）。
- **遥测**：引擎 session-telemetry 默认 FEEDBACK_ONLY（用户点反馈即上传会话前缀
  到 dsh-otel-collector.deepseeksvc.com），spawn 已设 `DSH_TELEMETRY_MODE=DISABLED`；
  产品遥测因 profile 名非 desktop 已自动关闭。
- **已由 base 默认挂载**（无需动作，dump 已核实）：mcp-resources、
  compaction-image-offload、shortcuts。
- **评估后不吸纳**：browser-use 家族（与内置 agent-browser 技能/webdriver 重叠）、
  ssh 沙箱家族（场景弱）、office-to-pdf、auto-review（experimental）。

## 意图与红线（为什么这么写）

1. **persona 只覆写、不插入**：`- id: system-prompt` 顶层裸行 = 按 id 覆盖
   既有条目。规划者 persona 挂在 system-prompt 行的 `config.persona`
   （deployment persona 槽）。该槽全局唯一——另插
   `@deepseek-ai/dsh-persona` 行会重复注册导致 boot 崩溃
   （2026-09-11 实测，症状=sidecar 起不来、dsh-api 全 502）。
2. **模型分工**（与 ai_gateway.rs 白名单同源约定）：
   - research_worker：只读六件套 + model=ai00-auto → 网关 SmartRouter /
     hybrid_tool_loop 判级 R0/R1 走本地 RWKV（零成本），失败自动远端；
   - code_worker：执行类工具 + model=ai00-salvo → 远端强模型。
3. **工具名为引擎注册名**：dsh-tool-fs: read/read_image/edit/write、
   dsh-tool-fs-search: glob/grep、dsh-tool-pwsh: pwsh、dsh-tool-bash: bash、
   dsh-tool-skill: skill、dsh-tool-todo: todo_write、dsh-tool-web:
   web_fetch/web_search。改动组合后用 `dsh --profile ai00x --dump-config`
   验证（DSH_HOME 指向 dsh_home()）；组合 boot 时装配，sidecar 重启生效。
4. **0.2.0-rc.2 版本特有注意**：
   - web 服务端拆为显式 bundle `@deepseek-ai/dsh-web-app`（profile bundles
     必须显式挂载，缺它 boot 静默挂起零输出）；
   - `/api` 全量鉴权（按方法 loopback 豁免移除），token→cookie 链必需；
   - `dsh web` 子命令取消，CLI 形式为 `dsh --profile <name> [options]`，
     options 后不能再跟 "web" 词元（会被当 app 参数挂死）；
   - dsh-mcp-client 配置校验变严：serverName 必须配 command(stdio) 或
     url(streamable-http)。
5. **变更纪律**：patch 行为改动与引擎版本升级分开提交；升级时对照上游新版
   变更逐行核对本目录（参考 dsh-desktop 项目的 patches/ 目录做法）。
