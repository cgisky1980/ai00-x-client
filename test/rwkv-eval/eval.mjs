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

async function chat({ messages, maxTokens = 64, tools, stop, stream = false, sid }) {
  const body = { model: "rwkv-local", messages, max_tokens: maxTokens, stream, temperature: 0 };
  if (tools) body.tools = tools;
  if (stop) body.stop = stop;
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
    const tag = `s2-${trial}-${randomUUID().slice(0, 6)}`;
    const r = await chat({
      messages: [
        { role: "system", content: `你是资料检索助手 ${tag}。只需要一步：调用合适的工具。` },
        { role: "user", content: c.ask },
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
    const fail = (reason) => ({ ok: false, reason, snippet: r.content.slice(0, 80), ms: r.ms });
    if (r.status !== 200) return fail(`http ${r.status}`);
    if (r.error) return fail("gateway error");
    if (!r.content.includes(code)) return fail("code not recalled");
    return { ok: true, ms: r.ms };
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
      .map((r) => ({ trial: r.i, reason: r.reason, snippet: r.snippet })),
    ms: rows.filter((r) => r.ms).map((r) => r.ms),
  };
}
console.log(JSON.stringify(report, null, 2));
