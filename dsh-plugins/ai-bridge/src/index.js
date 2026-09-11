/**
 * @ai00-x/dsh-ai-bridge — Ai00-X AI 桥接插件
 *
 * 把 dsh 的 LLM 调用转发给 Ai00-X 桌面客户端的本地 AI 网关：
 *   POST http://127.0.0.1:2100/ai00-internal/llm/v1/chat/completions
 *
 * 网关侧分流（SmartRouter + 本地 RWKV + ai00-x.com）：
 *   - ai00-auto  → 智能路由（RWKV classify R0-R3 → 本地/远程）；
 *                  编排 worker 内部 id，不再进弹层（去 auto，分流语义保留）
 *   - rwkv-local → 强制本地 RWKV
 *   - ai00-salvo → 强制 ai00-x.com primary 模型
 *
 * 本插件只做协议翻译：GenerateOptions ↔ OpenAI chat completions，
 * StreamChunk ↔ OpenAI SSE chunks。业务智能全部在宿主（Rust）侧。
 */

const name = "ai00-x-ai-bridge";
const inject = ["llm"];

/** provider 路由名（dsh 模型选择器里显示为 ai00-x/<model>）。 */
const PROVIDER = "ai00-x";

/** 默认网关地址（Ai00-X 桌面客户端内嵌 Salvo，仅本机监听）。 */
const DEFAULT_BASE_URL = "http://127.0.0.1:2100";
/** 内部 token 环境变量名（与客户端 AI00_S_INTERNAL_TOKEN 约定一致）。 */
const TOKEN_ENV = "AI00_S_INTERNAL_TOKEN";

/** 弹层通告目录（dsh 选模型弹层可见；contextWindow 供引擎压缩预算计算）。
 * ai00-auto 已从弹层移除（去 auto）：主会话钉远端，auto 只作编排 worker 的
 * 内部路由 id——仍可解析（见 INTERNAL_MODELS），网关分流语义保留。 */
const MODELS = [
  { id: "rwkv-local", name: "Ai00-X Local RWKV", contextWindow: 16384 },
  { id: "ai00-salvo", name: "Ai00-X Salvo (ai00-x.com)", contextWindow: 128000 },
];

/** 内部保留 id：不在弹层通告，但 resolveModel 需要容量映射
 * （research_worker 经 agentOptions 钉 ai00-auto 走 SmartRouter）。 */
const INTERNAL_MODELS = [
  { id: "ai00-auto", name: "Ai00-X Auto (smart routing)", contextWindow: 128000 },
];

// ---------------------------------------------------------------------------
// GenerateOptions → OpenAI chat completions body
// ---------------------------------------------------------------------------

/** harness Message[]（含 system 独立槽）→ OpenAI messages。 */
function toOpenAiMessages(options) {
  const messages = [];
  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }
  for (const message of options.messages) {
    const texts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const block of message.content ?? []) {
      if (block.type === "text") {
        texts.push(block.text);
      } else if (block.type === "reasoning") {
        // RWKV/网关不回放 reasoning，跳过
      } else if (block.type === "tool-call") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: block.arguments },
        });
      } else if (block.type === "tool-result") {
        const content = (block.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        toolResults.push({
          role: "tool",
          tool_call_id: block.toolCallId,
          content: content || "(no output)",
          isError: block.isError,
        });
      }
    }
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: texts.join("") || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // user：text + 展开的 tool results（网关侧按顺序处理）
      if (texts.length > 0 || toolResults.length === 0) {
        messages.push({ role: "user", content: texts.join("") });
      }
      messages.push(...toolResults);
    }
  }
  return messages;
}

/** harness ToolSchema[] → OpenAI function tools。 */
function toOpenAiTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

// ---------------------------------------------------------------------------
// OpenAI SSE → StreamChunk
// ---------------------------------------------------------------------------

