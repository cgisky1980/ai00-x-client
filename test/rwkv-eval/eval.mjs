// RWKV 本地任务成功率基线（可重复执行；结果打印到 stdout）
//
// 用法:
//   node test/rwkv-eval/eval.mjs                    # 全场景，默认轮数
//   node test/rwkv-eval/eval.mjs --trials=8         # 覆盖每场景轮数
//   node test/rwkv-eval/eval.mjs --only=s2,s4       # 只跑部分场景
//
// 依赖宿主网关（127.0.0.1:2100，模型 rwkv-local）。判据全部确定性：
// 不靠人读，不靠模型自评。
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:2100/ai00-internal/llm/v1/chat/completions";
const TOKEN =
  "7f3a9b2e8c1d4a6f5b0e9c2d7a4f1b8e6c3a9d2f7b4e1c8a5d0f3b6e9c2a7d4f1";
const PLUGIN = "@ai00-x/dsh-tools";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : dflt;
};
const TRIALS = Number(opt("trials", "8"));
const ONLY = (opt("only", "") || "").split(",").filter(Boolean);

const baseProse =
  "本地推理引擎负责把长文本分块喂入状态空间模型，逐块推进前缀计算，并在会话命中时复用已有状态。";

function material(chars, tag) {
  let s = `材料${tag}：`;
  while (s.length < chars) s += baseProse;
  return s.slice(0, chars);
}

function headers(sid) {
  return {
    "content-type": "application/json",
    "x-ai00-internal-token": TOKEN,
    "x-ai00-plugin-id": PLUGIN,
    "x-ai00-session-id": sid,
  };
}

/** 解析 SSE：返回 content 文本、tool_calls、usage、error、finish_reason。 */
function parseSse(raw) {
  let content = "";
  const toolCalls = [];
  let usage = null;
  let error = null;
  let finish = null;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let j;
    try {
      j = JSON.parse(payload);
    } catch {
      continue;
    }
    if (j.error) error = j.error;
    if (j.usage) usage = j.usage;
    const ch = j.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const piece = ch.delta?.content;
    if (piece) content += piece;
    const tc = ch.delta?.tool_calls;
    if (Array.isArray(tc)) toolCalls.push(...tc);
  }
  return { content, toolCalls, usage, error, finish };
}

