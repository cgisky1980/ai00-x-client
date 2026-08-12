[中文](README.zh-CN.md) | **English**

<div align="center">

[![GitHub release](https://img.shields.io/github/v/release/cgisky1980/ai00-x-client?style=flat-square&color=blue)](https://github.com/cgisky1980/ai00-x-client/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)](https://github.com/cgisky1980/ai00-x-client)

</div>

---

## Introduction

Ai00-X is an AI personal-assistant desktop client, built on **Tauri 2.0** with **Rust** and **TypeScript**. It integrates an Agent system, local inference engines, and desktop companion forms into a single standalone desktop application.

### Hybrid Inference: RWKV Local + Remote AI API

Ai00-X is built around **saving you money**: it adopts a **RWKV local inference + remote AI API** hybrid approach — **if it can run locally, it runs locally**.

- **RWKV Local Inference**: runs RWKV models locally for LLM text inference first — **zero API cost, data never leaves your machine, private and secure**. RWKV's capabilities keep improving, so the local model can handle more and more. Local inference also covers Qwen3 ASR / TTS (speech recognition and synthesis), music and audio generation.
- **Remote AI API**: when the local model is not strong enough for complex tasks (deep agentic coding, specialized domain knowledge), it automatically falls back to remote LLM APIs (Anthropic / OpenAI / Gemini, and more), paying per use.
- **Smart Routing**: enjoy the free and private local inference while still having access to the strongest cloud models anytime — **pay only when it matters**.

### Core Features

- **Agent System**: personal assistant, coding agent, knowledge-work agent, custom agents
- **Local Inference**: RWKV / llama.cpp (LLM / ASR / TTS), ACE-Step (music generation), SA3 (audio generation)
- **Desktop Companion**: animated pet forms via overlay / underlay
- **Remote Access**: phone browser, Telegram, Feishu, WeChat remote commands

---

## Core Capabilities

### Agent System

| Agent | Role | Core Capabilities |
| ----- | ---- | ----------------- |
| Personal Assistant | Your dedicated AI companion | Long-term memory and personality; orchestrates Code / Cowork / custom Agents on demand |
| Code Agent | Coding agent | Agentic (autonomous read / edit / run / verify) / Plan (plan-then-execute) / Debug (instrument → root cause) / Review (standard-based review) |
| Cowork Agent | Knowledge-work agent | Built-in PDF / DOCX / XLSX / PPTX handling |
| Custom Agent | Domain specialist | Quickly define a domain-specific Agent with Markdown |

### Local Inference Engine

| Component | Models | Purpose | Source |
| --------- | ------ | ------- | ------ |
| llama.cpp | RWKV (LLM), Qwen3 (ASR / TTS) | Local inference engine | Compiled from source (per-platform CUDA / Vulkan / Metal backend) |
| GGML | — | Shared inference runtime | Compiled from source (shared by llama & acestep) |
| ACE-Step | — | Music generation | Compiled from source |
| ONNX Runtime | — | TTS ONNX inference | Pre-downloaded official artifacts bundled with the app |
| MNN | — | SA3 audio generation | Pre-downloaded upstream artifacts bundled with the app |

> **Runtime packaging principle**: components that can be compiled from source are built and shipped with the installer; large dependencies that cannot be compiled easily are pre-downloaded from official/upstream artifacts and bundled — **no runtime online download**. See `scripts/pack-runtime.mjs`.

### Ecosystem

Supports Skills, MCP (including MCP App), custom Agents, and on-demand Mini Apps.

---

## Platform Support

Tauri 2.0: **Windows / macOS / Linux**. The desktop client talks to backend services through a unified API, and supports remote commands via phone browser, Telegram, Feishu, WeChat, and more.

---

## Architecture

```
src/
├── apps/desktop/          # Tauri 2.0 desktop app (ffi, server, tts, asr, overlay, underlay)
├── crates/                # Rust crate workspace
│   ├── core/              # Agent core business logic (cross-platform)
│   ├── inference/         # llama.cpp inference wrapper (compiled by build.rs)
│   ├── acestep/           # ACE-Step music generation wrapper
│   ├── sa3/               # SA3 audio generation wrapper
│   ├── ai-adapters/       # AI client adapters (Anthropic / OpenAI / Gemini)
│   ├── transport/         # Transport adapter (Tauri)
│   ├── relay/             # Remote connect relay (HTTP <-> WebSocket)
│   └── webdriver/         # WebDriver browser automation
├── web-ui/                # React frontend (shared between desktop & web)
├── loader-ui/             # Loader UI
└── underlay-ui/           # Desktop pet underlay UI
```

Tech stack: **Rust** (Tokio, Tauri 2.0, Axum, Salvo) + **React 19 / TypeScript / Vite**, using **pnpm** for the monorepo.

---

## Quick Start

### Download and use

Download the installer for your platform from [Releases](https://github.com/cgisky1980/ai00-x-client/releases). After installation, configure your model and start using Ai00-X.

### Build from source

**Prerequisites:**

- [Node.js](https://nodejs.org/) (LTS recommended)
- [pnpm](https://pnpm.io/)
- [Rust toolchain](https://rustup.rs/)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (required for desktop development)

**Commands:**

```bash
# Install dependencies
pnpm install

# Run desktop in development mode
pnpm run desktop:dev

# Build desktop
pnpm run desktop:build
```

> **Note**: The desktop client communicates with backend services through a unified API. Deploy and start the corresponding backend service first, and configure the client connection (including the `AI00_S_INTERNAL_TOKEN` environment variable for CSRF exemption).

---

## Development Guide

- Use release mode for Rust build/checks: `cargo build --release` / `cargo clippy --all-targets --release -- -D warnings`
- Run `cargo fmt --all` before committing
- Frontend type check: `pnpm run type-check:web`
- See [AGENTS.md](./AGENTS.md) for detailed conventions

---

## Contributing

We welcome great ideas and code; we are maximally open to AI-generated code. Please submit PRs to the `dev` branch first; we review periodically and sync to the main branch.

**Contribution directions we care about most:**

1. Good ideas / creativity (features, interaction, visuals, etc.)—via Issues
2. Improving the Agent system and outcomes
3. Improving stability and foundational capabilities
4. Growing the ecosystem (Skills, MCP, etc.)

---

## Disclaimer

1. This project is spare-time exploration and research into next-generation human–machine collaboration, not a commercial profit-making project.
2. This project depends on and references many open-source projects. Thanks to all open-source authors. **If your rights are affected, please contact us for remediation.**