/** 逐块解析 SSE 文本流（async generator，产出 data JSON 对象）。 */
async function* parseSse(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data === "[DONE]") return;
            try {
              yield JSON.parse(data);
            } catch {
              // 忽略残缺行
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 翻译网关 SSE 流为 harness StreamChunk 序列。
 * 时序遵循 dsh-llm BlockAssembler 协议：
 *   block-start → *-delta… → block-end（终块后统一发）→ usage → finish
 */
async function* translateStream(sseObjects, model) {
  const order = [];
  let textBlock = null;
  let reasoningBlock = null;
  // 并行 tool_calls：按 OpenAI 流式 index 分块（一条助手消息可含多个并行
  // 调用——编排「同一条回复并发派发子代理」依赖此；单块合并会把 name 拼成
  // "research_workercode_worker"、arguments 拼成非法 JSON，2026-09-11 实录）。
  // key = call.index；index 缺失的端点按首个 id / 顺序兜底单块。
  const toolBlocks = new Map();
  let flatSeq = 0;
  let pendingUsage = null;
  let pendingFinish = null;
  let eventCount = 0;

  for await (const event of sseObjects) {
    if (process.env.AI00X_BRIDGE_DEBUG) {
      eventCount += 1;
      if (
        eventCount <= 5 ||
        event.error ||
        event.usage ||
        event.finish_reason ||
        typeof event.content === "string" ||
        event.choices
      ) {
        process.stderr.write(
          `[ai00x-bridge] event#${eventCount}: ${JSON.stringify(event).slice(0, 300)}\n`
        );
      }
    }
    if (event.error) {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: { message: event.error.message ?? "gateway error", code: "AI00X_GATEWAY" },
        },
      };
      return;
    }
    const choice = event.choices?.[0];
    const delta = choice?.delta;
    // ai00-salvo 自有格式兼容：顶层 text / reasoning / tool_call 字段（无 choices 包装）
    const flatContent =
      typeof event.text === "string"
        ? event.text
        : typeof event.content === "string"
          ? event.content
          : undefined;
    const flatReasoning = typeof event.reasoning === "string" ? event.reasoning : undefined;
    const flatToolCall = event.tool_call ?? null;
    if (flatReasoning) {
      if (!reasoningBlock) {
        reasoningBlock = { index: order.length, text: "" };
        order.push("reasoning");
        yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
      }
      reasoningBlock.text += flatReasoning;
      yield {
        type: "reasoning-delta",
        index: reasoningBlock.index,
        text: flatReasoning,
      };
    }
    if (delta?.content || flatContent) {
      const content = delta?.content ?? flatContent;
      if (!textBlock) {
        textBlock = { index: order.length, text: "" };
        order.push("text");
        yield { type: "block-start", index: textBlock.index, blockType: "text" };
      }
      textBlock.text += content;
      yield { type: "text-delta", index: textBlock.index, text: content };
    }
    for (const call of delta?.tool_calls ?? []) {
      // OpenAI 流式：并行调用按 call.index 分流；缺失时按 id，再兜底 0
      const key =
        typeof call.index === "number"
          ? call.index
          : typeof call.id === "string"
            ? `id:${call.id}`
            : 0;
      let tb = toolBlocks.get(key);
      if (!tb) {
        tb = {
          index: order.length,
          id: call.id ?? `call_ai00x_${toolBlocks.size}`,
          name: "",
          arguments: "",
        };
        toolBlocks.set(key, tb);
        order.push(tb.index);
        yield { type: "block-start", index: tb.index, blockType: "tool-call" };
      }
      if (call.id !== undefined) tb.id = call.id;
      if (call.function?.name) {
        tb.name += call.function.name;
        yield {
          type: "tool-call-delta",
          index: tb.index,
          id: tb.id,
          name: tb.name,
          argumentsDelta: "",
        };
      }
      if (call.function?.arguments) {
        const fragment = call.function.arguments;
        tb.arguments += fragment;
        yield {
          type: "tool-call-delta",
          index: tb.index,
          id: tb.id,
          argumentsDelta: fragment,
        };
      }
    }
    // ai00-salvo 自有格式：tool_call（单数，一次性完整对象）——每个对象独立成块
    if (flatToolCall) {
      const tb = {
        index: order.length,
        id: flatToolCall.id ?? `call_ai00x_flat_${flatSeq++}`,
        name: flatToolCall.name ?? "",
        arguments: flatToolCall.arguments ?? "{}",
      };
      toolBlocks.set(`flat:${tb.index}`, tb);
      order.push(tb.index);
      yield { type: "block-start", index: tb.index, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: tb.index,
        id: tb.id,
        name: tb.name,
        argumentsDelta: tb.arguments,
      };
    }
    if (event.usage) {
      pendingUsage = {
        inputTokens: event.usage.prompt_tokens ?? 0,
        outputTokens: event.usage.completion_tokens ?? 0,
      };
    }
    const finishReason = choice?.finish_reason ?? event.finish_reason;
    if (finishReason) {
      pendingFinish =
        finishReason === "tool_calls"
          ? { kind: "tool-calls" }
          : finishReason === "length" || finishReason === "max_tokens"
            ? { kind: "max-tokens" }
            : { kind: "stop" };
    }
  }

  // 终块
  if (reasoningBlock) {
    yield {
      type: "block-end",
      index: reasoningBlock.index,
      block: { type: "reasoning", text: reasoningBlock.text },
    };
  }
  if (textBlock) {
    yield {
      type: "block-end",
      index: textBlock.index,
      block: { type: "text", text: textBlock.text },
    };
  }
  // 并行调用逐块收尾（Map 保序 = 首次出现顺序）
  for (const tb of toolBlocks.values()) {
    yield {
      type: "block-end",
      index: tb.index,
      block: {
        type: "tool-call",
        id: tb.id,
        name: tb.name,
        arguments: tb.arguments || "{}",
      },
    };
  }
  if (pendingUsage) {
    yield { type: "usage", usage: pendingUsage };
  }
  const reason = pendingFinish ?? { kind: "stop" };
  if (reason.kind === "stop" && order.length === 0) {
    yield {
      type: "finish",
      reason: {
        kind: "error",
        failure: { message: "gateway returned no content", code: "AI00X_EMPTY" },
      },
    };
    return;
  }
  yield { type: "finish", reason };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