async function chat({
  messages,
  maxTokens = 64,
  tools,
  stop,
  stream = false,
  sid,
  topK,
  model = "rwkv-local",
}) {
  const body = { model, messages, max_tokens: maxTokens, stream, temperature: 0 };
  if (tools) body.tools = tools;
  if (stop) body.stop = stop;
  // 请求体 top_k 覆盖本地采样档（同进程配对 A/B 用，见 ai_gateway local_top_k）。
  if (Number.isFinite(topK)) body.top_k = topK;
  const t0 = performance.now();
  const res = await fetch(BASE, {
    method: "POST",
    headers: headers(sid ?? `ev-${randomUUID()}`),
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const parsed = parseSse(raw);
  return { status: res.status, ms: Math.round(performance.now() - t0), raw, ...parsed };
}

function noLeak(text) {
  return !/User:|Assistant:|Instruction:/.test(text);
}

function hasReplacement(text) {
  return text.includes("\uFFFD");
}

/** 特殊标记泄漏：`<|…|>` 与训练数据里的 HTML 风格对话标记。 */
function hasSpecialLeak(text) {
  return /<\/?(assistant|user)>|<\|/.test(text);
}

/** 编辑距离（诊断用：量化「近似命中」，不参与通过判据）。 */
function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** 输出里与暗号最接近窗口的编辑距离（0 = 精确出现）。 */
function minWindowEdit(code, text) {
  const t = text.trim();
  let best = code.length;
  for (let len = Math.max(1, code.length - 3); len <= code.length + 3; len++) {
    for (let i = 0; i + len <= t.length; i++) {
      best = Math.min(best, levenshtein(code, t.slice(i, i + len)));
      if (best === 0) return 0;
    }
  }
  return best;
}

/** usage 里的前缀缓存命中数（本地路径读 prompt_tokens_details.cached_tokens）。 */
function cachedOf(usage) {
  return (
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.cached_prompt ??
    0
  );
}

const writeTools = [
  {
    type: "function",
    function: {
      name: "write",
      description: "创建或覆盖写入一个文件",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "相对路径" },
          content: { type: "string", description: "文件内容" },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "读取文件",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
    },
  },
];

// 本地白名单里的只读工具（生产路径：research worker 的本地工具轮）
const readTools = [
  {
    type: "function",
    function: {
      name: "read",
      description: "读取文件",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "按 glob 匹配文件",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "在文件里搜索文本",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, include: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const scenarios = {
  /** 纯生成：非空、无角色标记泄漏、无替换符、无重复退化。 */
  async s1_compose(trial) {
    const tag = `s1-${trial}-${randomUUID().slice(0, 6)}`;
    const r = await chat({
      messages: [
        { role: "system", content: `你是章节扩写助手 ${tag}。只输出正文。` },
        { role: "user", content: `${material(1000, tag)}\n请用两三句话总结这段材料。` },
      ],
      maxTokens: 64,
    });
    const fail = (reason) => ({ ok: false, reason, snippet: r.content.slice(0, 80), ms: r.ms });
    if (r.status !== 200) return fail(`http ${r.status}`);
    if (r.error) return fail(`gateway error: ${String(r.error.message).slice(0, 80)}`);
    if (!r.content.trim()) return fail("empty content");
    if (!noLeak(r.content)) return fail("role marker leak");
    if (hasSpecialLeak(r.content)) return fail("special token leak");
    if (hasReplacement(r.content)) return fail("U+FFFD in content");
    if (r.content.trim().length < 8) return fail("too short");
    return { ok: true, ms: r.ms };
  },

  /** 本地白名单工具（read/glob/grep，生产路径）：名称、JSON、必填键、值都合法。 */
  async s2_local_tools(trial) {
    const cases = [
      {
        ask: "请读取 section-2.md 的内容。",
        tool: "read",
        key: "file_path",
        check: (a) => String(a.file_path ?? "").endsWith("section-2.md"),
      },
      {
        ask: "请列出 docs 目录下所有 .md 文件。",
        tool: "glob",
        key: "pattern",
        check: (a) => String(a.pattern ?? "").includes("*.md"),
      },
      {
        ask: "请在报告里搜索关键词 暗号ZQ。",
        tool: "grep",
        key: "pattern",
        check: (a) => String(a.pattern ?? "").includes("ZQ"),
      },
    ];
    const c = cases[trial % cases.length];
    // 非ce 只进 user 行（system 保持干净：随机 hex 会干扰 3B 的工具选择）。
    const tag = `s2-${trial}-${randomUUID().slice(0, 6)}`;
    const r = await chat({
      messages: [
        { role: "system", content: "你是资料检索助手。只需要一步：调用合适的工具。" },
        { role: "user", content: `（任务标签 ${tag}）${c.ask}` },
      ],
      tools: readTools,
      maxTokens: 128,
    });
    const fail = (reason) => ({
      ok: false,
      reason: `${c.tool}: ${reason}`,
      snippet: (r.error?.message ?? r.content ?? r.raw).slice(0, 100),
      ms: r.ms,
    });
    if (r.status !== 200) return fail(`http ${r.status}`);
    if (r.error) return fail(`gateway error`);
    if (!r.toolCalls.length) return fail("no tool_calls");
    const call = r.toolCalls[0];
    if (call.function?.name !== c.tool) return fail(`name=${call.function?.name}`);
    let a;
    try {
      a = JSON.parse(call.function?.arguments ?? "");
    } catch {
      return fail("arguments not JSON");
    }
    if (!(c.key in a)) return fail(`missing ${c.key}`);
    if (!c.check(a)) return fail(`bad ${c.key}=${JSON.stringify(a[c.key]).slice(0, 40)}`);
    return { ok: true, ms: r.ms };
  },

  /** write 工具（本地白名单外，生产不走 3B 写文件；留作诊断基线）。 */
  async s7_write_tool(trial) {
    const tag = `s7-${trial}-${randomUUID().slice(0, 6)}`;
    const r = await chat({
      messages: [
        { role: "system", content: `你是文档助手 ${tag}。需要写文件时必须调用 write 工具。` },
        {
          role: "user",
          content:
            `参考骨架 guide.skeleton.md 的写法，但本次输出文件是 section-2.md：` +
            `请用 write 创建 section-2.md，内容以二级标题 ## 总览 开头，后面写两句话。` +
            `材料：${material(400, tag)}`,
        },
      ],
      tools: writeTools,
      maxTokens: 256,
    });
    const fail = (reason) => ({
      ok: false,
      reason,
      snippet: (r.error?.message ?? r.content).slice(0, 100),
      ms: r.ms,
    });
    if (r.status !== 200) return fail(`http ${r.status}`);
    if (r.error) return fail(`gateway error: ${String(r.error.message).slice(0, 80)}`);
    if (r.toolCalls.length === 0) return fail("no tool_calls");
    const call = r.toolCalls[0];
    const name = call.function?.name;
    if (name !== "write") return fail(`tool=${name}`);
    let a;
    try {
      a = JSON.parse(call.function?.arguments ?? "");
    } catch {
      return fail("arguments not JSON");
    }
    if (a.file_path !== "section-2.md") return fail(`path=${a.file_path}`);
    if (!String(a.content ?? "").includes("##")) return fail("content missing heading");
    return { ok: true, ms: r.ms };
  },

  /** 多轮续写：同一会话 3 回合，全部成功且 prompt 单调增长（追加生效）。 */
  async s3_multiturn(trial) {
    const tag = `s3-${trial}-${randomUUID().slice(0, 6)}`;
    const sid = `ev-${tag}`;
    const messages = [
      { role: "system", content: `你是续写助手 ${tag}。` },
      { role: "user", content: `${material(800, tag)}\n请写一句概述。` },
    ];
    const inputs = [];
    let last = "";
    for (let turn = 0; turn < 3; turn++) {
      const r = await chat({ messages, maxTokens: 48, sid });
      const fail = (reason) => ({
        ok: false,
        reason: `turn${turn + 1}: ${reason}`,
        snippet: r.content.slice(0, 80),
        ms: r.ms,
      });
      if (r.status !== 200) return fail(`http ${r.status}`);
      if (r.error) return fail(`gateway error`);
      if (!r.content.trim()) return fail("empty content");
      if (!noLeak(r.content)) return fail("role marker leak");
      inputs.push(r.usage?.prompt_tokens ?? 0);
      last = r.content.trim();
      messages.push({ role: "assistant", content: last });
      messages.push({ role: "user", content: `继续，把上一句改得更具体一点（第${turn + 2}版）。` });
    }
    for (let i = 1; i < inputs.length; i++) {
      if (!(inputs[i] > inputs[i - 1])) {
        return { ok: false, reason: `prompt tokens not growing: ${inputs.join("/")}`, ms: 0 };
      }
    }
    return { ok: true, ms: 0, note: `prompt=${inputs.join("/")}` };
  },

  /** 长材料检索：4000 字材料里埋暗号，回答必须包含它。 */
  async s4_recall(trial) {
    const tag = `s4-${trial}-${randomUUID().slice(0, 6)}`;
    const code = `ZX${String(10 + trial * 7).padStart(2, "0")}Q${randomUUID().slice(0, 3).toUpperCase()}`;
    const mat = material(3800, tag);
    const at = Math.floor(mat.length * 0.62);
    const planted = `${mat.slice(0, at)}（登记暗号：${code}）${mat.slice(at)}`;
    const r = await chat({
      messages: [
        { role: "system", content: `你是资料问答助手 ${tag}。只回答被问的信息。` },
        { role: "user", content: `${planted}\n\n问题：材料里登记的暗号是什么？只输出暗号本身。` },
      ],
      maxTokens: 32,
    });
    const fail = (reason) => ({
      ok: false,
      reason,
      needs: minWindowEdit(code, r.content),
      snippet: r.content.slice(0, 80),
      ms: r.ms,
    });
    if (r.status !== 200) return fail(`http ${r.status}`);
    if (r.error) return fail("gateway error");
    if (hasSpecialLeak(r.content)) return fail("special token leak");
    if (!r.content.includes(code)) return fail("code not recalled");
    return { ok: true, needs: 0, ms: r.ms };
  },

  /** stop 边界：自定义 stop 不得泄漏到正文。 */
  async s5_stop(trial) {
    const tag = `s5-${trial}-${randomUUID().slice(0, 6)}`;
    const marker = "<<END>>";
    const r = await chat({
      messages: [
        { role: "system", content: `你是输出助手 ${tag}。` },
        { role: "user", content: `请先输出 AB 两个字母，然后输出 ${marker}，再输出 CD。` },
      ],
      maxTokens: 32,
      stop: [marker],
    });
    const fail = (reason) => ({ ok: false, reason, snippet: r.content.slice(0, 80), ms: r.ms });
    if (r.status !== 200) return fail(`http ${r.status}`);
    if (r.error) return fail("gateway error");
    if (r.content.includes(marker)) return fail("stop marker leaked");
    if (hasReplacement(r.content)) return fail("U+FFFD in content");
    return { ok: true, ms: r.ms };
  },

  /** 坏输入鲁棒性：不得 500，不得崩溃。 */
  async s6_bad_input(trial) {
    const checks = [];
    const rawBody = async (payload, ct = "application/json") => {
      const res = await fetch(BASE, {
        method: "POST",
        headers: { ...headers(`ev-s6-${trial}-${randomUUID().slice(0, 4)}`), "content-type": ct },
        body: payload,
      });
      await res.text();
      return res.status;
    };
    const badJson = await rawBody("{oops");
    checks.push({ name: "bad-json-400", ok: badJson === 400, got: badJson });
    const toolsBad = await chat({
      messages: [{ role: "user", content: "你好" }],
      maxTokens: 8,
      tools: "not-an-array",
    });
    checks.push({ name: "tools-nonarray", ok: toolsBad.status !== 500, got: toolsBad.status });
    const empty = await chat({ messages: [], maxTokens: 8 });
    checks.push({ name: "empty-messages", ok: empty.status !== 500, got: empty.status });
    const failed = checks.filter((c) => !c.ok);
    return failed.length
      ? { ok: false, reason: failed.map((c) => `${c.name}=${c.got}`).join(", ") }
      : { ok: true };
  },

  /**
   * 长文摘要保真（生产路径）：12k 材料埋暗号（位置随试次 15%/50%/85%），
   * `/text/summarize` + focus 必须把暗号留在摘要里（宿主机摘录兜底，不靠注意力）。
   */
  async s10_summary_recall(trial) {
    const tag = `s10-${trial}-${randomUUID().slice(0, 6)}`;
    const code = `SM${randomUUID().slice(0, 5).toUpperCase()}`;
    const depth = [0.15, 0.5, 0.85][trial % 3];
    const mat = material(12000, tag);
    const at = Math.floor(mat.length * depth);
    const planted = `${mat.slice(0, at)}（登记暗号：${code}）${mat.slice(at)}`;
    const root = BASE.replace("/llm/v1/chat/completions", "");
    const t0 = performance.now();
    const res = await fetch(`${root}/text/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai00-internal-token": TOKEN },
      body: JSON.stringify({ text: planted, focus: "暗号", max_length: 300 }),
    });
    const raw = await res.text();
    let summary = "";
    try {
      summary = JSON.parse(raw).summary ?? "";
    } catch {}
    const ms = Math.round(performance.now() - t0);
    const fail = (reason) => ({
      ok: false,
      reason: `${reason} (depth=${depth})`,
      snippet: summary.slice(0, 80),
      ms,
    });
    if (res.status !== 200) return fail(`http ${res.status}`);
    if (!summary.trim()) return fail("empty summary");
    if (!summary.includes(code)) return fail("code dropped");
    if (hasSpecialLeak(summary)) return fail("special token leak");
    if (summary.includes("\uFFFD")) return fail("U+FFFD in summary");
    return { ok: true, ms, note: `depth=${depth}` };
  },

  /**
   * 路径形态长文总结（`{path, cwd, focus}`）：本地 worker 只需传路径，宿主读文件。
   * 判据：摘要保住暗号；越权路径（../ 逃出 cwd）必须 400 拒绝。
   */
  async s11_summary_path(trial) {
    const tag = `s11-${trial}-${randomUUID().slice(0, 6)}`;
    const code = `SP${randomUUID().slice(0, 5).toUpperCase()}`;
    const dir = join(tmpdir(), `ai00x-eval-${tag}`);
    const root = BASE.replace("/llm/v1/chat/completions", "");
    const post = async (payload) => {
      const res = await fetch(`${root}/text/summarize`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ai00-internal-token": TOKEN },
        body: JSON.stringify(payload),
      });
      const raw = await res.text();
      return { status: res.status, raw };
    };
    try {
      await mkdir(join(dir, "docs"), { recursive: true });
      const mat = material(12000, tag);
      const at = Math.floor(mat.length * 0.5);
      const planted = `${mat.slice(0, at)}（登记暗号：${code}）${mat.slice(at)}`;
      await writeFile(join(dir, "docs", "long.md"), planted, "utf8");
      const t0 = performance.now();
      const r = await post({
        path: "docs/long.md",
        cwd: dir,
        focus: "暗号",
        max_length: 300,
      });
      const ms = Math.round(performance.now() - t0);
      let summary = "";
      try {
        summary = JSON.parse(r.raw).summary ?? "";
      } catch {}
      const fail = (reason) => ({ ok: false, reason, snippet: summary.slice(0, 80), ms });
      if (r.status !== 200) return fail(`path form: http ${r.status}`);
      if (!summary.includes(code)) return fail("path form: code dropped");
      if (hasSpecialLeak(summary)) return fail("path form: special token leak");
      // 越权：../ 逃出 cwd 必须拒绝（防止把任意文件喂给模型）
      await writeFile(join(tmpdir(), `${tag}-outside.txt`), "outside secret", "utf8");
      const escape = await post({ path: `../${tag}-outside.txt`, cwd: dir, focus: "暗号" });
      await rm(join(tmpdir(), `${tag}-outside.txt`), { force: true });
      if (escape.status !== 400) return fail(`escape not rejected: http ${escape.status}`);
      return { ok: true, ms, note: "path form + escape guard" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  /**
   * 本地 worker 的工具参数形态：只给 ai00_text_summarize（含 path/cwd），
   * 要求它用 path + cwd 指文件，而不是把长正文塞进 text。
   */
  async s12_summary_tool_args(trial) {
    const tag = `s12-${trial}-${randomUUID().slice(0, 6)}`;
    const dir = join(tmpdir(), `ai00x-eval-${tag}`);
    const file = join(dir, "long.md");
    const r = await chat({
      // 生产路径：编排者的模型槽是 ai00-auto；工具集全为本地闭环 → hybrid 入口
      model: "ai00-auto",
      messages: [
        { role: "system", content: "你是资料助手。只需要一步：调用合适的工具。" },
        {
          role: "user",
          content: `（任务标签 ${tag}）请总结文件 ${file} 的关键内容，并找出其中的暗号。我的工作目录是 ${dir}。`,
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "ai00_text_summarize",
            description:
              "Summarize a long text entirely LOCALLY. For a file on disk pass {path} instead of inlining the text — the host reads it from your working directory. Optional focus steers the summary.",
            parameters: {
              type: "object",
              properties: {
                text: { type: "string" },
                path: { type: "string" },
                focus: { type: "string" },
                max_length: { type: "number" },
              },
            },
          },
        },
      ],
      maxTokens: 256,
    });
    const fail = (reason, needs) => ({
      ok: false,
      reason,
      needs,
      snippet: r.content.slice(0, 80),
      ms: r.ms,
    });
    if (r.status !== 200) return fail(`http ${r.status}`);
    const call = r.toolCalls.find((c) => c?.function?.name === "ai00_text_summarize");
    if (!r.toolCalls.length) return fail("no tool call", "tool_call");
    if (!call) return fail(`wrong tool: ${r.toolCalls[0]?.function?.name}`, "tool_name");
    let args = {};
    try {
      args = JSON.parse(call.function.arguments ?? "{}");
    } catch {
      return fail(`bad arguments json: ${String(call.function.arguments).slice(0, 60)}`, "json");
    }
    const inlined = String(args.text ?? "");
    if (!args.path) {
      return fail(
        inlined
          ? `inlined text (${inlined.length} chars) instead of path`
          : `missing path (args: ${String(call.function.arguments ?? "").slice(0, 160)})`,
        "path_arg"
      );
    }
    if (!String(args.path).replace(/\\/g, "/").endsWith("long.md")) {
      return fail(
        `path wrong: ${String(args.path).slice(0, 120)} | args: ${String(call.function.arguments ?? "").slice(0, 160)}`,
        "path_value"
      );
    }
    if (inlined.length > 500) return fail(`text too long (${inlined.length})`, "inline_text");
    // focus 是可选参数（模型常省略）：只作诊断，不参与判据。
    const hasFocus = Boolean(String(args.focus ?? "").trim());
    return { ok: true, ms: r.ms, note: `focus=${hasFocus ? "hit" : "miss"}` };
  },

  /**
   * 问答型工具直出：messages 已带 summarize 成功结果时，终答必须是摘要原文
   * （宿主机确定性短路，不再让 3B 转述），且不花解码时间。
   */
  async s13_answer_tool_direct(trial) {
    const tag = `s13-${trial}-${randomUUID().slice(0, 6)}`;
    const code = `SD${randomUUID().slice(0, 5).toUpperCase()}`;
    const summary = `本地摘要（${tag}）：材料讲的是分块并发推理；登记暗号 ${code}；结论是切块上限 32、每块 1K。`;
    const r = await chat({
      // 生产路径：编排者用 ai00-auto（hybrid 入口按工具集判定，不走 SmartRouter）
      model: "ai00-auto",
      messages: [
        { role: "user", content: "请总结这份材料并告诉我暗号。" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "ai00_text_summarize", arguments: '{"path":"docs/long.md"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: summary },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "ai00_text_summarize",
            description: "Summarize a long text LOCALLY.",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      maxTokens: 64,
    });
    const fail = (reason) => ({ ok: false, reason, snippet: r.content.slice(0, 80), ms: r.ms });
    if (r.status !== 200) return fail(`http ${r.status}`);
    if (r.content.trim() !== summary.trim()) return fail("summary not returned verbatim");
    if (hasSpecialLeak(r.content)) return fail("special token leak");
    if (r.ms > 3000) return fail(`slow path (${r.ms}ms): model was invoked`);
    return { ok: true, ms: r.ms };
  },

  /**
   * 会话前缀缓存（推理优化）正确性：同一 sid 三轮，第 2/3 轮必须命中缓存。
   * 只钉缓存路径本身（命中数 + 输出不退化）；暗号召回仅作诊断，不参与判据。
   */
  async s8_session_cache(trial) {
    const tag = `s8-${trial}-${randomUUID().slice(0, 6)}`;
    const sid = `ev-${tag}`;
    const code = `SC${String(trial).padStart(2, "0")}${randomUUID().slice(0, 3).toUpperCase()}`;
    const mat = material(3800, tag);
    const at = Math.floor(mat.length * 0.5);
    const planted = `${mat.slice(0, at)}（登记暗号：${code}）${mat.slice(at)}`;
    // 起始就带一条 assistant（多轮 System 格式）：单轮 system+user 会走
    // Instruction 格式，与后续轮次的 prompt 头不同，缓存不可能命中。
    const messages = [
      { role: "system", content: `你是资料问答助手 ${tag}。只回答被问的信息。` },
      { role: "user", content: `${planted}\n\n请记住材料里登记的暗号。` },
      { role: "assistant", content: "好的，我记住了。" },
      { role: "user", content: "材料里登记的暗号是什么？只输出暗号本身。" },
    ];
    const nextAsks = ["用一句话说明你刚才回答了什么。"];
    const cached = [];
    const turnMs = [];
    for (let i = 0; i < 3; i++) {
      const r = await chat({ messages, maxTokens: 32, sid });
      const where = `turn${i + 1}`;
      if (r.status !== 200) return { ok: false, reason: `${where}: http ${r.status}`, ms: r.ms };
      if (r.error) return { ok: false, reason: `${where}: gateway error`, ms: r.ms };
      if (!r.content.trim()) return { ok: false, reason: `${where}: empty content`, ms: r.ms };
      if (!noLeak(r.content))
        return { ok: false, reason: `${where}: role marker leak`, snippet: r.content.slice(0, 80), ms: r.ms };
      if (hasSpecialLeak(r.content))
        return {
          ok: false,
          reason: `${where}: special token leak`,
          snippet: r.content.slice(0, 80),
          ms: r.ms,
        };
      cached.push(cachedOf(r.usage));
      turnMs.push(r.ms);
      messages.push({ role: "assistant", content: r.content.trim() });
      if (nextAsks[i]) messages.push({ role: "user", content: nextAsks[i] });
    }
    if (!(cached[1] > 0) || !(cached[2] > 0)) {
      return {
        ok: false,
        reason: `cache miss on follow-up: cached=${cached.join("/")}`,
        ms: turnMs.reduce((a, b) => a + b, 0),
      };
    }
    const recalled = messages.some(
      (m) => m.role === "assistant" && m.content.includes(code)
    );
    return {
      ok: true,
      ms: turnMs.reduce((a, b) => a + b, 0),
      note: `cached=${cached.join("/")} recall=${recalled ? "hit" : "miss"}`,
    };
  },

  /**
   * 并发隔离：4 路长材料同时推理，各自暗号不得串台（批量 prefill / 并发解码
   * 的状态隔离）。召回只作诊断——判据只钉「不串台 + 输出可用」。
   */
  async s9_parallel_isolated(trial) {
    const lanes = Array.from({ length: 4 }, (_, lane) => {
      const tag = `s9-${trial}-${lane}-${randomUUID().slice(0, 6)}`;
      const code = `P${lane}${String(trial).padStart(2, "0")}${randomUUID().slice(0, 3).toUpperCase()}`;
      const mat = material(3000, tag);
      const at = Math.floor(mat.length * 0.9);
      const planted = `${mat.slice(0, at)}（登记暗号：${code}）${mat.slice(at)}`;
      return {
        lane,
        code,
        messages: [
          { role: "system", content: `你是资料问答助手 ${tag}。只回答被问的信息。` },
          { role: "user", content: `${planted}\n\n问题：材料里登记的暗号是什么？只输出暗号本身。` },
        ],
      };
    });
    const results = await Promise.all(
      lanes.map((l) => chat({ messages: l.messages, maxTokens: 32 }))
    );
    for (let i = 0; i < lanes.length; i++) {
      const r = results[i];
      const where = `lane${lanes[i].lane}`;
      if (r.status !== 200) return { ok: false, reason: `${where}: http ${r.status}`, ms: r.ms };
      if (r.error) return { ok: false, reason: `${where}: gateway error`, ms: r.ms };
      if (!r.content.trim()) return { ok: false, reason: `${where}: empty content`, ms: r.ms };
      if (!noLeak(r.content))
        return { ok: false, reason: `${where}: role marker leak`, snippet: r.content.slice(0, 80), ms: r.ms };
      if (hasSpecialLeak(r.content))
        return {
          ok: false,
          reason: `${where}: special token leak`,
          snippet: r.content.slice(0, 80),
          ms: r.ms,
        };
      for (const other of lanes) {
        if (other.lane === lanes[i].lane) continue;
        if (r.content.includes(other.code)) {
          return {
            ok: false,
            reason: `${where}: cross-talk with lane${other.lane}`,
            snippet: r.content.slice(0, 80),
            ms: r.ms,
          };
        }
      }
    }
    const hits = lanes.filter((l, i) => results[i].content.includes(l.code)).length;
    return {
      ok: true,
      ms: Math.max(...results.map((r) => r.ms)),
      note: `recall=${hits}/4`,
    };
  },
};

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const picked = Object.keys(scenarios).filter(
  (k) => ONLY.length === 0 || ONLY.some((p) => k.startsWith(p))
);
const report = {};
for (const name of picked) {
  const rows = [];
  for (let i = 0; i < TRIALS; i++) {
    try {
      rows.push(await scenarios[name](i));
    } catch (e) {
      rows.push({ ok: false, reason: `exception: ${String(e).slice(0, 80)}` });
    }
  }
  const pass = rows.filter((r) => r.ok).length;
  report[name] = {
    trials: rows.length,
    pass,
    rate: `${pass}/${rows.length}`,
    failures: rows
      .map((r, i) => ({ i, ...r }))
      .filter((r) => !r.ok)
      .map((r) => ({ trial: r.i, reason: r.reason, needs: r.needs, snippet: r.snippet })),
    ms: rows.filter((r) => r.ms).map((r) => r.ms),
    notes: rows.map((r) => r.note).filter(Boolean),
  };
}
console.log(JSON.stringify(report, null, 2));
