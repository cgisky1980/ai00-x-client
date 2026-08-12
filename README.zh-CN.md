**中文**  [English](README.md)

<div align="center">

[![GitHub release](https://img.shields.io/github/v/release/cgisky1980/ai00-x-client?style=flat-square&color=blue)](https://github.com/cgisky1980/ai00-x-client/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)](https://github.com/cgisky1980/ai00-x-client)

</div>

---

## 简介

Ai00-X 是一个 AI 个人助理形态的桌面客户端，基于 **Tauri 2.0**，使用 **Rust** 与 **TypeScript** 构建。它将 Agent 系统、本地推理引擎与桌面陪伴形态集成到一个可独立运行的桌面应用中。

### 混合推理模式：RWKV 本地推理 + 远程 AI API

Ai00-X 主打一个 **省钱**：采用 **RWKV 本地推理 + 远程 AI API** 的混合路线，**能本地的就本地**。

- **RWKV 本地推理**：优先在本地运行 RWKV 模型完成 LLM / ASR / TTS 等任务，**零 API 费用、数据不出本机、隐私安全**。RWKV 能力持续提升，本地模型能做到的事情越来越多。
- **远程 AI API**：当本地模型能力不足以胜任复杂任务（如深度 Agentic 编程、专业领域知识）时，自动切换到远程大模型 API（支持 Anthropic / OpenAI / Gemini 等），按需付费。
- **智能调度**：既能享受本地推理的免费与隐私，又能随时调用云端最强模型，**按需花钱、把钱花在刀刃上**。

### 核心特性

- **Agent 系统**：个人助理、代码代理、知识工作代理、自定义 Agent
- **本地推理**：RWKV / llama.cpp（LLM / ASR / TTS）、ACE-Step（音乐生成）、SA3（音频生成）
- **桌面陪伴**：overlay / underlay 动画宠物形态
- **远程接入**：手机浏览器、Telegram、飞书、微信远程指令

---

## 核心能力

### Agent 体系

| Agent | 定位 | 核心能力 |
| ----- | ---- | ----- |
| 个人助理 | 专属 AI 伙伴 | 长期记忆、个性设定；按需调度 Code / Cowork / 自定义 Agent |
| Code Agent | 代码代理 | Agentic（自主读改跑验证）/ Plan（先规划后执行）/ Debug（插桩取证→根因定位）/ Review（规范审查） |
| Cowork Agent | 知识工作代理 | 内置 PDF / DOCX / XLSX / PPTX 处理 |
| 自定义 Agent | 垂域专家 | 通过 Markdown 快速定义专属领域 Agent |

### 本地推理引擎

| 组件 | 用途 | 来源 |
| ---- | ---- | ---- |
| llama.cpp | LLM / ASR / TTS | 源码编译（按平台选 CUDA / Vulkan / Metal 后端） |
| GGML | 共享推理运行时 | 源码编译（llama 与 acestep 共用一份） |
| ACE-Step | 音乐生成 | 源码编译 |
| ONNX Runtime | TTS ONNX 推理 | 预下载官方产物随包分发 |
| MNN | SA3 音频生成 | 预下载上游产物随包分发 |

> **Runtime 打包原则**：能自己从源码编译的组件编译后随安装包一起分发；无法源码编译的大型依赖预下载官方/上游产物并随包分发，**不再依赖运行时在线下载**。详见 `scripts/pack-runtime.mjs`。

### 生态扩展

支持 Skill、MCP（含 MCP App）、自定义 Agent，以及即用即生的 Mini App。

---

## 平台支持

Tauri 2.0：**Windows / macOS / Linux**。桌面端通过统一 API 与后端服务通信，并支持手机浏览器、Telegram、飞书、微信等远程指令接入。

---

## 架构

```
src/
├── apps/desktop/          # Tauri 2.0 桌面应用（ffi、server、tts、asr、overlay、underlay）
├── crates/                # Rust crate 工作区
│   ├── core/              # Agent 核心业务逻辑（跨平台）
│   ├── inference/         # llama.cpp 推理封装（build.rs 编译）
│   ├── acestep/           # ACE-Step 音乐生成封装
│   ├── sa3/               # SA3 音频生成封装
│   ├── ai-adapters/       # AI 客户端适配器（Anthropic / OpenAI / Gemini）
│   ├── transport/         # 传输适配器（Tauri）
│   ├── relay/             # 远程连接中继（HTTP <-> WebSocket）
│   └── webdriver/         # WebDriver 浏览器自动化
├── web-ui/                # React 前端（桌面与 Web 复用同一套代码）
├── loader-ui/             # 加载器 UI
└── underlay-ui/           # 桌面宠物底层 UI
```

技术栈：**Rust**（Tokio、Tauri 2.0、Axum、Salvo）+ **React 19 / TypeScript / Vite**，使用 **pnpm** 管理 monorepo。

---

## 快速开始

### 直接下载使用

在 [Releases](https://github.com/cgisky1980/ai00-x-client/releases) 页面下载对应平台的安装包，安装后配置模型即可开始使用。

### 从源码构建

**前置依赖：**

- [Node.js](https://nodejs.org/)（推荐 LTS 版本）
- [pnpm](https://pnpm.io/)
- [Rust 工具链](https://rustup.rs/)
- [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)（桌面端开发需要）

**运行指令：**

```bash
# 安装依赖
pnpm install

# 以开发模式运行桌面端
pnpm run desktop:dev

# 构建桌面端
pnpm run desktop:build
```

> **注意**：桌面客户端通过统一 API 与后端服务通信。启动前需先部署并启动对应的后端服务，并配置客户端连接（含 `AI00_S_INTERNAL_TOKEN` 环境变量，用于 CSRF 豁免）。

---

## 开发指南

- Rust 构建/检查请使用 release 模式：`cargo build --release` / `cargo clippy --all-targets --release -- -D warnings`
- 提交前运行 `cargo fmt --all`
- 前端类型检查：`pnpm run type-check:web`
- 详细规范请参阅 [AGENTS.md](./AGENTS.md)

---

## 贡献

欢迎大家贡献好的创意和代码，我们对 AI 生成代码抱有最大的接纳程度。请 PR 优先提交至 `dev` 分支，我们会定期审视后同步到主干。

**我们重点关注的贡献方向：**

1. 贡献好的想法 / 创意（功能、交互、视觉等），提交 Issue
2. 优化 Agent 系统和效果
3. 提升系统稳定性和完善基础能力
4. 扩展生态（Skill、MCP 等）

---

## 声明

1. 本项目为业余时间探索、研究构建下一代人机协同交互，非商用盈利项目。
2. 本项目依赖和参考了众多开源软件，感谢所有开源作者。**如侵犯您的相关权益请联系我们整改。**