class Ai00XAdapter {
  constructor(options) {
    this.options = options;
  }

  providerInfo(provider) {
    return { id: provider, name: "Ai00-X" };
  }

  providerRetryPolicy() {
    // 默认重试策略（undefined = 使用 dsh 默认值）
    return undefined;
  }

  async listModels() {
    const base = MODELS.map((model) => ({
      provider: PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: ["text"],
      contextWindow: model.contextWindow,
    }));
    // 合并网关下发的具体模型目录（ai00s:/gguf-local:/自定义 id——讨论
    // 通道同源），dsh 模型选择器可见可选；拉不到时静态目录兜底。
    // 内部保留 id（ai00-auto 等）一律过滤——不进弹层
    try {
      const res = await fetch(`${this.options.baseURL}/ai00-internal/llm/v1/models`);
      if (res.ok) {
        const data = await res.json();
        const knownIds = new Set([...MODELS, ...INTERNAL_MODELS].map((m) => m.id));
        const extra = (data.data ?? [])
          .filter((m) => m.id && !knownIds.has(m.id))
          .map((m) => ({
            provider: PROVIDER,
            id: m.id,
            name: m.name || m.id,
            inputModalities: ["text"],
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          }));
        return [...base, ...extra];
      }
    } catch {
      // 网关目录不可达 → 静态兜底
    }
    return base;
  }

  async resolveModel(provider, model) {
    // 未知引用（ai00s:<子模型>/gguf-local:<路径>/自定义 id）原样透传——
    // 网关按 client_factory 同源解析；此前未知 id 静默回落 ai00-auto，
    // 导致执行会话总是走智能路由（与讨论选型不一致）
    const known = [...MODELS, ...INTERNAL_MODELS].find((m) => m.id === model);
    const id = known ? known.id : model;
    const name = known ? known.name : String(model ?? "");
    // contextWindow = 引擎压缩预算的容量来源（缺失则压缩对该路由不生效）
    const contextWindow =
      known?.contextWindow ??
      (typeof id === "string" && id.startsWith("gguf-local:") ? 16384 : 32768);
    return {
      provider,
      id,
      name,
      inputModalities: ["text"],
      context: { contextWindow },
    };
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model);
    return {
      model: resolved,
      stream: (options) => this.stream(options),
    };
  }

  async *stream(options) {
    const { baseURL, token } = this.options;
    const body = {
      model: options.model,
      messages: toOpenAiMessages(options),
      stream: true,
      ...(toOpenAiTools(options.tools)
        ? { tools: toOpenAiTools(options.tools) }
        : {}),
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.stop && options.stop.length > 0 ? { stop: options.stop } : {}),
    };

    let response;
    try {
      response = await fetch(`${baseURL}/ai00-internal/llm/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ai00-internal-token": token,
          ...(options.sessionId
            ? { "x-ai00-session-id": String(options.sessionId) }
            : {}),
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            message: `Ai00-X gateway unreachable (${baseURL}): ${error.message}. Is the Ai00-X desktop client running?`,
            code: "AI00X_UNREACHABLE",
          },
        },
      };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            message: `Ai00-X gateway HTTP ${response.status}: ${text.slice(0, 500)}`,
            code: "AI00X_HTTP",
            status: response.status,
          },
        },
      };
      return;
    }

    yield* translateStream(parseSse(response.body, options.signal), options.model);
  }
}

// ---------------------------------------------------------------------------
// Cordis 插件入口
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const baseURL = config?.baseURL ?? DEFAULT_BASE_URL;
  const token = process.env[TOKEN_ENV] ?? "";
  if (!token) {
    ctx.logger.warn(
      `${name}: ${TOKEN_ENV} not set; gateway auth will fail unless the host uses its default token`
    );
  }

  const adapter = new Ai00XAdapter({ baseURL, token });
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.logger.info(`${name}: registered provider "${PROVIDER}" -> ${baseURL}`);
}

export { name, inject, apply };
