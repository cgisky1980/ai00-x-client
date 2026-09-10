# 宠物立绘自动生产链 v1（LongCat-Image / -Edit 本地化）

## 目标

在本机（RTX 2080 Ti 22GB + ComfyUI）搭建无人值守的宠物立绘生产线：
**物种 JSON 规格 → 锚点立绘（LongCat-Image）→ 三段进化链（LongCat-Image-Edit 多轮编辑）→ 色彩变种种（纯代码 hue-shift）→ 抠底/缩略图 → 本地 VLM 自动质检 → 人工复核页**。
跑通后图鉴/邀请卡/UI 立绘全供给；动画迁移（Wan-Animate-2）留二期。

## 位置与现状（已侦察）

- 新建独立目录 `C:\work\ai00-x-dev\pet-pipeline\`（不进 client 仓库，美术资产不污染产品库）
- 复用：ComfyUI（`C:\ComfyUI`，portable，需升级到支持 LongCat 的版本）、uv + Python 3.13、llama-server.exe b10837（带 mtmd 多模态，在 `client\.llama-build\bin\Release`）
- ⚠️ C 盘仅剩 118GB：模型下载按量化优先，预算 ~30GB；不够则清 HF 缓存的 Z-Image/SVD（~20GB，已过时不用）

## Phase 0 环境与模型冒烟（~0.5 天）

1. 升级 ComfyUI（其自带 update 机制），确认 LongCat 节点可用
2. 下载模型（GGUF 量化优先）：LongCat-Image（T2I）+ LongCat-Image-Edit + 配套 text-encoder/VAE 组件，按 ComfyUI 官方 LongCat 工作流的清单补齐 `models/` 各子目录
3. 冒烟：官方 T2I / Edit 工作流各出 1 张图，验证 Turing fp16 路径（VAE 用 tiled decode 防 NaN 黑帧）——**这是全案第一个风险点，最先验证**
4. 记录磁盘账本

## Phase 1 自动化骨架（~1 天）

```
pet-pipeline/
├── pyproject.toml            # uv 管理；依赖：httpx, Pillow, rembg, rich
├── workflows/                # t2i_api.json / edit_api.json（ComfyUI API 格式模板）
├── species/                  # 物种规格 *.json
├── output/<species_id>/      # anchor.png, stage2/3.png, variants/, thumbs/, manifest.json, qc.json
├── review/                   # gallery.html + verdicts.json
└── src/petpipeline/          # comfy.py(ComfyUI HTTP API 客户端) chain.py(生成编排)
                              # post.py(抠底/缩略/变种种) qc.py(VLM 评分) runner.py(批量调度) review.py(复核页)
```

- ComfyUI 走 HTTP API（POST /prompt + /history 轮询），工作流模板化注入 prompt/seed/参考图
- 物种规格 schema：id、基因词表（体型/元素/部件/气质）、三段进化描述、色板、固定 seed（可复现）
- 调度器：`state.json` 断点续跑、失败自动换种子重试（≤3 次）、NDJSON 日志

## Phase 2 生成链（~1.5 天）

- **锚点**：基因词表 → Q 版怪物 prompt 模板 → T2I
- **进化链**：Edit 三连（stage1→2→3），"同一生物进化"指令 + 低强度身份保持参数
- **变种种**：Pillow hue-shift（不走模型，零成本）
- **后处理**：rembg 抠底 → 512px 透明 PNG + 128px webp 缩略图 + manifest.json（含 SHA1，为日后同步到 Ai00-Salvo `pet/` vhost 预留——复用 pet-custom-system 已验证的 admin files API 通道）

## Phase 3 质检闭环（~1 天）

- 复用现成 llama-server.exe 跑 Qwen2.5-VL-7B GGUF Q4（下载 ~6GB），无需新装任何推理框架
- 自动评分三维度：Q 版怪物纯度 / 透明底干净度 / 三段进化一致性（成对喂图）
- 三级分流：自动通过（≥阈值）→ 自动重生成（换种子）→ 人工复核
- `pipeline review` 生成单页 HTML gallery 人工过目，verdicts 写回后 `pipeline apply` 归档

## Phase 4 试产验证（~0.5 天）

1. 我起草 20 个物种设定集（基于 G9 报告的基因词表），你过目修订
2. 10 物种端到端试产 → 你复核 → 放开 100 物种夜批

## 验证标准

10 物种 × 3 段立绘 + 缩略图 + manifest + 质检报告全绿；中途 kill 进程后断点续跑正常；一批任务无人值守跑完。

## 不做（二期）

动画迁移（Wan-Animate-2 动作库 → sprite sheet）、风格 LoRA 训练（先攒 ~200 张人工精选锚点）、pet-custom-system 同步适配、客户端集成。

## 风险与对策

- **Turing 兼容**：LongCat 节点 fp16 路径未验证 → Phase 0 冒烟最先做
- **磁盘**：量化优先 + 账本制；预留清理方案
- **LongCat 动漫原生偏弱**（社区实测偏写实）：v1 靠基因词表 prompt 工程硬约束，风格收敛靠二期 LoRA（官方 Dev 检查点 + 训练框架现成）

合计 ~4.5 人日。