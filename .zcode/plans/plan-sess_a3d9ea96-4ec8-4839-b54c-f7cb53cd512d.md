## 修复计划：工灵点击 + 对话浮层视觉规范对齐

### 1. 工灵点击修复（AgentTheaterWidget.tsx）
- **IdleChip 挂事件**：单击 → 打开策（dsh）场景（复用 `requestDshSession` 路由）；加 `cursor: pointer` 与 hover 态；tooltip 说明。双击同单击（无会话可开对话）。
- 真工灵点击：保留现有 <5px 阈值逻辑；openCard 后 `refreshRegions()`（卡片出现改变根矩形，确保捕获区域重算）。

### 2. 对话浮层 8 向 resize（SessionChatPanel.tsx + SCSS）
- 按 MusicPopup 模式补齐 **8 个手柄**（n/s/e/w 6px 边 + ne/nw/se/sw 12px 角，cursor 各向，hover 黛青），`usePopupResize` 已支持 8 向，替换现有单 se 手柄。

### 3. 视觉规范对齐（新东方极简）
- **配色**：`impVisualCore.ts` 的 IMP_PALETTE 移除 purple/success/warning，收敛为黛青系（--color-accent-300/400/500）+ 墨阶（--color-text-secondary/muted、--element-bg-base/medium）；类别差异由模板形状承担。同步更新确定性单测。
- **标题带**：对话浮层头部改「沉一档」配方（`--color-bg-sunken` + 底部细分隔线 + grab 光标 + GripHorizontal 拖把手图标），对齐 MusicPopup header。
- **输入框**：原生 `<input>` 替换为组件库标准 `Input`（`@/component-library`，variant 默认、inputSize small）；发送/停止改用 `IconButton`/`Button`（primary 用黛青）。
- **排版**：统计行与工具 chip 加 `font-variant-numeric: tabular-nums`（mono 已有）；消息正文 14px/1.5；浮层标题 14px/600。
- **间距**：全部收敛到 `--size-gap-*` 4px 刻度；z-index 走 `--z-chrome-overlay` 刻度。

### 4. 验证
- tsc / eslint / stylelint / vitest 全绿 → 构建 main.zip → 替换 target/release → `--server=test` 重启客户端。

### 不做
- 不改 useDraggable / usePopupResize / mouseThrough 核心机制（只消费）。
- 不动 todo 看板与 SessionChatPanel 的功能接线（只改样式与事件）。