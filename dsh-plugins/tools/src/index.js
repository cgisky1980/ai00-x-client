/**
 * @ai00-x/dsh-tools — Ai00-X 业务工具插件
 *
 * 把宿主（Ai00-X 桌面客户端）的业务能力注册为 dsh 工具，经内部 API 回呼：
 *   http://127.0.0.1:2100/ai00-internal/*
 *
 * 工具清单：
 * - ai00_notify        — 系统桌面通知
 * - ai00_set_wallpaper — 应用壁纸项目到桌面
 * - ai00_todo_read     — 读取知行（待办/目标/专注）全量数据
 * - ai00_todo_write    — 全量写知行数据（先 read 后改再写）
 * - ai00_task_complete — 提交模型自检（DoD 验收前置校验 + 快照）；完成/XP 由人类验收触发
 * - ai00_task_verify   — 子任务证据门（跑步骤验收命令 + 收集精简证据，判定是否需云审）
 * - ai00_task_create   — agent 自主建卡（想法池落卡，人机对等的想法收集）
 * - ai00_focus_log     — 记录专注会话（宿主广播事件，web-ui 发放 XP）
 * - ai00_plan_read     — 读卡片计划文档 MD（与策窗口共享同一文件）
 * - ai00_plan_write    — 写卡片计划文档 MD（策窗口热刷新可见）
 * - ai00_web_extract   — web 有效信息提取（全本地闭环：搜索→并发抓取→本地并发筛选）
 * - ai00_text_summarize— 长文总结（全本地闭环：≤6000 单次 / >6000 map-reduce 并发）
 * - ai00_local_compose — 本地模型只写正文、宿主确定性落盘（章节扩写，先写后落盘）
 * - ai00_assemble      — 按序拼接分节文件为最终交付物并清理分节（确定性归约）
 * - ai00_research_collect — 一次调用完成「多查询检索 → 抓取 → 筛选 → 落盘来源汇编」
 *
 * 本插件只做协议薄壳：业务逻辑在宿主侧（D7 决策）。
 * 不 import @deepseek-ai/dsh-tools（pnpm 严格解析下不可达），用原始
 * ToolDefinition 形状注册——参数校验自行完成，输出声明仍由注册表强制校验。
 *
 * 提示词归属（R1-5 收口边界，2026-09-12）：web-ui 侧提示词统一收口在
 * src/web-ui/src/tools/todo/ai/prompts.ts。本插件是独立 npm 包（独立构建，
 * 无法 import web-ui 模块），故本文件内的 ai00_task_complete 验收拒绝文案与
 * 「完工三步」口径留原地——调整验收口径时，须与 prompts.ts 的
 * DELEGATE_COMPLETION_THREE_STEP 同步修改，勿只改一处。
 */

import { exec, execFile } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, rename, stat, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const name = "ai00-x-tools";
const inject = ["tools", "workingDirectory"];

/** 插件标识（npm 包名；宿主内部 API 按此头做 per-plugin scope 授权）。 */
const PLUGIN_ID = "@ai00-x/dsh-tools";

/** 默认宿主地址（Ai00-X 桌面客户端内嵌 Salvo，仅本机监听）。 */
const DEFAULT_BASE_URL = "http://127.0.0.1:2100";
/** 内部 token 环境变量名（与客户端 AI00_S_INTERNAL_TOKEN 约定一致）。 */
const TOKEN_ENV = "AI00_S_INTERNAL_TOKEN";

// ---------------------------------------------------------------------------
// 内部 API 客户端
// ---------------------------------------------------------------------------

function makeClient(baseURL, token) {
  async function call(method, path, body, signal) {
    const response = await fetch(`${baseURL}/ai00-internal${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-ai00-internal-token": token,
        // per-plugin scope 授权：bundled 插件全量放行；缺失时写 scope 只放
        // BASIC（只读+通知）——显式声明来源是 scope 模型的前提
        "x-ai00-plugin-id": PLUGIN_ID,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    const text = await response.text().catch(() => "");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = { raw: text };
    }
    if (!response.ok) {
      const message =
        value?.error?.message ?? `HTTP ${response.status}: ${text.slice(0, 300)}`;
      throw new Error(`Ai00-X host API error: ${message}`);
    }
    return value;
  }
  return {
    get: (path, signal) => call("GET", path, undefined, signal),
    put: (path, body, signal) => call("PUT", path, body, signal),
    post: (path, body, signal) => call("POST", path, body, signal),
  };
}

/**
 * 计划「## 交付物」段里承诺的文件清单（只取像文件路径的条目）。
 *
 * `ai00_task_complete` 的 deliverables 参数是模型**自己登记**的清单，实测出现过
 * 计划承诺 `report.md` / `architecture-blueprint.md`、却从未生成也照常提交自检。
 * 这里把计划承诺的路径解析出来做对等校验。
 */
function parseDeliverables(markdown) {
  const lines = sectionLines(markdown, /^##\s*(交付物|Deliverables?)/i);
  if (!lines) return [];
  const out = [];
  for (const line of lines) {
    const item = /^\s*(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (!item) continue;
    // 只取条目开头的文件名：中文计划常写成「`report.md`：调研主报告（…）」，
    // 按空白切词会连说明一起拿到，文件名判不出来。
    const match = /^([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})/.exec(
      item[1].replace(/`/g, "").trim()
    );
    if (!match) continue;
    const name = match[1].replace(/^\.\//, "");
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * `## Deliverables` 里承诺、但 `## Steps` 段**从未提及**的文件名。
 *
 * 2026-11-21 实测：模型写单步计划（Scope: brief.md）时，把上一份调研任务的
 * `report.md` 一并抄进 Deliverables。这份「幽灵交付物」永远不存在，
 * `ai00_task_verify` 的整体验收会因此恒判 `failed`，任务走进死胡同。
 * 这里在写计划时就把不自洽的承诺拦下来（Steps 里提到即视为有意产出）。
 */
export function ghostDeliverables(markdown) {
  const deliverables = parseDeliverables(markdown);
  if (!deliverables.length) return [];
  const stepsText = (sectionLines(markdown, /^##\s*(步骤|Steps?)/i) ?? [])
    .join("\n")
    .replace(/`/g, "");
  if (!stepsText.trim()) return deliverables;
  return deliverables.filter((name) => {
    if (stepsText.includes(name)) return false;
    const base = name.split("/").pop();
    return base ? !stepsText.includes(base) : true;
  });
}

/** 可能被当作「人读交付物」检查编码污染的文本扩展名（二进制一律跳过）。 */
const TEXT_DELIVERABLE_EXT =
  /\.(md|markdown|txt|json|jsonl|csv|tsv|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|c|h|cpp|yaml|yml|toml|ini|tex|sql|sh|ps1|log)$/i;

/**
 * 交付物里出现 U+FFFD（替换符）的文件名 = 编码损坏。
 *
 * 2026-11-21 实测：编排者写 brief 时正文里带进了两个替换符，云端 worker 照抄，
 * `brief.md` 里出现「人工在任��面板点击批准」；验收命令只查标题存在，判 passed，
 * 最后靠编排者自己读文件才发现，又花两次派工修正。这类损坏不靠人眼很难发现，
 * 所以放进交付物门禁直接拦。
 */
export async function corruptDeliverables(cwd, names) {
  const out = [];
  for (const name of names) {
    if (!TEXT_DELIVERABLE_EXT.test(name)) continue;
    const target = isAbsolute(name) || !cwd ? name : resolve(cwd, name);
    const text = await readFile(target, "utf8").catch(() => null);
    if (text == null) continue; // 不存在/非 UTF-8：交给「缺失」那条判定
    if (text.includes("\uFFFD")) out.push(name);
  }
  return out;
}

/**
 * 「只量长度」的验收命令（`t.length < 4000`、`test -s f`、`statSync(f).size`…）。
 *
 * loop 契约要求验收断言**内容**（章节/表格/引用），但没有任何机制拦住
 * 「if (t.length < 4000) exit 1」这类弱判据：填充文本就能过，而真正的问题
 * （缺章节、文件名错、乱码）全被放过。这里在写计划时把这类条目挑出来。
 *
 * 判定：命令里出现长度/体积比较，且没有任何内容信号（includes/match/grep/前后缀…）。
 * `test -f`（存在性）不算——它常与内容断言并列，且对非文档产物是合理判据。
 *
 * `startsWith/endsWith` 也是内容信号：实测一份计划被误拦过——T1 的命令是
 * `!t.startsWith('打回测试') || t.length > 6`（开头必须对、且只允许 6 字），
 * 内容和长度同时断言，却被「有 .length 且无内容信号」判成只量长度，模型白改一轮。
 *
 * 与字符串字面量的相等/不等比较同样是内容信号：实测（任务 t-1795366486750-rh2）
 * `if(l.length!==1||t!=='hello from local rwkv')` 同时断言"单行 + 精确内容"，
 * 只因为带 `.length` 被拦。凡是 `=== / !== / == / !=` 后紧跟引号的比较，
 * 都说明命令在核对内容本身，不再算弱判据。
 */
const LENGTH_ONLY_CMD =
  /(\.length\b|byteLength|statSync\([^)]*\)\s*\.\s*size|\.size\b|\btest\s+-s\b|wc\s+-c)/;
const CONTENT_SIGNAL_CMD =
  /(includes\(|startsWith\(|endsWith\(|\.match\(|\.test\(|indexOf\(|\bgrep\b|\bfindstr\b|Select-String|\brg\b|contains\(|\bassert\b|[=!]==?\s*['"`])/i;

/**
 * 大段连续字符的 `{N}` 量词（`[A-Za-z]{20}`、`[\s\S]{200}`）——长度判据的变体。
 *
 * 2026-11-24 端到端实测：编排者写了
 * `/## Overview[\s\S]*## Benefits[\s\S]*[A-Za-z]{20}/` 当验收命令——要求文档里
 * 出现「连续 20 个字母」，正常英文散文永远不可能满足（单词间有空格），
 * 验证恒失败，模型又花 5 分钟排查、改判据、重新等批准。`{N≥10}` 一律在
 * 写计划时拦下；`\d{4}`（年份）这类 N<10 不受影响。
 */
function hasRunLength(cmd) {
  const re = /\[[^\]]*\]\s*\{\s*(\d+)\s*(?:,\s*\d*)?\s*\}/g;
  let m;
  while ((m = re.exec(String(cmd ?? "")))) {
    if (Number(m[1]) >= 10) return true;
  }
  return false;
}

/** 计划里所有「只量长度」的验收条目（含步骤级 `Acceptance:` 与 `## 验收`）。 */
export function weakAcceptance(markdown) {
  const out = [];
  let section = "";
  for (const line of String(markdown ?? "").split("\n")) {
    if (/^##\s/.test(line)) {
      section = line.replace(/^##\s*/, "").trim();
      continue;
    }
    const item = /^\s*-\s+\[[ xX]\]\s+(.*)$/.exec(line);
    const stepProp = /^\s*(?:-\s*)?(?:Acceptance|验收)\s*[:：]\s*(.*)$/i.exec(line);
    const text = item ? item[1] : stepProp ? stepProp[1] : "";
    if (!text) continue;
    const cmd = extractCmd(text);
    if (!cmd) continue;
    const lengthOnly = LENGTH_ONLY_CMD.test(cmd) && !CONTENT_SIGNAL_CMD.test(cmd);
    if (!lengthOnly && !hasRunLength(cmd)) continue;
    out.push({ where: item ? section || "## Acceptance" : "step", text: text.trim(), cmd });
  }
  return out;
}

/**
 * 计划里写了 `{cmd: …}` 但**实际不会被执行的**验收条目。
 *
 * `extractCmd` 有几道护栏（>500 字符、含反引号、含 `$(`），超了就不当命令，
 * 静默降级成「人工判据」——2026-11-21 实测：一份 600 字符的 node 校验命令
 * 就这样从没跑过，步骤永远停在 needs-review，而计划表面看起来「有命令」。
 * 写计划时就拦掉，让模型改用短命令或把逻辑挪进 Scope 里的脚本。
 */
export function unrunnableCmds(markdown) {
  const out = [];
  let section = "";
  for (const line of String(markdown ?? "").split("\n")) {
    if (/^##\s/.test(line)) {
      section = line.replace(/^##\s*/, "").trim();
      continue;
    }
    const item = /^\s*-\s+\[[ xX]\]\s+(.*)$/.exec(line);
    const stepProp = /^\s*(?:-\s*)?(?:Acceptance|验收)\s*[:：]\s*(.*)$/i.exec(line);
    const text = item ? item[1] : stepProp ? stepProp[1] : "";
    if (!text || !/\{cmd:/.test(text)) continue;
    if (extractCmd(text)) continue;
    const inner = /\{cmd:\s*(.+?)\}\s*$/.exec(text);
    out.push({
      where: item ? section || "## Acceptance" : "step",
      text: text.trim(),
      len: inner ? inner[1].trim().length : 0,
    });
  }
  return out;
}

/** 本地时间戳 `YYYY-MM-DD HH:mm`（计划文档给人读，不用 UTC）。 */
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 步骤块是否已有**可用**验证证据（`ai00_task_verify` 写回的 `- 验证: <verdict>`）。
 *
 * `passed` 都算「验过」；`needs-review` 只在**没有可执行命令**（纯人工判据）时放行——
 * manual 类验收永远只能拿到 needs-review，若一律只认 passed，这类步骤就永远勾不上
 * （死锁）。步骤里写了 `{cmd:}` 时要求证据行 `命令 N/M 通过` 且 N≥1：命令存在却
 * 0/0 说明它们从未真正运行（解析漏项 / 未执行），勾上就是假进度。
 * `failed` 与「根本没有验证行」一律拒绝。
 */
export function usableEvidence(block) {
  const match = /^\s*-\s*(验证|verification)\s*[:：]\s*([a-z-]+)/im.exec(block);
  if (!match) return { ok: false, verdict: "" };
  const verdict = match[2].toLowerCase();
  if (verdict === "passed") return { ok: true, verdict };
  if (verdict !== "needs-review") return { ok: false, verdict };
  // needs-review 可以勾（人工判据），但「步骤里写了 {cmd:} 却一条都没跑」是假进度：
  // 实测计划用「Acceptance: 换行子项」写法时旧解析漏掉命令，证据行是 `命令 0/0 通过`，
  // 步骤仍被勾上并提交了自检（2026-11-22）。命令存在时必须真跑过（N≥1）才放行。
  const hasCmd = /\{cmd\s*:/.test(block);
  if (!hasCmd) return { ok: true, verdict };
  const ran = /^\s*-\s*(证据|evidence)\s*[:：][^\n]*?(\d+)\s*\/\s*(\d+)\s*通过/im.exec(block);
  const ranCount = ran ? Number(ran[2]) : 0;
  return {
    ok: ranCount > 0,
    verdict,
    // 供拒绝文案区分「命令从未运行」与「命令跑了但没过」。
    reason: ranCount > 0 ? "commands-ran" : "commands-not-run",
  };
}

/**
 * 把某步的 `- [ ] T1 …` 勾成 `- [x] …`（只用于已拿到 passed 证据的步骤）。
 *
 * 返回 null = 没找到该步的未勾选行（或它已经是 [x]）——调用方按「没勾上」处理。
 */
function tickStepLine(markdown, stepId) {
  const escaped = String(stepId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(\\s*-\\s+)\\[ \\]\\s+(${escaped}(?:\\s|$))`);
  const lines = String(markdown ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i])) {
      lines[i] = lines[i].replace("[ ]", "[x]");
      return lines.join("\n");
    }
  }
  return null;
}

/**
 * 两份计划的差异是否只在「勾选状态 / 验证证据行」。
 *
 * 这种重写没有任何结构变化，却要重发整篇（计划通常 2–3k 字）。命中就拒绝，
 * 让模型改用 ai00_plan_check（几十 token）。
 */
function isStatusOnlyRewrite(prev, next) {
  const norm = (md) =>
    String(md ?? "")
      .split("\n")
      .map((line) => line.replace(/^(\s*-\s*)\[[ xX]\]/, "$1[ ]"))
      .filter((line) => !/^\s*-\s*(验证|证据|verification)\s*[:：]/i.test(line))
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n")
      .trim();
  return norm(prev) === norm(next);
}

/**
 * 计划步骤行。步骤 id 必须以数字开头（契约写的是 `T1`）——旧正则 `T[0-9A-Za-z_-]+`
 * 会把验收段里「The article is written in English…」整行当成步骤 `The`，
 * 于是勾选该验收项被误拦（要求先给 `The` 跑 ai00_task_verify），任务卡死收不了尾
 * （2026-11-24 英文端到端实测）。
 */
const STEP_LINE_RE = /^\s*-\s+\[([ xX])\]\s+(T\d[0-9A-Za-z_-]*)\s/;

/** 行号是否位于 `## Steps` / `## 步骤` 段内（标题行之后、下一个 `## ` 之前）。 */
function inStepsSection(lines, index) {
  let inSteps = false;
  for (let i = 0; i < index && i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      inSteps = /^##\s*(步骤|Steps?)\s*$/i.test(lines[i].trim());
    }
  }
  return inSteps;
}

/** 步骤 id → 是否已勾选（用于比较重写前后的勾选变化）。 */
function tickedSteps(markdown) {
  const map = new Map();
  let inSteps = false;
  for (const line of String(markdown ?? "").split("\n")) {
    if (/^##\s/.test(line)) {
      inSteps = /^##\s*(步骤|Steps?)\s*$/i.test(line.trim());
      continue;
    }
    if (!inSteps) continue;
    const head = STEP_LINE_RE.exec(line);
    if (head) map.set(head[2], head[1].toLowerCase() === "x");
  }
  return map;
}

/**
 * 找出「本次新勾上、但该步没有 `- 验证: passed`」的步骤。
 *
 * `plan_check` 已有同样的闸门，但整篇重写是绕过它的后门（实测真实任务里
 * 三个步骤全被勾成 [x]，其中两个标注「阻塞」、全库零验证行）。
 */
function newlyTickedWithoutEvidence(prevMd, nextMd) {
  const prev = tickedSteps(prevMd);
  const next = tickedSteps(nextMd);
  const lines = String(nextMd ?? "").split("\n");
  const offenders = [];
  for (const [stepId, done] of next) {
    if (!done || prev.get(stepId) === true) continue;
    const index = lines.findIndex((line) =>
      new RegExp(`^\\s*-\\s+\\[[ xX]\\]\\s+${stepId}\\s`).test(line)
    );
    if (index < 0) continue;
    if (!usableEvidence(stepBlock(lines, index)).ok) {
      offenders.push(stepId);
    }
  }
  return offenders;
}

/**
 * 写回计划时**保留验证证据**。
 *
 * 编排者重写整篇计划时手里是它自己那份副本，`ai00_task_verify` 写回的
 * `- 验证: …` / `- 证据: …` 行会被整段抹掉（实测真实任务的最终计划里
 * 验证行 0、证据行 0，而三个步骤全被勾成 [x]——进度与证据同时失真）。
 * 这里按步骤 id 把旧计划里的这两行补回新计划，缺证据就没法被抹掉。
 */
function carryOverEvidence(prevMd, nextMd) {
  if (typeof prevMd !== "string" || typeof nextMd !== "string") return nextMd;
  const prevLines = prevMd.split("\n");
  const kept = new Map();
  let inSteps = false;
  prevLines.forEach((line, i) => {
    if (/^##\s/.test(line)) {
      inSteps = /^##\s*(步骤|Steps?)\s*$/i.test(line.trim());
      return;
    }
    if (!inSteps) return;
    const head = STEP_LINE_RE.exec(line);
    if (!head) return;
    const block = stepBlock(prevLines, i).split("\n");
    const evidence = block.filter((l) => /^\s*-\s*(验证|verification|证据|evidence)\s*[:：]/i.test(l));
    if (evidence.length) kept.set(head[2], evidence);
  });
  if (!kept.size) return nextMd;

  const lines = nextMd.split("\n");
  let restored = 0;
  for (const [stepId, evidence] of kept) {
    const index = lines.findIndex((line) =>
      new RegExp(`^\\s*-\\s+\\[[ xX]\\]\\s+${stepId}\\s`).test(line)
    );
    if (index < 0) continue; // 该步已被删掉，不强行恢复
    // 逐行补：验证与证据是两类行，缺哪类补哪类
    const block = stepBlock(lines, index);
    const missing = evidence.filter((line) =>
      /^\s*-\s*(验证|verification)\s*[:：]/i.test(line)
        ? !/^\s*-\s*(验证|verification)\s*[:：]/im.test(block)
        : !/^\s*-\s*(证据|evidence)\s*[:：]/im.test(block)
    );
    if (!missing.length) continue;
    lines.splice(index + 1, 0, ...missing);
    restored += missing.length;
  }
  return restored ? lines.join("\n") : nextMd;
}

/**
 * 写回计划时**保留打回记录**。
 *
 * 人打回时前端会在「## 验收」段末写一行 `- 打回: 理由 · 时间`；agent 按打回意见
 * 修订计划通常是整篇重写（改目标 / 步骤措辞），这些行会被抹掉——隔天回看就只剩
 * 「为什么改过」的空白（7.153 实测：打回 → agent 改计划 → 打回行消失）。
 * 与验证证据同一类保护：按行补回，缺哪条补哪条，不改任何验收语义。
 */
function carryOverRejectNotes(prevMd, nextMd) {
  if (typeof prevMd !== "string" || typeof nextMd !== "string") return nextMd;
  const notes = prevMd
    .split("\n")
    .filter((line) => /^\s*-\s*打回\s*[:：]/.test(line))
    .map((line) => line.trim());
  if (!notes.length) return nextMd;
  const lines = nextMd.split("\n");
  const missing = notes.filter((note) => !lines.some((line) => line.trim() === note));
  if (!missing.length) return nextMd;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s/.test(lines[i])) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (/^##\s*(验收|Acceptance)/i.test(lines[i])) start = i;
  }
  if (start < 0) return nextMd; // 新计划没有验收段：不硬塞
  let at = end;
  while (at > start + 1 && (lines[at - 1] ?? "").trim() === "") at -= 1;
  lines.splice(at, 0, ...missing);
  return lines.join("\n");
}

/** 步骤块文本：从步骤行到下一个步骤行或下一个 `## ` 标题（不含）。 */
function stepBlock(lines, startIndex) {
  const out = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    if (STEP_LINE_RE.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** 文本块快捷构造。 */
const text = (s) => [{ type: "text", text: String(s) }];

/**
 * 解析计划 MD「## 验收」段的 `- [ ]`/`- [x]` 勾选态（与策窗口
 * utils/planAcceptance.ts 同口径）。返回 {total, done, unchecked[], items[]}；
 * items = 全部条目（集成验收要连已勾选的一起重跑）。
 */
function parseAcceptance(markdown) {
  const result = { total: 0, done: 0, unchecked: [], items: [] };
  if (typeof markdown !== "string" || !markdown) return result;
  let inSection = false;
  for (const line of markdown.split("\n")) {
    if (/^##\s/.test(line)) {
      inSection = /^##\s*(验收|Acceptance)/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
    if (m) {
      const text = m[2].trim();
      result.total += 1;
      result.items.push(text);
      if (m[1].toLowerCase() === "x") result.done += 1;
      else result.unchecked.push(text);
    }
  }
  return result;
}

/**
 * 从验收条目提取 `{cmd: ...}` 验证命令（evals 进环）。
 * 形如 `- [ ] 测试全绿 {cmd: npm test}`；无 cmd 标记返回 null（纯人工判据）。
 */
function extractCmd(item) {
  const m = /\{cmd:\s*(.+?)\}\s*$/.exec(item);
  let cmd = m ? m[1].trim() : "";
  if (!cmd) {
    // 裸命令形态：`Acceptance: cargo test`、`验收: test -f hello.txt`
    // （模型经常不写 {cmd: …} 花括号，结果整条验收掉进人工判据）
    const bare = item
      .replace(/^\s*(?:acceptance|verify|verification|验收|验证)\s*[:：]\s*/i, "")
      .trim();
    const looksBuiltin = /^(?:test\s+-[fde]\b|\[\s+-[fde]\b)/i.test(bare);
    // 只接受短 ASCII 命令行：长句/中文说明仍按人工判据处理
    if (!looksBuiltin && !isCmdAllowed(bare)) return null;
    if (!bare || bare.length > 120 || !/^[\x20-\x7E]+$/.test(bare)) return null;
    cmd = bare;
  }
  // 基本护栏：长度上限 + 拒绝嵌套 shell 展开（防计划文档被注入任意复合命令）
  if (!cmd || cmd.length > 500) return null;
  if (/`|\$\(|&&\s*rm|;\s*rm/.test(cmd)) return null;
  return cmd;
}

/**
 * 计划里写了 `{cmd: …}` 却跑不起来时，说清楚**具体是哪一条护栏**拦下的。
 *
 * 以前统一回报「too long / backticks / not whitelisted」，模型只能猜。实测
 * （2026-11-22 全链路冒烟）它把结果解释成「引号嵌套导致未被执行」，于是去改引号，
 * 白改一轮计划。这里把原因逐条点名。
 */
export function explainUnparsedCmd(text) {
  const raw = /\{cmd:([\s\S]*)$/.exec(String(text ?? ""));
  if (!raw) return "没有可解析的 `{cmd: …}`";
  const body = raw[1];
  if (!/\}\s*$/.test(body)) {
    return "`{cmd: …}` 必须以 `}` 收尾且后面不能再跟说明文字（否则整条会被当人工判据）";
  }
  const cmd = body.replace(/\}\s*$/, "").trim();
  if (!cmd) return "`{cmd: …}` 是空的";
  if (cmd.length > 500) return `命令过长（${cmd.length} > 500 字符）`;
  if (cmd.includes("`")) return "命令含反引号（安全护栏拒绝执行）";
  if (/\$\(/.test(cmd)) return "命令含 `$(`（安全护栏拒绝执行）";
  return "命令无法解析（检查花括号是否配对）";
}

/** 非白名单首词：直接说清楚允许哪些，别让模型猜。 */
function explainNotWhitelisted(cmd) {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  return `首词 "${first}" 不在白名单（cargo / rustc / pnpm / npm / npx / node / python / python3 / uv / git / go / dotnet）`;
}

/**
 * 验证命令白名单（首词命中才允许自动执行）：黑名单挡不住 `curl x | sh` /
 * `powershell -enc` 这类注入（网页内容 → worker → 计划文档 → 自检执行链路），
 * 2026-09-11 改白名单。非白名单命令不报错，回落「人工判据」口径（agent 自勾 +
 * 人类验收兜底，与不携 cmd 的条目同级信任）。
 */
const CMD_WHITELIST = new Set([
  "cargo", "rustc", "pnpm", "npm", "npx", "node", "python", "python3",
  "uv", "git", "go", "dotnet",
]);

function isCmdAllowed(cmd) {
  const first = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const normalized = first.replace(/\.(exe|cmd|bat|ps1)$/, "");
  return CMD_WHITELIST.has(normalized);
}

/**
 * 内置文件检查：`test -f/-d/-e <path>` 与 `[ -f <path> ]`。
 *
 * 计划里的验收最常见的写法就是这两条，但它们**不在白名单里**（`test` 是 shell
 * 内建/Unix 工具），于是每次验收都回落成「人工判据」→ 整个任务的所有步骤都停在
 * `needs-review`，人得逐条点。这里用 fs.stat 直接判定：确定性、零注入风险、
 * 跨平台（Windows 上没有 `test` 命令也能判）。
 *
 * 返回 null = 不是这类指令，交给原有逻辑。
 */
function builtinFileCheck(cmd, cwd) {
  const match = /^\s*(?:test\s+-([fde])\s+|\[\s+-([fde])\s+)(.+?)\s*\]?\s*$/i.exec(cmd);
  if (!match) return null;
  const flag = (match[1] || match[2] || "").toLowerCase();
  const target = match[3].trim().replace(/^["']|["']$/g, "");
  if (!target) return null;
  // 没有工作目录时相对路径无从解析（会落到引擎进程 cwd），交回人工判据
  if (!isAbsolute(target) && !cwd) return null;
  const path = isAbsolute(target) ? target : resolve(cwd || ".", target);
  let exists = false;
  let isFile = false;
  let isDir = false;
  try {
    const info = statSync(path);
    exists = true;
    isFile = info.isFile();
    isDir = info.isDirectory();
  } catch {
    exists = false;
  }
  const ok = flag === "f" ? isFile : flag === "d" ? isDir : exists;
  return { ok, output: ok ? "" : `missing: ${target}` };
}

/**
 * 验收命令的工作目录：显式 snapshotDir → 任务卡默认目录（存在时）→ ""（不执行）。
 *
 * 以前 snapshotDir 缺省时直接 `cwd: undefined`：exec 会落到引擎进程目录（可能是
 * 客户端安装目录），`git status` 之类的检查在那里可能「通过」，证据不可信。
 * 宁可把这类命令标成不可执行，让模型补 snapshotDir。
 */
export function resolveVerifyCwd(taskId, snapshotDir) {
  const explicit = String(snapshotDir ?? "").trim();
  if (explicit) return explicit;
  const base = process.env.APPDATA || process.env.HOME;
  if (!base || !taskId) return "";
  const guess = join(base, "Ai00-X", "workbenches", "tasks", taskId);
  try {
    if (statSync(guess).isDirectory()) return guess;
  } catch {
    // 任务目录不存在：不猜
  }
  return "";
}

/**
 * 执行一条验收验证命令（child_process.exec，任务工作目录内，2 分钟超时）。
 * 返回 {ok, output}；output 截断到 2000 字符（错误信息可承载，不撑爆上下文）。
 */
function runVerification(cmd, cwd, signal) {
  return new Promise((resolve) => {
    const child = exec(
      cmd,
      {
        cwd: cwd || undefined,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal,
      },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        if (error && error.killed) {
          resolve({ ok: false, output: `verification timed out after 120s: ${cmd}` });
          return;
        }
        resolve({
          ok: !error,
          output: (error ? output || error.message : output).slice(0, 2000),
        });
      },
    );
    // signal 在 exec options 里对新版 node 支持不稳，这里显式桥接一次
    if (signal) {
      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * 取 markdown 中某个二级标题段的正文行（不含标题行）。
 * 标题匹配用前缀正则（如 /^##\s*步骤/）。
 */
function sectionLines(markdown, headingPattern) {
  if (typeof markdown !== "string" || !markdown) return null;
  const lines = [];
  let inside = false;
  for (const line of markdown.split("\n")) {
    if (/^##\s/.test(line)) {
      inside = headingPattern.test(line);
      continue;
    }
    if (inside) lines.push(line);
  }
  return inside || lines.length ? lines : null;
}

/** 执行策略段：执行方式（local-first/legacy）与云端复审（adaptive/strict）。 */
function parseExecutionPolicy(markdown) {
  const policy = { execution: "legacy", review: "adaptive" };
  const lines = sectionLines(markdown, /^##\s*(执行策略|Execution Policy)/i);
  if (!lines) return policy;
  for (const line of lines) {
    const m = /^\s*-\s*(执行方式|云端复审|Execution|Review)\s*[:：]\s*(.+)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().toLowerCase();
    if (key === "执行方式" || key === "execution") policy.execution = value;
    if (key === "云端复审" || key === "review") policy.review = value;
  }
  return policy;
}

/** 步骤字段中英归一（旧中文计划与英文模板都认）。 */
const FIELD_ALIASES = {
  依赖: "依赖",
  "depends on": "依赖",
  dependencies: "依赖",
  dependency: "依赖",
  风险: "风险",
  risk: "风险",
  范围: "范围",
  scope: "范围",
  paths: "范围",
  实施细则: "实施细则",
  implementation: "实施细则",
  验收: "验收",
  acceptance: "验收",
  验证: "验证",
  verification: "验证",
  证据: "证据",
  evidence: "证据",
  状态: "状态",
  state: "状态",
  status: "状态",
};

/**
 * 解析「## 步骤」段的结构化任务：
 * - [ ] T1 标题 / - 依赖: none / - 风险: low / - 范围: a.ts, b.ts /
 *   - 实施细则: ... / - 验收: ... {cmd: ...}
 */
function parsePlanSteps(markdown) {
  const lines = sectionLines(markdown, /^##\s*(步骤|Steps?)/i);
  if (!lines) return [];
  const steps = [];
  let current = null;
  /** 最近一个字段：用于识别「验收:」下面换行缩进的子项写法。 */
  let currentField = null;
  for (const line of lines) {
    const head = /^\s*-\s+\[([ xX])\]\s+(T\d[0-9A-Za-z_-]*)\s+(.*)$/.exec(line);
    if (head) {
      current = {
        id: head[2],
        title: head[3].trim(),
        done: head[1].toLowerCase() === "x",
        dependencies: [],
        risk: "low",
        paths: [],
        implementation: "",
        acceptance: [],
      };
      steps.push(current);
      continue;
    }
    if (!current) continue;
    // 属性行允许两种写法：`- Depends on: …` 与 `Depends on: …`
    // （2026-11-24 真机：编排者写成无短横线版本，旧解析拿不到 Acceptance 的
    // {cmd}，命令 0/0、步骤永远 needs-review 且无法勾选）。
    const prop = /^\s*(?:-\s*)?([^:：]{1,24})[:：]\s*(.*)$/.exec(line);
    const field = prop ? FIELD_ALIASES[prop[1].trim().toLowerCase()] : undefined;
    if (!field) {
      // 「验收:」换行写子项（`- Acceptance:` 后每个 `- … {cmd: …}` 一行）是最自然的
      // markdown 写法，也实测被模型写出来过。旧解析只认单行「验收: 文本 {cmd:…}」，
      // 这种写法会被整段忽略 → 命令 0/0、步骤永远 needs-review（2026-11-22 e2e）。
      // 只要当前字段是「验收」，缩进子项就按一条验收处理（保留其文本与命令）。
      const sub = /^\s+-\s+(.+)$/.exec(line);
      if (currentField === "验收" && sub && sub[1].trim()) {
        const text = sub[1].trim();
        current.acceptance.push({ text, cmd: extractCmd(text) });
      }
      continue;
    }
    currentField = field;
    const value = prop[2].trim();
    switch (field) {
      case "依赖":
        current.dependencies = /^none$/i.test(value)
          ? []
          : value.split(/[,，\s]+/).filter(Boolean);
        break;
      case "风险":
        current.risk = value.toLowerCase();
        break;
      case "范围":
        current.paths = value
          .split(/[,，]/)
          .map((p) => p.trim())
          .filter(Boolean);
        break;
      case "实施细则":
        current.implementation = value;
        break;
      case "验收":
        if (value) current.acceptance.push({ text: value, cmd: extractCmd(value) });
        break;
      default:
        break;
    }
  }
  return steps;
}

/**
 * DoD 签名：人当初批准的那份契约——目标 + 步骤清单（编号 / 标题 / 验收）+ 全局验收条目。
 *
 * 刻意不含勾选态、验证/证据/状态/打回行，也不含范围 / 实施细则 / 风险 / 依赖：
 * 那些是执行细节，改它们不该逼人重新批一遍计划。反之，改「验什么」必须重新待批，
 * 否则 agent 只要把判据改得容易过，就能在不改交付物的情况下过验收（实测发生过：
 * 被打回后把「语义与契约一致」改写成「正文恰有 3 个句号」）。
 */
export function dodSignature(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return "";
  const goal = (sectionLines(markdown, /^##\s*(目标|Goal)/i) ?? [])
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const steps = parsePlanSteps(markdown).map((step) => ({
    id: step.id,
    title: step.title.replace(/\s+/g, " "),
    acceptance: step.acceptance.map((a) => a.text.replace(/\s+/g, " ")),
  }));
  const acceptance = parseAcceptance(markdown).items.map((t) => t.replace(/\s+/g, " "));
  return JSON.stringify({ goal, steps, acceptance });
}

/**
 * 写入/替换计划里的「## 验证记录」段（集成验收摘要）。
 *
 * 集成验收的结论原本只活在这一次工具返回里：模型看得到，**人看不到**——
 * 验收卡只展示步骤与验收勾选。把结论落进计划文档，验收人打开卡片就能看到
 * 「交付物齐 / 有计划外文件 / 有复核记录 / 有编码损坏」，也不必依赖聊天记录。
 */
export function upsertVerifyRecord(markdown, items) {
  const md = String(markdown ?? "");
  if (!items?.length) return md;
  const block = ["## 验证记录", ...items.map((t) => `- ${t}`)];
  const src = md.split("\n");
  let start = -1;
  let end = src.length;
  for (let i = 0; i < src.length; i++) {
    if (!/^##\s/.test(src[i])) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (/^##\s*(验证记录|Verify log)/i.test(src[i])) start = i;
  }
  const out =
    start < 0
      ? [...src, ...(src[src.length - 1]?.trim() ? [""] : []), ...block]
      : [...src.slice(0, start), ...block, "", ...src.slice(end)];
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * 把「验证 / 证据」两行写回指定步骤块（展示层的事实来源）。
 *
 * 只做行级 upsert：已有则替换，没有则插到该步骤块最后一条子行之后；
 * 找不到步骤或结构异常时原样返回（不阻断验证）。
 */
function upsertStepEvidence(markdown, stepId, verdict, evidence) {
  if (typeof markdown !== "string" || !markdown || !stepId) return markdown;
  const lines = markdown.split("\n");
  const stepHead = new RegExp(`^\\s*-\\s+\\[[ xX]\\]\\s+${stepId}\\s`);
  let insideSteps = false;
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      if (start >= 0) {
        end = i;
        break;
      }
      // 循环契约规定标题用英文（## Steps），这里必须与 parsePlanSteps 同口径：
      // 只认「## 步骤」会让英文计划的验证证据**永远写不进去**（实测 gate 探针）。
      insideSteps = /^##\s*(步骤|Steps?)/i.test(line);
      continue;
    }
    if (!insideSteps) continue;
    if (start < 0 && stepHead.test(line)) {
      start = i;
      continue;
    }
    if (start >= 0 && STEP_LINE_RE.test(line)) {
      end = i;
      break;
    }
  }
  if (start < 0) return markdown;
  if (end < 0) end = lines.length;

  // 计划文档给人看：用本地时间（UTC 的 ISO 串会让人以为是错的时区）
  const at = localStamp();
  const time = ` · ${at}`;
  const verifyLine = `  - 验证: ${verdict}${time}`;
  const evidenceLine = `  - 证据: ${evidence}`;

  let verifyAt = -1;
  let evidenceAt = -1;
  let lastChild = start;
  for (let i = start + 1; i < end; i++) {
    if (/^\s*-\s*验证\s*[:：]/.test(lines[i])) verifyAt = i;
    else if (/^\s*-\s*证据\s*[:：]/.test(lines[i])) evidenceAt = i;
    else if (/^\s*-\s*/.test(lines[i])) lastChild = i;
  }

  const next = [...lines];
  if (evidenceAt >= 0) next[evidenceAt] = evidenceLine;
  else {
    const insertAt = verifyAt >= 0 ? verifyAt + 1 : lastChild + 1;
    next.splice(insertAt, 0, evidenceLine);
    if (verifyAt >= 0 && insertAt <= verifyAt) verifyAt += 1;
    if (evidenceAt >= 0 && insertAt <= evidenceAt) evidenceAt += 1;
  }
  if (verifyAt >= 0) next[verifyAt] = verifyLine;
  else {
    const anchor = evidenceAt >= 0 ? evidenceAt : lastChild;
    next.splice(anchor + 1, 0, verifyLine);
  }
  return next.join("\n");
}

/**
 * 精简证据摘要：命令通过数 / 变更文件数。
 *
 * 失败时必须把**失败命令与输出的首段**写进计划：否则下一次续跑/重派只能看到
 * 「命令 0/1 通过 · 失败 1」，还得再调一次 verify 才知道缺什么（实测 gbo T4
 * 连续两轮返工都没补「修订记录」，因为失败原因从未出现在计划里）。
 */
function summarizeEvidence(commands, changedFiles) {
  const total = commands.length;
  const passed = commands.filter((cmd) => cmd.ok).length;
  const failed = commands.filter((cmd) => !cmd.ok);
  const parts = [`命令 ${passed}/${total} 通过`];
  if (failed.length) {
    parts.push(`失败 ${failed.length}`);
    const first = failed[0];
    const cmd = String(first.cmd ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
    const output = String(first.output ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    parts.push(`失败命令: ${cmd}${output ? ` → ${output}` : ""}`);
  }
  if (changedFiles.length) parts.push(`变更 ${changedFiles.length} 文件`);
  return parts.join(" · ");
}

/** 读文本文件前 N 个字符（读失败/二进制返回 null）。 */
async function readTextFile(path, maxChars) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 512 * 1024) return null;
    const text = await readFile(path, "utf8");
    if (text.includes("\u0000")) return null;
    return text.slice(0, maxChars);
  } catch {
    return null;
  }
}

/**
 * 收集 git 证据：是否仓库 / 改动文件 / 可选 diff。
 *
 * `status --porcelain` 给改动清单；`git diff HEAD` 给补丁（高风险/严格模式用）。
 * 未跟踪文件不在 diff 里，单独按内容追加（见 collectGitEvidence 内部注释）。
 */
function collectGitEvidence(cwd, paths, includeDiff) {
  return new Promise((resolve) => {
    if (!cwd) {
      resolve({ repo: false, changedFiles: [], diff: null, diffTruncated: false });
      return;
    }
    const run = (args) =>
      new Promise((done) => {
        execFile(
          "git",
          args,
          { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (error, stdout) => done(error ? null : String(stdout ?? ""))
        );
      });
    (async () => {
      const inside = await run(["rev-parse", "--is-inside-work-tree"]);
      if (!inside || inside.trim() !== "true") {
        resolve({ repo: false, changedFiles: [], diff: null, diffTruncated: false });
        return;
      }
      const status = await run(["status", "--porcelain"]);
      const changedFiles = (status ?? "")
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
        .slice(0, 200);
      let diff = null;
      let diffTruncated = false;
      if (includeDiff) {
        const pathspec = Array.isArray(paths) && paths.length ? ["--", ...paths] : [];
        const text = await run(["diff", "HEAD", "--no-color", ...pathspec]);
        if (text) {
          diffTruncated = text.length > 12_000;
          diff = text.slice(0, 12_000);
        }
        // `git diff HEAD` 不含未跟踪文件：新建的产物恰恰是最需要评审的东西。
        // 这里把未跟踪文件的内容按上限补进 diff（只读，不改索引）。
        const untracked = (status ?? "")
          .split("\n")
          .filter((line) => line.startsWith("??"))
          .map((line) => line.slice(3).trim())
          .filter(Boolean)
          .slice(0, 5);
        const parts = [];
        let budget = 4000;
        for (const rel of untracked) {
          if (budget <= 0) break;
          // 注意：这里**不能**用 path 的 `resolve`——外层 `new Promise((resolve) => …)`
          // 已经把 `resolve` 遮成 promise 的 resolve，误用会让整个证据对象变成一个字符串。
          const body = await readTextFile(join(cwd, rel), Math.min(budget, 2000));
          if (body === null) continue;
          const block = `--- new file: ${rel} ---\n${body}`;
          parts.push(block);
          budget -= block.length;
        }
        if (parts.length) {
          const appended = [diff ?? "", ...parts].filter(Boolean).join("\n");
          diffTruncated = diffTruncated || appended.length > 12_000;
          diff = appended.slice(0, 12_000);
        }
      }
      resolve({ repo: true, changedFiles, diff, diffTruncated });
    })().catch(() => resolve({ repo: false, changedFiles: [], diff: null, diffTruncated: false }));
  });
}

/**
 * 完成任务：completedAt 置当前时间；周期任务克隆下一次（due 推进、
 * remindAt 同时刻映射、状态复位）。返回 {data, task, xp}。
 */
function submitSelfCheckInData(data, taskId, deliverables) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const index = tasks.findIndex((t) => t?.id === taskId);
  if (index < 0) {
    throw new Error(`task not found: ${taskId} (use ai00_todo_read to list tasks)`);
  }
  const task = tasks[index];
  if (task.completedAt) {
    throw new Error(`task already completed (human-accepted): ${task.title}`);
  }
  // 幂等：已提交过自检 → 不重复写时间戳，但允许**补登记交付物**。
  // 实测：模型首次用相对路径提交，面板没有产物链接；人类让它用绝对路径再提一次时，
  // 旧实现对新增路径静默丢弃（"0 deliverables registered"），产物始终挂不上。
  if (task.agentCompletedAt) {
    const incoming = Array.isArray(deliverables) ? deliverables.map(String).filter(Boolean) : [];
    const before = Array.isArray(task.deliverables) ? task.deliverables : [];
    const merged = [...new Set([...before, ...incoming])].slice(0, 20);
    const added = merged.filter((p) => !before.includes(p));
    const nextTasks = [...tasks];
    nextTasks[index] = added.length ? { ...task, deliverables: merged } : task;
    return {
      data: { ...data, tasks: nextTasks },
      task: nextTasks[index],
      already: true,
      added,
    };
  }
  const now = Date.now();
  const nextTasks = [...tasks];
  // 双段验收：这里只提交「模型自检通过」——完成（completedAt）/XP/周期克隆
  // 全部挪到人类验收（策窗口「验收通过」），agent 不得替人拍板。
  // deliverables：本次产出交付物的文件路径清单（面板「交付物」抽屉展示）。
  nextTasks[index] = {
    ...task,
    agentCompletedAt: now,
    ...(Array.isArray(deliverables) && deliverables.length
      ? { deliverables: deliverables.map(String).filter(Boolean).slice(0, 20) }
      : {}),
  };
  return { data: { ...data, tasks: nextTasks }, task, already: false };
}

// ---------------------------------------------------------------------------
// 工具定义（原始 ToolDefinition 形状）
// ---------------------------------------------------------------------------

/**
 * 会话工作目录 → 任务 id（`…/workbenches/tasks/<taskId>`）。
 *
 * 只认工作台任务目录里的 `t-<时间戳>-<短码>`；普通项目目录返回空串（不猜）。
 */
export function taskIdFromCwd(path) {
  const match = /(?:^|[\\/])(t-\d+-[a-z0-9]+)(?:[\\/]|$)/i.exec(String(path ?? ""));
  return match ? match[1] : "";
}

/**
 * 显式 taskId 与工作目录推断值之间取哪个。
 *
 * 工作台会话的 cwd 就是它那张卡的任务目录，所以**目录优先**：模型偶尔会把长 id
 * 抄错（实测 `t-179520207736548-5kr`），甚至小模型退化成一串同样的数字
 * （实测 `t-17953232818525336482676897899082969…`，`ai00_plan_read` 还回了
 * 「no plan document yet」，看起来像卡里真没计划）。普通项目会话没有可推断的
 * 目录，仍用显式值。
 */
export function pickTaskId(explicit, cwd) {
  return taskIdFromCwd(cwd) || String(explicit ?? "").trim();
}

/** 来源汇编里的条目数（按 `- URL:` 行去重计数）。 */
export function countResearchSources(text) {
  return new Set(
    [...String(text ?? "").matchAll(/^- URL:\s*(\S+)\s*$/gm)].map((m) => m[1])
  ).size;
}

/**
 * 合并两次 `ai00_research_collect` 的来源汇编（纯函数）。
 *
 * 本地小模型会把同一个采集工具连调多次（实测一份任务里调了 3 次），而宿主每次
 * 都用 `fs::write` 覆盖同一个 `sources.md`：先采到 11 条、第二次只剩 2 条，
 * 前面的一手来源全丢，后续写作只能拿残档凑。这里按 URL 去重合并：保留旧条目，
 * 追加新条目，并重排编号。
 *
 * 旧文件不是来源汇编（模型自己写过别的内容）时不做合并；新文件没有新增来源时
 * 直接返回旧内容（等价于不覆盖）。
 */
export function mergeResearchSources(prev, next) {
  const parse = (text) => {
    const entries = [];
    const header = [];
    let current = null;
    for (const line of String(text ?? "").split("\n")) {
      const head = /^##\s+\d+\.\s+(.*)$/.exec(line);
      if (head) {
        if (current) entries.push(current);
        current = { title: head[1].trim(), url: "", block: [line] };
        continue;
      }
      if (current) {
        current.block.push(line);
        const url = /^- URL:\s*(\S+)\s*$/.exec(line);
        if (url && !current.url) current.url = url[1];
      } else {
        header.push(line);
      }
    }
    if (current) entries.push(current);
    return { header, entries };
  };
  const before = parse(prev);
  const after = parse(next);
  if (before.entries.length === 0) return next; // 不是来源汇编：不合并
  const known = new Set(before.entries.map((e) => e.url).filter(Boolean));
  const added = after.entries.filter((e) => !e.url || !known.has(e.url));
  if (added.length === 0) return prev; // 没有新增来源：保留旧文件
  const merged = [...before.entries, ...added];
  const header = (before.header.length ? before.header : after.header)
    .join("\n")
    .replace(
      /Collected by ai00_research_collect · \d+ sources/,
      `Collected by ai00_research_collect · ${merged.length} sources`
    )
    .trimEnd();
  const body = merged
    .map((entry, index) => {
      const block = entry.block.slice();
      block[0] = `## ${index + 1}. ${entry.title}`;
      return block.join("\n").trimEnd();
    })
    .join("\n\n");
  return `${header}\n\n${body}\n`;
}

/**
 * 本地章节扩写的「正文清洗」：宿主统一补 `## heading`，模型只负责正文。
 *
 * 3B 在纯文本模式（无工具 schema）下段落质量明显好于把整段塞进 write 的
 * JSON 参数；但段尾偶尔续写对话角色（实测英文段落尾部出现 `**User1:**`）
 * 或自带标题/围栏。这里按确定性规则剥掉这些噪声，剩下正文原样落盘。
 *
 * 2026-11-24 基准实测的额外退化形态（都按内容特征处理，不看长度）：
 * - `<think>…</think>` 思考块透传（未闭合 = 整段只有思考，返回空）；
 * - 段首乱码符号（emoji / `⯢⯤` 方框符号 / 数学粗体字母）；
 * - 提示词回声（`You are a careful writer…`、`### Instruction`、`Write the body of…`）；
 * - HTML 碎片（`<span class="span10_0">` 与 `textContent=` 属性串）。
 */
export function sanitizeComposedSection(raw, heading) {
  let body = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  body = body.replace(/^```[a-zA-Z]*\s*\n/, "").replace(/\n```\s*$/, "").trim();
  // 思考块：闭合的整块删掉（后面才是正文）；只有开头没有闭合 = 全是思考
  body = body.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  if (/<think/i.test(body)) return "";
  body = body.replace(/<\/?think>/gi, " ").trim();
  // 首行样板警告（`⚠️ WARNING: …`）
  body = body.replace(/^[⚠️\s]*WARNING\s*[:：][^\n]*\n?/i, "").trim();
  const lines = body.split("\n");
  while (lines.length && /^#{1,6}\s/.test(lines[0].trim())) lines.shift();
  body = stripMetaLines(lines.join("\n"));
  // 模型在正文开头重复标题（`Use Cases The device-specific …`）：去掉这次重复
  const bare = String(heading ?? "")
    .trim()
    .replace(/^#{1,6}\s*/, "");
  if (bare) {
    const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 只有「标题 + 大写开头/中文开头」才算回声；`Limitations include …` 是正常句子
    // （不能把大小写判断写进带 i 标志的正则——`[A-Z]` 会连小写一起匹配）
    const head = new RegExp(`^\\s*${escaped}\\s*[:：]?\\s+`, "i").exec(body);
    if (head) {
      const rest = body.slice(head[0].length);
      if (/^[A-Z"“(\\[]|^\p{Script=Han}/u.test(rest)) body = rest.trim();
    }
  }
  // 角色/续写标记：本地小模型常在段中/段尾幻想下一轮对话（`**User1:**`、
  // 行内 `User/user:`、`UserAI prompts:` 都实测出现过）。普通英文 "system:"
  // 不误伤：非加粗形态只在句首/换行/句末标点之后才算标记。
  // 提示词回声（含 `Useruestion:` 这类角色后缀）一并从这里截断。
  let cut = body.length;
  const echo = PROMPT_ECHO_RE.exec(body);
  if (echo) cut = echo.index;
  // 代码围栏：正文段落不该出现 ```（实测 `text1✿UserCode:```python` 漏网），
  // 从围栏处截断，前面的正文保留；截断后太短会被质量门按空输出处理。
  const fence = body.indexOf("```");
  if (fence >= 0 && fence < cut) cut = fence;
  // 训练数据续写（实测 `User# User\n**I want you to be our coding buddy…`）
  const continuation = CONTINUATION_RE.exec(body);
  if (continuation && continuation.index < cut) cut = continuation.index;
  // 角色词粘连（`UserCode:`、`UserAccount:` —— User 后接大写单词再冒号）
  const roleWord = /\b(?:user|human|assistant)(?:[A-Z][a-z]+)?\s*[:：]/.exec(body);
  if (roleWord && roleWord.index < cut) cut = roleWord.index;
  const bold = /\*{1,2}\s*(user|assistant|human|system)\s*\d*\s*:\s*\*{0,2}/i.exec(body);
  if (bold && bold.index < cut) {
    cut = bold.index;
  } else {
    const inline =
      /(^|[\n。．.!?！？;；])\s*(user|assistant|human|system)\s*([/／]\s*(user|assistant|human|system))?\s*(ai)?\s*(prompts?)?\s*[:：]/i.exec(
        body
      );
    if (inline && inline.index + (inline[1]?.length ?? 0) < cut) {
      cut = inline.index + (inline[1]?.length ?? 0);
    } else if (!bold) {
      const tag = /<\|[^|>]*\|>/.exec(body);
      if (tag && tag.index < cut) cut = tag.index;
    }
  }
  body = body.slice(0, cut).replace(/(?:User\w*|Human|Assistant)\s*[:：]\s*$/i, "");
  // 段尾续写标记（`…Raw:` / `…Response:` / `…Text`，实测出现在句末/围栏之后）
  body = body
    .replace(/([。.!?;；\s])(?:Raw|Response|Text|Hex|Base64)\s*[:：]?\s*$/i, "$1")
    .replace(/\s+$/, "");
  body = body.replace(/[\s\-—–:：,，;；/／]+$/, "").trim();
  // 段尾残留符号/装饰（`⇇⇇`、`‼️#`；正常句末标点与括号不受影响）
  body = body.replace(/[^\p{L}\p{N}.!?。！？…"”’)\]}】》%]+$/u, "").trim();
  // 段首乱码符号（保留正常的引号/括号开头）
  body = body.replace(/^[^\p{L}\p{N}"“'‘(\[]+/u, "").trim();
  if (
    (body.startsWith('"') && body.endsWith('"')) ||
    (body.startsWith("“") && body.endsWith("”"))
  ) {
    body = body.slice(1, -1).trim();
  }
  return body;
}

/** 提示词回声标记：命中即从该处截断（本地 3B 实测会复述 system/user 指令）。 */
const PROMPT_ECHO_RE =
  /(?:You are a careful writer|Write the body of|###\s*Instruction|Output only (?:the )?body|No headings, no quotes|Stop after that paragraph|Based on the provided text|Answer based on|one short paragraph|Only the paragraph|automatically generated by)/i;

/** 角色井号标记与越狱式续写（本地 3B 会把训练数据里的对话续出来）。 */
const CONTINUATION_RE =
  /\b(?:User|Human|Assistant)\s*#+\s*(?:User|Human|Assistant)\b|\bI want you to (?:be|act|help)\b|\bIn this task, you will\b|\bYour task is to\b|\bINST\s*RUCTIONS?\b/i;

/** 推理/答案说明元行（正文之前常见）：整行剥掉，正文本身保留。 */
const META_LINE_RE =
  /(?:Based on the provided text|Answer based on|paragraph that details|one short paragraph|3-4 sentences|###?\s*instruction|^reasoning\b|\bit\s*:\s*$|^(?:answer|response|output)\s*[>》]?\s*[:：]?\s*$)/i;

/**
 * 去掉「推理/答案说明」元行与残留标记行，保留真正的正文行。
 * 实测（2026-11-24）：英文 Overview 在正文前吐了两三行说明
 * （`Reasoning type="..." />`、`Based on the provided text, the paragraph … is:`），
 * 后面的正文却是可用的——整段截断会误杀，只能按行剥离。
 */
function stripMetaLines(text) {
  const kept = [];
  for (const line of String(text ?? "").split("\n")) {
    const value = line.trim();
    if (META_LINE_RE.test(value)) continue;
    if (/(?:type\s*=\s*"|\/>\s*$)/.test(line)) continue; // 残留标记/自闭合标签
    if (/^(?:hex|base64|bytes)\s*[:：]/i.test(value)) continue; // 编码转储行
    if (/^[0-9a-f]{32,}$/i.test(value)) continue; // 裸十六进制块
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** 正文字符判定：字母/数字/空白，以及常见中英标点（数学粗体字母不算）。 */
const SAFE_PUNCT_RE = /[.,;:!?'"()[\]{}%\-–—…·、。，；：！？""''《》〈〉「」『』【】（）/\\&+*=#@~|$^_]/;

function junkRatio(text) {
  const chars = [...String(text ?? "")];
  if (!chars.length) return 0;
  let junk = 0;
  for (const ch of chars) {
    if (/[\u{1D400}-\u{1D7FF}]/u.test(ch)) {
      junk += 1; // 数学粗体/花体字母：3B 乱码常见形态
      continue;
    }
    if (/[\s\p{L}\p{N}]/u.test(ch)) continue;
    if (SAFE_PUNCT_RE.test(ch)) continue;
    junk += 1;
  }
  return junk / chars.length;
}

/**
 * 内容质量门（不是长度门）：只拦**明确坏掉**的输出，正常长短一律放行。
 * 命中即按单节失败处理，由编排者升级云端；compose 内部会先换采样重试一次。
 */
function looksDegenerate(text, language) {
  const value = String(text ?? "");
  if (!value.trim()) return true;
  if (/<\/?[a-z][a-z0-9]*(\s[^<>]*)?>/i.test(value)) return true; // HTML 碎片
  if (/(?:textContent|span\s+end|start\s+end)\s*=/i.test(value)) return true;
  if (PROMPT_ECHO_RE.test(value)) return true; // 提示词回声
  if (CONTINUATION_RE.test(value)) return true; // 训练数据续写
  if (value.includes("```")) return true; // 代码围栏（正文里不该出现）
  if (/<think/i.test(value)) return true;
  if (languageMismatch(value, language)) return true; // 语言跑偏（英文请求吐中文）
  return junkRatio(value) > 0.12;
}

/** 文字里 CJK / 拉丁字母的占比（只统计非空白字符）。 */
function scriptRatios(text) {
  const chars = [...String(text ?? "")].filter((ch) => !/\s/u.test(ch));
  if (!chars.length) return { cjk: 0, latin: 0 };
  let cjk = 0;
  let latin = 0;
  for (const ch of chars) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) cjk += 1;
    else if (/\p{Script=Latin}/u.test(ch)) latin += 1;
  }
  return { cjk: cjk / chars.length, latin: latin / chars.length };
}

/**
 * 语言闸门：只对「明确的目标语言」生效，避免误伤小语种。
 * 实测（2026-11-24）：英文请求下 3B 有 2/4 节整段输出中文；这种段落对英文
 * 文档不可用，必须按单节失败处理（宿主重试 → 仍不合格升级云端）。
 */
function languageMismatch(text, language) {
  const lang = String(language ?? "").toLowerCase();
  if (!lang) return false;
  const { cjk, latin } = scriptRatios(text);
  if (/chinese|中文|汉语|漢語|japanese|日本語|korean|한국/.test(lang)) return cjk < 0.3;
  if (/english|英文|英语|french|german|spanish|portuguese|italian/.test(lang)) {
    return cjk > 0.2 || latin < 0.3;
  }
  return false;
}

/**
 * 明显退化检测：本地 3B 偶发单字/短语复读（`必必必必`、`关于关于关于`）。
 * 这是内容质量门，不是长度门——只拦复读噪声，不评价长短。
 */
export function looksRepetitive(text) {
  const value = String(text ?? "");
  if (/(.)\1{3,}/u.test(value)) return true;
  return /(.{2,6})\1{2,}/u.test(value);
}

/**
 * 网关回包解析：兼容 OpenAI SSE 与普通 JSON，并取出 finish_reason。
 *
 * `finish_reason === "length"` = 撞到 max_tokens 被截断：compose 会换采样重试，
 * polish 直接拒绝写回（半截文档比原稿更糟）。
 */
function parseCompletion(raw) {
  if (raw.trimStart().startsWith("data:")) {
    let out = "";
    let finishReason = "";
    for (const line of raw.split("\n")) {
      const data = line.trim().replace(/^data:\s*/, "");
      if (!data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data);
        const choice = chunk?.choices?.[0];
        out += choice?.delta?.content ?? chunk?.text ?? "";
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      } catch {
        // 非 JSON 行（心跳/错误尾）忽略
      }
    }
    return { text: out, finishReason };
  }
  try {
    const value = JSON.parse(raw);
    const choice = value?.choices?.[0];
    return {
      text: choice?.message?.content ?? value?.text ?? "",
      finishReason: choice?.finish_reason ?? "",
    };
  } catch {
    return { text: raw, finishReason: "" };
  }
}

/**
 * 用本地 RWKV 生成一段正文（纯文本，无工具）。网关以 OpenAI SSE 回包，
 * 这里同时兼容 SSE 与普通 JSON 两种形态。
 */
async function composeLocalSection({ baseURL, token, heading, topic, language, topP, signal }) {
  // 长度不是验收标准：只说「一个短段落」，不给句数/字数目标。
  //
  // 2026-11-24 A/B（真实网关，5 节 × 4 轮 = 20 样本/变体）：旧的「You are a
  // careful writer…3-4 short sentences…Stop after that paragraph」12/20 通过
  // （空输出 4、语言跑偏 3、复读 1，另有 10–14s 的长尾）；换成这条 20 token
  // 的短提示后 19/20（仅 1 次空输出），生成也更短更快。短提示留给 3B 复述的
  // 素材更少，回声/续写概率随之下降。
  // 同日第二组 A/B（6 节 × 2 轮）：B 12/12 但 2 轮出现第一人称/模型自述
  // （`I’m limited by my training data…`）；加上「Do not write in first person
  // or as an AI model」后 11/12、第一人称 0 次，故采用 D 变体。
  const messages = [
    {
      role: "system",
      content: `Write one short paragraph of plain prose in ${language}. No headings, lists, quotes, numbers or commentary. Do not write in first person or as an AI model. Only the paragraph.`,
    },
    {
      role: "user",
      content: `Section: "${heading}". Topic: ${topic}.`,
    },
  ];
  // 2026-11-24 探针（6 节 × 2 档）：max_tokens=220 时有 1 节正好截在 220
  // 并转成乱码、1 节停在 `Q:`；320 下 6/6 都以句末标点收尾（最长 278 token），
  // 并行墙钟 6.0s（220 为 4.9s）。留足收尾空间比省这 1 秒重要。
  const body = { model: "rwkv-local", messages, stream: false, max_tokens: 320 };
  // 质量门重试时换采样（与网关草稿门同一配方：top_p 0.5 探索一次）
  if (topP !== undefined) body.top_p = topP;
  const response = await fetch(`${baseURL}/ai00-internal/llm/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ai00-internal-token": token,
      "x-ai00-plugin-id": PLUGIN_ID,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`local model HTTP ${response.status}`);
  return parseCompletion(await response.text());
}

/** 文档里的 `## ` 标题序列（润色前后必须一致）。 */
function documentHeadings(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

/** 润色输出校验：标题序列必须原样保留，否则拒绝写入（原稿不动）。 */
function validatePolishedDocument(source, output) {
  const before = documentHeadings(source);
  if (before.length === 0) return "source document has no ## headings";
  const after = documentHeadings(output);
  if (after.join("|") !== before.join("|")) {
    return `headings changed (${after.join(" | ") || "none"})`;
  }
  return null;
}

/** 云端润色：模型只返回正文文本，宿主校验后原子写回。 */
async function polishRemoteDocument({ baseURL, token, content, language, signal }) {
  const messages = [
    {
      role: "system",
      content:
        "You are an expert editor. Rewrite the document for grammar, clarity and flow. Keep every '## ' heading exactly as given, in the same order, and keep the same facts. Return ONLY the full revised Markdown document — no commentary, no code fences.",
    },
    {
      role: "user",
      content: `Language: ${language || "the document language"}\n\n${content}`,
    },
  ];
  const response = await fetch(`${baseURL}/ai00-internal/llm/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ai00-internal-token": token,
      "x-ai00-plugin-id": PLUGIN_ID,
    },
    body: JSON.stringify({
      model: "ai00-api",
      messages,
      stream: false,
      temperature: 0.2,
      max_tokens: 4096,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`remote model HTTP ${response.status}`);
  const parsed = parseCompletion(await response.text());
  let text = parsed.text.trim();
  text = text.replace(/^```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/, "").trim();
  return { text, finishReason: parsed.finishReason };
}

function defineTools(ctx, api, env = {}) {
  /**
   * taskId 解析：模型漏传/传错时以会话工作目录为准。
   *
   * 工作台任务的 cwd 固定是 `<APPDATA>/Ai00-X/workbenches/tasks/<taskId>`（见
   * `resolveVerifyCwd`），会话本来就绑定在这张卡上。实测有回合连续漏传 taskId
   * （连吃两次 `Error: taskId is required`），每次都是一整轮往返 + 一条错误上下文；
   * 也有抄错/退化成乱码的 id 静默读到「没有计划」。普通项目会话的 cwd 里没有
   * `t-…` 段，仍按缺参报错，不猜。
   */
  async function resolveTaskId(args, exec) {
    let cwd = "";
    try {
      cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    } catch {
      cwd = "";
    }
    return pickTaskId(args?.taskId, cwd);
  }

  // ---- ai00_notify：系统桌面通知 ----
  ctx.tools.register({
    name: "ai00_notify",
    description:
      "Send an OS-level desktop notification through the Ai00-X host (Windows toast / macOS notification center). Use for reminders and task completion alerts.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title (short)." },
        body: { type: "string", description: "Optional notification body text." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) => text(value.ok ? "notification sent" : "notification failed"),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const title = String(args?.title ?? "").trim();
      if (!title) throw new Error("title is required");
      await api.post(
        "/notify",
        { title, ...(args?.body ? { body: String(args.body) } : {}) },
        exec.signal
      );
      return { ok: true };
    },
  });

  // ---- ai00_wallpaper_create：创建壁纸项目（agent 生成 HTML 经参数落盘）----
  ctx.tools.register({
    name: "ai00_wallpaper_create",
    description:
      'Create a wallpaper project from generated HTML and optionally apply it to the desktop. Pass the COMPLETE self-contained HTML document (inline CSS/JS, no external dependencies). The host writes it to disk, publishes, and (apply: true, default) sets it as the desktop wallpaper.',
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short wallpaper project name (e.g. 'starry-night').",
        },
        html: {
          type: "string",
          description: "Complete self-contained HTML document for the wallpaper.",
        },
        apply: {
          type: "boolean",
          description: "Apply to desktop after creation. Defaults to true.",
        },
      },
      required: ["name", "html"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          name: { type: "string" },
          serveUrl: { type: "string" },
          applied: { type: "boolean" },
          // 应用失败时的错误信息（项目已创建成功）
          applyError: { type: "string" },
        },
        required: ["projectId", "name", "serveUrl", "applied"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(
          `wallpaper created: ${value.name} (${value.serveUrl})${value.applied ? ", applied to desktop" : value.applyError ? `, apply failed: ${value.applyError}` : ""}`
        ),
    },
    async execute(args, exec) {
      const name = String(args?.name ?? "").trim();
      const html = String(args?.html ?? "").trim();
      if (!name || !html) throw new Error("name and html are required");
      const result = await api.post(
        "/wallpaper/create",
        {
          name,
          html,
          ...(args?.apply !== undefined ? { apply: !!args.apply } : {}),
        },
        exec.signal
      );
      // 清洗 null（schema 不接受）
      return {
        projectId: String(result.projectId ?? ""),
        name: String(result.name ?? name),
        serveUrl: String(result.serveUrl ?? ""),
        applied: !!result.applied,
        ...(result.applyError ? { applyError: String(result.applyError) } : {}),
      };
    },
  });

  // ---- ai00_wallpaper_projects：列出现有壁纸项目 ----
  ctx.tools.register({
    name: "ai00_wallpaper_projects",
    description:
      "List existing wallpaper projects (id, name, serveUrl). Use before creating a new one to avoid duplicates, or to find a project to re-apply.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          projects: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                serveUrl: { type: "string" },
              },
              required: ["id", "name", "serveUrl"],
              additionalProperties: false,
            },
          },
        },
        required: ["projects"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(
          value.projects.length === 0
            ? "no wallpaper projects yet"
            : `wallpaper projects:\n${value.projects.map((p) => `- ${p.name} (${p.id}) -> ${p.serveUrl}`).join("\n")}`
        ),
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const result = await api.get("/wallpaper/projects", exec.signal);
      const projects = (result?.projects ?? []).map((p) => ({
        id: String(p.id ?? ""),
        name: String(p.name ?? ""),
        serveUrl: String(p.serveUrl ?? ""),
      }));
      return { projects };
    },
  });

  // ---- ai00_set_wallpaper：应用壁纸 ----
  ctx.tools.register({
    name: "ai00_set_wallpaper",
    description:
      "Apply a wallpaper project (HTML) to the desktop underlay via the Ai00-X host. projectPath is the absolute path of the wallpaper project directory.",
    parameters: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Absolute path to the wallpaper project directory.",
        },
        mode: {
          type: "string",
          enum: ["single", "per-monitor"],
          description: 'Background mode. Defaults to the current config.',
        },
        monitorId: { type: "integer", description: "Monitor id (per-monitor mode only)." },
      },
      required: ["projectPath"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) => text(value.ok ? "wallpaper applied" : "wallpaper apply failed"),
    },
    async execute(args, exec) {
      const projectPath = String(args?.projectPath ?? "").trim();
      if (!projectPath) throw new Error("projectPath is required");
      await api.post(
        "/wallpaper/apply",
        {
          projectPath,
          ...(args?.mode ? { mode: String(args.mode) } : {}),
          ...(args?.monitorId !== undefined ? { monitorId: Number(args.monitorId) } : {}),
        },
        exec.signal
      );
      return { ok: true };
    },
  });

  // ---- ai00_todo_read：读知行数据 ----
  ctx.tools.register({
    name: "ai00_todo_read",
    description:
      "Read the full Ai00-X Zhixing (知行) todo dataset: tasks, goals, lists, focus sessions, rewards. Use this before ai00_todo_write or ai00_task_complete.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => {
        const json = JSON.stringify(value, null, 2);
        // 截断防爆炸：超大时提示分块（当前数据量级远低于此）
        const clipped = json.length > 60_000 ? json.slice(0, 60_000) + "\n…(truncated)" : json;
        return text(clipped);
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return api.get("/todo", exec.signal);
    },
  });

  // ---- ai00_todo_write：全量写知行数据 ----
  ctx.tools.register({
    name: "ai00_todo_write",
    description:
      "Replace the full Zhixing todo dataset (destructive). ALWAYS ai00_todo_read first, modify the returned object, then write it back whole. Never invent missing fields.",
    parameters: {
      type: "object",
      properties: {
        data: {
          type: "object",
          description:
            "The complete TodoData object (version/lists/goals/tasks/focusSessions/rewards/...), as read by ai00_todo_read with your modifications.",
        },
      },
      required: ["data"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) => text(value.ok ? "todo data saved" : "todo write failed"),
    },
    async execute(args, exec) {
      if (!args?.data || typeof args.data !== "object") {
        throw new Error("data (full TodoData object) is required");
      }
      await api.put("/todo", args.data, exec.signal);
      return { ok: true };
    },
  });

  // ---- ai00_task_verify：子任务证据门（本地执行的确定性验证）----
  ctx.tools.register({
    name: "ai00_task_verify",
    description:
      "Run a plan step's acceptance commands and return a compact evidence package (verdict + command outputs + changed files, diff only when needed). Use after EVERY local_code_worker run to check the real result instead of trusting the worker's self-report. verdict: passed = all objective checks passed; failed = a command failed; needs-review = manual/ambiguous/truncated evidence. When the global '## 验收' section has no executable `{cmd:}` checks, integration verify re-runs every step's acceptance command as regression (up to 8) and reports `regression` — plain-text acceptance items are left to the human reviewer and no longer downgrade the verdict by themselves. reviewRequired = true means the orchestrator must have it reviewed (strict mode, high risk, or insufficient evidence). Passing verdict + `tick: true` also ticks that step in the same call (one round trip instead of verify + plan_check). Integration verify (no stepId) also checks that every file promised in the plan's '## Deliverables' exists and returns failed when one is missing — a worker writing `report.part1.md` instead of `report.md` can no longer pass. A stepId verify also reports `scopeMissing` (step Scope files that do not exist) and `scopeEmpty` (step Scope files that exist but are 0 bytes) and downgrades to needs-review. Also returns planPending (unticked step ids + acceptance lines) so you can tick acceptance lines with ai00_plan_check without a separate ai00_plan_read. Passing commands does NOT replace high-risk review or human acceptance.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Task id from the task brief. Optional: derived from the session working directory when omitted (workbench task folders are named by task id).",
        },
        snapshotDir: {
          type: "string",
          description: "Working directory of this task (used to run commands and collect git evidence).",
        },
        stepId: {
          type: "string",
          description: "Plan step id such as T1. Omit to verify the global '## 验收' section (integration review).",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional path filter for the diff. Narrows review scope only — it is not a sandbox.",
        },
        includeDiff: {
          type: "boolean",
          description: "Include a truncated diff. Pass true for strict mode, high-risk steps and cloud fallback.",
        },
        tick: {
          type: "boolean",
          description:
            "When the verdict is passed and stepId is given, also tick that step's checkbox in the same call (saves one ai00_plan_check round trip). Ignored for failed/needs-review.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          stepId: { type: "string" },
          verdict: { type: "string" },
          ticked: { type: "boolean" },
          reviewRequired: { type: "boolean" },
          risk: { type: "string" },
          reviewMode: { type: "string" },
          commands: {
            type: "array",
            items: {
              type: "object",
              properties: {
                cmd: { type: "string" },
                ok: { type: "boolean" },
                output: { type: "string" },
              },
              required: ["cmd", "ok"],
            },
          },
          manualItems: { type: "array", items: { type: "string" } },
          regression: {
            type: "array",
            items: {
              type: "object",
              properties: {
                step: { type: "string" },
                cmd: { type: "string" },
                ok: { type: "boolean" },
              },
              required: ["step", "cmd", "ok"],
            },
            description:
              "Integration verify only: step acceptance commands re-run as regression when the global '## 验收' section has no executable checks. A failing regression downgrades the verdict to needs-review.",
          },
          unrunnable: {
            type: "array",
            items: { type: "string" },
            description:
              "Acceptance items written with {cmd: …} whose command could not run (longer than 500 chars, backticks, or not whitelisted). They were NOT executed — the plan needs a shorter command or a checker script.",
          },
          changedFiles: { type: "array", items: { type: "string" } },
          scopeMissing: {
            type: "array",
            items: { type: "string" },
            description:
              "Files listed in this step's Scope that do not exist after the run (downgrades the verdict to needs-review).",
          },
          scopeEmpty: {
            type: "array",
            items: { type: "string" },
            description:
              "Files listed in this step's Scope that exist but are 0 bytes (the write landed empty; downgrades the verdict to needs-review).",
          },
          deliverables: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                exists: { type: "boolean" },
                empty: { type: "boolean" },
              },
              required: ["name", "exists"],
            },
            description:
              "Promised files from the plan's '## Deliverables' and whether each exists in snapshotDir (integration verify fails when one is missing or 0 bytes).",
          },
          extras: {
            type: "array",
            items: { type: "string" },
            description:
              "Integration verify only: files in the working directory that no step Scope and no Deliverable mentions (worker scratch files). Informational — list them to the user or ask for cleanup.",
          },
          reviewNotes: {
            type: "array",
            items: { type: "string" },
            description:
              "Integration verify only: review records in the working directory (review*.md). Expected when a review_worker ran — keep them, do not treat them as scratch.",
          },
          corrupt: {
            type: "array",
            items: { type: "string" },
            description:
              "Integration verify only: text deliverables containing U+FFFD replacement characters (encoding damage). Fails the verdict — rewrite those files clean.",
          },
          planPending: {
            type: "object",
            properties: {
              steps: {
                type: "array",
                items: { type: "string" },
                description: "Step ids still unticked (empty = all steps ticked).",
              },
              acceptance: {
                type: "array",
                items: { type: "string" },
                description: "Unticked '## 验收' lines (capped).",
              },
            },
            required: ["steps", "acceptance"],
            additionalProperties: false,
            description:
              "Remaining work read from the plan, so you can tick with ai00_plan_check instead of calling ai00_plan_read.",
          },
          diff: { type: "string" },
          diffTruncated: { type: "boolean" },
        },
        required: ["taskId", "verdict", "reviewRequired", "commands", "manualItems", "changedFiles"],
      },
      render: (_args, value) => {
        const lines = [
          `verdict: ${value.verdict} (${value.stepId || "integration"}; risk=${value.risk || "-"}; review=${value.reviewMode || "-"}; reviewRequired=${value.reviewRequired})${value.ticked ? " [step ticked]" : ""}`,
        ];
        for (const c of value.commands ?? []) {
          lines.push(`${c.ok ? "✓" : "✗"} ${c.cmd}${c.ok ? "" : `\n  ${(c.output || "").slice(0, 1200)}`}`);
        }
        if ((value.manualItems ?? []).length) {
          lines.push(`manual: ${value.manualItems.join(" | ")}`);
        }
        if ((value.regression ?? []).length) {
          const bad = value.regression.filter((r) => !r.ok).length;
          lines.push(
            `step command regression: ${value.regression.length - bad}/${value.regression.length} passed${bad ? " — re-check those steps before submitting the self-check" : ""}`
          );
        }
        if ((value.unrunnable ?? []).length) {
          lines.push(
            [
              "acceptance commands that cannot run (NOT executed) — each line names the exact rule that blocked it:",
              ...value.unrunnable.map((t) => `  - ${String(t).slice(0, 200)}`),
              "  → fix the plan (`{cmd: …}` must end the line with `}`, ≤500 ASCII chars, no backticks/$(), whitelisted first token), or move the logic into a checker script listed in Scope and call it (e.g. `node check.mjs`); then re-run verify",
            ].join("\n")
          );
        }
        if ((value.changedFiles ?? []).length) {
          lines.push(`changed: ${value.changedFiles.slice(0, 40).join(", ")}`);
        }
        if ((value.scopeMissing ?? []).length) {
          lines.push(`scope missing: ${value.scopeMissing.join(", ")} — check the worker's file names`);
        }
        if ((value.scopeEmpty ?? []).length) {
          lines.push(
            `scope files empty (0 bytes): ${value.scopeEmpty.join(", ")} — the write landed empty; rewrite before integration`
          );
        }
        if ((value.extras ?? []).length) {
          lines.push(
            `files outside plan scope: ${value.extras.join(", ")} — worker scratch; mention them to the user (delete or add to the plan)`
          );
        }
        if ((value.reviewNotes ?? []).length) {
          lines.push(
            `review record: ${value.reviewNotes.join(", ")} — expected output of review_worker; keep it (list it under Deliverables if the user should see it)`
          );
        }
        if ((value.deliverables ?? []).length) {
          lines.push(
            `deliverables: ${value.deliverables
              .map((d) => `${d.name}${d.exists ? " ✓" : " ✗ MISSING"}`)
              .join(", ")}`
          );
        }
        if ((value.corrupt ?? []).length) {
          lines.push(
            `corrupted text (U+FFFD): ${value.corrupt.join(", ")} — rewrite these files clean; do not tick`
          );
        }
        if (value.planPending) {
          const pendingSteps = value.planPending.steps ?? [];
          const pendingAcceptance = value.planPending.acceptance ?? [];
          lines.push(
            pendingSteps.length
              ? `pending steps: ${pendingSteps.join(", ")}`
              : "pending steps: none (all ticked)"
          );
          if (pendingAcceptance.length) {
            lines.push(`pending acceptance: ${pendingAcceptance.join(" | ")}`);
          }
          lines.push(
            "tick with ai00_plan_check: one call per step (match = step id), but pass several acceptance fragments as {matches: [...]} in a SINGLE call — do not re-read the plan just to update it"
          );
        }
        if (value.diff) lines.push(`diff${value.diffTruncated ? " (truncated)" : ""}:\n${value.diff}`);
        return text(lines.join("\n"));
      },
    },
    async execute(args, exec) {
      const taskId = await resolveTaskId(args, exec);
      if (!taskId) throw new Error("taskId is required");
      const stepId = String(args?.stepId ?? "").trim();
      const cwd = resolveVerifyCwd(taskId, args?.snapshotDir);
      const pathFilter = Array.isArray(args?.paths)
        ? args.paths.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [];

      const plan = await api
        .get(`/plan?taskId=${encodeURIComponent(taskId)}`, exec.signal)
        .catch(() => null);
      const markdown = typeof plan?.markdown === "string" ? plan.markdown : "";
      const policy = parseExecutionPolicy(markdown);
      const steps = parsePlanSteps(markdown);
      const step = stepId ? steps.find((s) => s.id === stepId) : null;
      if (stepId && !step) {
        throw new Error(`plan step not found: ${stepId}`);
      }

      // 验收来源：指定步骤 → 该步骤验收；否则全局「## 验收」**全部条目**。
      // 集成验收曾经只取未勾选项——模型按流程先勾选再验，这时条目为空，
      // 结论恒为 needs-review（实测每条任务都这样），等于把信号作废。
      const acceptance = step
        ? step.acceptance
        : parseAcceptance(markdown).items.map((item) => ({
            text: item,
            cmd: extractCmd(item),
          }));
      const risk = step?.risk ?? "medium";
      const reviewRequired =
        policy.review === "strict" || risk === "high" || acceptance.length === 0;

      const commands = [];
      const manualItems = [];
      // 写了 `{cmd:}` 却跑不起来的条目（超长/含反引号/非白名单）：单独点名，
      // 否则它们混在 manual 里，看起来像「人工判据」而不是计划缺陷。
      const unrunnable = [];
      let failed = false;
      for (const item of acceptance) {
        const cmd = item.cmd;
        if (!cmd) {
          if (/\{cmd:/.test(item.text)) {
            unrunnable.push(`${explainUnparsedCmd(item.text)} :: ${item.text.trim().slice(0, 120)}`);
          } else manualItems.push(item.text);
          continue;
        }
        // test -f/-d/-e 与 [ -f … ] 走内置 fs 判定（不在命令白名单里，但语义确定）
        const builtin = builtinFileCheck(cmd, cwd);
        if (builtin) {
          commands.push({ cmd, ok: builtin.ok, output: builtin.output });
          if (!builtin.ok) failed = true;
          continue;
        }
        if (!isCmdAllowed(cmd)) {
          unrunnable.push(`${explainNotWhitelisted(cmd)} :: ${item.text.trim().slice(0, 120)}`);
          continue;
        }
        if (!cwd) {
          // 没有工作目录就不执行：宁可标不可执行，也不在引擎进程目录里「验」出假证据。
          unrunnable.push(
            `missing working directory (pass snapshotDir) :: ${item.text.trim().slice(0, 120)}`,
          );
          continue;
        }
        const verdict = await runVerification(cmd, cwd, exec.signal);
        commands.push({ cmd, ok: verdict.ok, output: verdict.output });
        if (!verdict.ok) failed = true;
      }
      if (unrunnable.length) {
        ctx.logger.warn(`ai00-x-tools: acceptance commands not runnable: ${unrunnable.length}`);
      }

      // 集成验收的「## 验收」常常全是纯文字判据（无 `{cmd:}`）：只看它永远凑不出
      // 机器证据，结论恒为 needs-review，人被迫逐条自查。这里重跑各步骤已写下的
      // 验收命令做回归——它们才是这条任务真正的硬证据。回归失败只降 needs-review
      // （命令未必要幂等，失败不等于交付坏）。
      const regression = [];
      if (!stepId && commands.length === 0) {
        const seen = new Set();
        for (const s of steps) {
          for (const item of s.acceptance ?? []) {
            const cmd = item.cmd;
            if (!cmd || seen.has(cmd)) continue;
            seen.add(cmd);
            const builtin = builtinFileCheck(cmd, cwd);
            if (builtin) {
              regression.push({ step: s.id, cmd, ok: builtin.ok, output: builtin.output });
            } else if (isCmdAllowed(cmd)) {
              const r = await runVerification(cmd, cwd || undefined, exec.signal);
              regression.push({ step: s.id, cmd, ok: r.ok, output: r.output });
            } else {
              continue;
            }
            if (regression.length >= 8) break;
          }
          if (regression.length >= 8) break;
        }
        for (const r of regression) {
          commands.push({ cmd: `[${r.step}] ${r.cmd}`, ok: r.ok, output: r.output });
        }
        if (regression.some((r) => !r.ok)) {
          ctx.logger.warn("ai00-x-tools: step command regression failed at integration verify");
        }
      }
      const regressionFailed = regression.filter((r) => !r.ok).length;

      const includeDiff =
        args?.includeDiff === true || reviewRequired || failed || policy.review === "strict";
      const evidence = await collectGitEvidence(cwd, pathFilter, includeDiff);

      // 交付物文件名对账（2026-11-21 实测：worker 把 `report.md` 写成
      // `report.part1.md`，验收命令只测长度/标题就"通过"，人类打开的是错文件名）。
      // 只在整体验收（无 stepId）强制缺件判失败：子步骤未必产出全部交付物。
      const deliverables = [];
      for (const name of cwd ? parseDeliverables(markdown) : []) {
        const info = await stat(join(cwd, name)).catch(() => null);
        deliverables.push({ name, exists: Boolean(info), empty: Boolean(info && info.size === 0) });
      }
      const missingDeliverables = stepId
        ? []
        : deliverables.filter((d) => d.exists === false).map((d) => d.name);
      // 0 字节交付物等于没交付（本地 3B 长文写入反复留空文件，2026-11-21 实测）：
      // 存在但为空同样判 failed，提示比「验收命令失败」更直接。
      const emptyDeliverables = stepId
        ? []
        : deliverables.filter((d) => d.empty).map((d) => d.name);
      if (missingDeliverables.length) {
        ctx.logger.warn(
          `ai00-x-tools: deliverables missing at integration verify: ${missingDeliverables.join(", ")}`
        );
      }
      if (emptyDeliverables.length) {
        ctx.logger.warn(
          `ai00-x-tools: deliverables empty (0 bytes) at integration verify: ${emptyDeliverables.join(", ")}`
        );
      }
      // 编码污染：文件里有 U+FFFD 替换符（模型输出带进来再被 worker 照抄）。
      // 与「缺件」同级判 failed——人打开看到的是乱码，等于没交付。
      const corrupt = stepId
        ? []
        : await corruptDeliverables(
            cwd,
            deliverables.filter((d) => d.exists).map((d) => d.name)
          );
      if (corrupt.length) {
        ctx.logger.warn(`ai00-x-tools: deliverables with U+FFFD: ${corrupt.join(", ")}`);
      }

      // 步骤 Scope 对账：worker 常把 `report.md` 写成 `report.part1.md`
      // （2026-11-21 实测），验收命令只测 report.md 的长度时错误要到整体验收才
      // 暴露。这里在步内就对账「Scope 里承诺的文件是否存在」，缺失按
      // needs-review 上报（Scope 也可能列只读引用的既有文件，不能判 failed）。
      const scopeMissing = [];
      const scopeEmpty = [];
      if (step && cwd) {
        for (const raw of step.paths ?? []) {
          const name = String(raw).replace(/`/g, "").trim().replace(/^\.\//, "");
          if (!name || name === "." || /[*?]/.test(name)) continue;
          if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) continue; // 目录/通配路径跳过
          const info = await stat(join(cwd, name)).catch(() => null);
          if (!info) {
            scopeMissing.push(name);
            continue;
          }
          // Scope 里的文件被写空（本地 3B 长文写入的典型后果）：步内先降 needs-review，
          // 别等到集成验收才发现。
          if (info.isFile() && info.size === 0) scopeEmpty.push(name);
        }
      }
      if (scopeMissing.length) {
        ctx.logger.warn(
          `ai00-x-tools: step scope files missing: ${scopeMissing.join(", ")}`
        );
      }
      if (scopeEmpty.length) {
        ctx.logger.warn(`ai00-x-tools: step scope files empty (0 bytes): ${scopeEmpty.join(", ")}`);
      }

      // 集成验收时顺手对一眼工作目录：计划（各步 Scope + Deliverables）没提到的文件
      // 多是 worker 留下的草稿（实测 note.txt / 第二份 review.md），会让交付目录变脏。
      // 只作为提示回传，不改判据（Scope 外新增本身不违反「Scope 内文件必须存在」）。
      const extras = [];
      // 复核记录是**契约允许**的产物（review_worker 只写一份 review*），
      // 不能混进「草稿」一起劝删——实测 7.12 的 review.md 就被当成 scratch。
      const reviewNotes = [];
      if (!stepId && cwd) {
        const known = new Set([
          "AGENTS.local.md",
          ...deliverables.map((d) => d.name),
          ...steps.flatMap((s) =>
            (s.paths ?? []).map((p) =>
              String(p).replace(/`/g, "").trim().replace(/^\.\//, "")
            )
          ),
        ]);
        const entries = await readdir(cwd).catch(() => []);
        for (const entry of entries) {
          if (entry.startsWith(".") || known.has(entry)) continue;
          const isFile = await stat(join(cwd, entry))
            .then((s) => s.isFile())
            .catch(() => false);
          if (!isFile) continue;
          if (/^review\b.*\.md$/i.test(entry)) reviewNotes.push(entry);
          else extras.push(entry);
        }
        if (extras.length) {
          ctx.logger.warn(`ai00-x-tools: files outside plan scope: ${extras.join(", ")}`);
        }
      }

      // 证据不足必须交人工/云端评审，不能假装通过。
      // 注意不再把「工作目录不是 git 仓库」算作证据不足：很多任务目录本就没有 git，
      // 而验收命令全过本身就是硬证据（实测非 git 目录里每步都掉进 needs-review，
      // 人得逐条点）。高风险/严格模式仍由 reviewRequired 覆盖。
      const insufficient =
        acceptance.length === 0 ||
        (commands.length === 0 && manualItems.length > 0) ||
        (includeDiff && evidence.diffTruncated && evidence.changedFiles.length > 50);
      // 纯文字验收项不再单独把结论压成 needs-review：它们本来就是**人**在验收卡上
      // 判定的事项（人点「验收通过」时逐条看）。needs-review 保留给真正的证据缺口
      // （无任何可执行证据、命令跑不起来、Scope 缺件、回归失败）。
      const verdict = failed || missingDeliverables.length || emptyDeliverables.length || corrupt.length
        ? "failed"
        : regressionFailed > 0 ||
            insufficient ||
            scopeMissing.length > 0 ||
            scopeEmpty.length > 0 ||
            unrunnable.length > 0
          ? "needs-review"
          : "passed";

      // 集成验收摘要写进计划：这是**人**在验收卡上能看到的唯一证据面
      // （工具返回只有模型看得到）。清理类列表为空时不占行。
      if (!stepId && markdown) {
        const summary = [
          `结论: ${verdict} · ${localStamp()}`,
          `交付物: ${
            deliverables.length
              ? deliverables
                  .map((d) => `${d.name}${d.empty ? " ✗ 空文件" : d.exists ? " ✓" : " ✗ 缺失"}`)
                  .join("、")
              : "（计划未声明）"
          }`,
          ...(regression.length
            ? [`步骤命令回归: ${regression.length - regressionFailed}/${regression.length} 通过`]
            : []),
          ...(manualItems.length ? [`人工验收项: ${manualItems.length} 条（由你判定）`] : []),
          ...(extras.length ? [`计划外文件: ${extras.join("、")}`] : []),
          ...(reviewNotes.length ? [`复核记录: ${reviewNotes.join("、")}`] : []),
          ...(corrupt.length ? [`编码损坏: ${corrupt.join("、")}`] : []),
          ...(unrunnable.length ? [`不可执行命令: ${unrunnable.length} 条`] : []),
        ];
        const withRecord = upsertVerifyRecord(markdown, summary);
        if (withRecord !== markdown) {
          await api
            .put("/plan", { taskId, markdown: withRecord }, exec.signal)
            .catch((error) =>
              ctx.logger.warn(`ai00-x-tools: verify record write skipped: ${error.message}`)
            );
        }
      }

      // 把验证结果写回计划（展示层读「验证/证据」两行）；失败不阻断验证结论。
      // 可选同调用勾选（args.tick）：每步编排者原本要多一次 ai00_plan_check，
      // 勾选规则与 plan_check 一致（只认 passed），只是省掉一次往返。
      let currentMd = markdown;
      let ticked = false;
      if (stepId && markdown) {
        try {
          currentMd = upsertStepEvidence(
            markdown,
            stepId,
            verdict,
            summarizeEvidence(commands, evidence.changedFiles)
          );
        } catch (error) {
          ctx.logger.warn(`ai00-x-tools: step evidence write-back skipped: ${error.message}`);
        }
        if (args?.tick === true && verdict === "passed") {
          const tickedMd = tickStepLine(currentMd, stepId);
          if (tickedMd) {
            currentMd = tickedMd;
            ticked = true;
          }
        }
        if (currentMd !== markdown) {
          try {
            await api.put("/plan", { taskId, markdown: currentMd }, exec.signal);
          } catch (error) {
            ctx.logger.warn(`ai00-x-tools: plan write-back failed: ${error.message}`);
            ticked = false;
          }
        }
      }

      return {
        taskId,
        ...(stepId ? { stepId } : {}),
        verdict,
        reviewRequired: reviewRequired || insufficient,
        risk,
        reviewMode: policy.review,
        commands,
        manualItems,
        ...(regression.length ? { regression } : {}),
        changedFiles: evidence.changedFiles,
        deliverables,
        ...(scopeMissing.length ? { scopeMissing } : {}),
        ...(scopeEmpty.length ? { scopeEmpty } : {}),
        ...(extras.length ? { extras } : {}),
        ...(reviewNotes.length ? { reviewNotes } : {}),
        ...(corrupt.length ? { corrupt } : {}),
        ...(unrunnable.length ? { unrunnable } : {}),
        ...(ticked ? { ticked: true } : {}),
        // 计划剩余项随证据一起回传：编排者据此用 ai00_plan_check 精确勾选，
        // 不必再为了看状态调一次 ai00_plan_read（实测一次读回 ~7k 输入）。
        planPending: {
          steps: steps.filter((s) => !s.done).map((s) => s.id).slice(0, 12),
          acceptance: parseAcceptance(markdown).unchecked.slice(0, 6),
        },
        ...(evidence.diff ? { diff: evidence.diff } : {}),
        ...(evidence.diffTruncated ? { diffTruncated: true } : {}),
      };
    },
  });

  // ---- ai00_task_complete：提交模型自检（双段验收第一段）----
  ctx.tools.register({
    name: "ai00_task_complete",
    description:
      "Submit a Zhixing task's SELF-CHECK for HUMAN acceptance by id (dual-stage acceptance — this does NOT complete the task; the human reviews and accepts in the Zhixing board). The call is REJECTED when `deliverables` is empty or any listed path does not exist on disk (relative paths resolve against snapshotDir). Self-check gate: if the task's plan document has an '## 验收' (acceptance) section, the call FAILS unless every criterion passes — plain criteria must be checked off in the plan document first (ai00_plan_read then ai00_plan_write with '- [x]'); criteria annotated with {cmd: <shell command>} are executed automatically (in snapshotDir, 120s timeout) and must exit 0 — fix the issue from the command output and retry. On success, if snapshotDir is provided (the working directory from your task brief), a git snapshot of all changes is taken automatically — do NOT commit manually. MUST pass `deliverables`: the absolute paths of every artifact file you produced for this task (report/summary/output files — at least one; write them as real files in the working directory BEFORE calling, e.g. report.md). After submitting, REPORT to the user in the conversation: a short result summary (≤200 words) + the deliverables list (filename + one-line description). XP and completion are granted by the human, not by this tool. For local-first plans the call is also REJECTED while the plan has not been approved by the human (and again whenever an edit to the goal / step list / acceptance wording reset that approval) — end the turn and wait for the approval message.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Task id from the task brief or ai00_todo_read. Optional: derived from the session working directory when omitted.",
        },
        snapshotDir: {
          type: "string",
          description:
            "Working directory from the task brief (if any). A git snapshot of your changes is committed on submission.",
        },
        deliverables: {
          type: "array",
          items: { type: "string" },
          description:
            "REQUIRED: absolute paths of artifact files produced by this task (report/summary/output…). At least one — a summary/report file must exist even for research-only tasks. Register here so the human sees links in the Zhixing board.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          title: { type: "string" },
          xp: { type: "integer" },
          deliverables: {
            type: "array",
            items: { type: "string" },
            description: "Registered deliverable file paths.",
          },
          verifiedByCmd: {
            type: "array",
            items: { type: "string" },
            description: "Verification commands actually executed and passed (whitelist-gated).",
          },
          already: {
            type: "boolean",
            description:
              "True when this task was already submitted for human acceptance earlier (idempotent call; no second timestamp).",
          },
          addedDeliverables: {
            type: "array",
            items: { type: "string" },
            description:
              "Only on an idempotent call: newly registered deliverable paths merged into the existing list.",
          },
        },
        required: ["ok", "title", "xp"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        value.already
          ? text(
              `self-check was already submitted earlier: ${value.title} (${(value.deliverables ?? []).length} deliverables registered${(value.addedDeliverables ?? []).length ? `, ${value.addedDeliverables.length} added now` : ""}; still awaiting human review in the Zhixing board)`
            )
          : text(`self-check submitted for human acceptance: ${value.title} (${(value.deliverables ?? []).length} deliverables registered; awaiting user review in the Zhixing board)`),
    },
    async execute(args, exec) {
      const taskId = await resolveTaskId(args, exec);
      if (!taskId) throw new Error("taskId is required");
      const snapshotDir = String(args?.snapshotDir ?? "").trim();
      // 验收命令必须有工作目录：缺省用任务卡默认目录，绝不落到引擎进程目录里跑。
      const verifyCwd = resolveVerifyCwd(taskId, snapshotDir);
      const deliverables = Array.isArray(args?.deliverables)
        ? args.deliverables.map((d) => String(d ?? "").trim()).filter(Boolean)
        : [];

      // 交付物必须真实落盘：此前只登记路径不校验，实测出现「步骤与验收全勾、
      // 但 report.md / blueprint 从未生成」仍提交自检（本地与云端两条链路都发生过）。
      if (deliverables.length === 0) {
        throw new Error(
          "deliverables 为空：先把交付物写成真实文件（至少一个；纯调研也必须有摘要文件），再提交自检。"
        );
      }
      const resolveDeliverable = (p) =>
        isAbsolute(p) || !verifyCwd ? p : resolve(verifyCwd, p);
      const missing = [];
      const emptyFiles = [];
      for (const raw of deliverables) {
        const target = resolveDeliverable(raw);
        const info = await stat(target).catch(() => null);
        if (!info || !(info.isFile() || info.isDirectory())) {
          missing.push(raw);
          continue;
        }
        // 0 字节文件等于没产出：本地 3B 长文写入反复留空文件（2026-11-21 实测），
        // 只判「存在」会让空文件一路走到人工验收。
        if (info.isFile() && info.size === 0) emptyFiles.push(raw);
      }
      if (missing.length > 0) {
        throw new Error(
          [
            `以下交付物不存在（共 ${missing.length} 个），不能提交自检：`,
            ...missing.slice(0, 8).map((p) => `  - ${p}`),
            "请先把它们写进工作目录（或修正路径）后重试；不要把未产出的步骤与验收项勾成已完成。",
          ].join("\n")
        );
      }
      if (emptyFiles.length > 0) {
        throw new Error(
          [
            `以下交付物是空文件（0 字节，共 ${emptyFiles.length} 个），不能提交自检：`,
            ...emptyFiles.slice(0, 8).map((p) => `  - ${p}`),
            "请把内容真正写进这些文件（长文可分块写再合并）后重新提交自检。",
          ].join("\n")
        );
      }

      // DoD 对等校验（与策窗口人侧「标记完成」同口径）：验收未全勾 → 报错驱动自纠。
      // evals 进环（M2.3）：带 {cmd: ...} 标记的条目由插件实际执行命令判定——
      // 命令通过视同通过（无需人工勾选），失败则把输出回灌给 agent 自纠。
      const plan = await api
        .get(`/plan?taskId=${encodeURIComponent(taskId)}`, exec.signal)
        .catch(() => null);
      // local-first 计划的额外门禁：步骤未逐项通过（含证据门）不得提交自检。
      // 旧计划（无「## 执行策略」段）保持原判定，策任务行为不变。
      const policy = parseExecutionPolicy(plan?.markdown);
      if (policy.execution === "local-first") {
        // 批准门兜底：人没批准过这份计划，就不能走「提交自检 → 人验收」这条快车道。
        // 没有它，7.37 的「改 DoD 自动重新待批」会被一次 complete 直接绕过——
        // 改完判据、勾完验收、提交自检，人只看到「待验收」而没看到「计划未批准」。
        // 读不到任务时按未知处理（不拦，避免一次读失败把 agent 卡死）。
        let planApproved;
        try {
          const data = await api.get("/todo", exec.signal);
          const task = (Array.isArray(data?.tasks) ? data.tasks : []).find((t) => t.id === taskId);
          planApproved = Boolean(task?.planApprovedAt);
        } catch {
          planApproved = undefined;
        }
        if (planApproved === false) {
          throw new Error(
            [
              "这份计划还没有得到人的批准，不能提交自检。",
              "请结束这一轮等我批准：计划卡上出现「批准并执行」后，我点一下你就会收到放行消息。",
              "（批准之后如果你改了目标 / 步骤清单 / 验收措辞，批准会自动复位，需要我再批一次。）",
            ].join("\n")
          );
        }
        const unfinished = parsePlanSteps(plan?.markdown).filter((step) => !step.done);
        if (unfinished.length > 0) {
          throw new Error(
            [
              `仍有 ${unfinished.length} 个步骤未完成，不能提交自检：`,
              ...unfinished.slice(0, 8).map((step) => `  - ${step.id} ${step.title}`),
              "请先执行 ai00_task_verify（stepId 逐项）并确认通过，再用 ai00_plan_check（match: 步骤 id）勾选该步——不要整篇重写计划。",
            ].join("\n")
          );
        }
      }
      const acceptance = parseAcceptance(plan?.markdown);
      // 集成验收记录门禁：验收人唯一能看到的证据是计划里的「## 验证记录」
      // （ai00_task_verify 不带 stepId 写入，打回时会被清掉）。缺了它，卡片上只剩
      // 勾选态——人无法判断交付物齐不齐、有没有计划外文件/编码损坏/回归失败。
      // 只对 local-first 且确有步骤的计划生效（旧卡/空计划保持原行为）。
      if (policy.execution === "local-first" && parsePlanSteps(plan?.markdown).length > 0) {
        if (!/^##\s*(验证记录|Verify log)/im.test(String(plan?.markdown ?? ""))) {
          throw new Error(
            [
              "计划里没有集成验收记录，不能提交自检。",
              "请先调用 ai00_task_verify（不传 stepId）跑一次整体验收——它会把「结论 / 交付物 / 步骤命令回归 / 人工验收项」写进计划的「## 验证记录」段，验收人只认这一份证据。",
              "整体验收判 failed / needs-review 时先修交付物再重跑；纯文字验收项由人判定，不要为了过门而临时造命令。",
            ].join("\n")
          );
        }
      }
      // 计划「## 交付物」承诺的文件也必须真实落盘：deliverables 参数由模型自报，
      // 实测出现过承诺 report.md / blueprint 却从未生成仍提交自检。
      const promisedMissing = [];
      for (const raw of parseDeliverables(plan?.markdown)) {
        const exists = await stat(resolveDeliverable(raw))
          .then((s) => s.isFile() || s.isDirectory())
          .catch(() => false);
        if (!exists) promisedMissing.push(raw);
      }
      if (promisedMissing.length > 0) {
        throw new Error(
          [
            `计划承诺的交付物不存在（共 ${promisedMissing.length} 个），不能提交自检：`,
            ...promisedMissing.slice(0, 8).map((p) => `  - ${p}`),
            "先把它们写进工作目录再提交；写不出来就改计划（ai00_plan_write）把承诺降到真实范围，不要只勾验收。",
          ].join("\n")
        );
      }
      // 编码损坏门禁：文本交付物里有 U+FFFD = 人打开看到乱码，不算交付。
      // 去重：deliverables 参数与计划的「## Deliverables」常是同一批文件。
      const corruptText = await corruptDeliverables(
        verifyCwd,
        [...new Set([...deliverables, ...parseDeliverables(plan?.markdown)].map((p) => String(p).trim()))]
      );
      if (corruptText.length > 0) {
        throw new Error(
          [
            `以下交付物含 U+FFFD 替换符（编码损坏），不能提交自检：`,
            ...corruptText.slice(0, 8).map((p) => `  - ${p}`),
            "请派 worker 按原文重写这些文件（不要重新生成内容），再提交。",
          ].join("\n")
        );
      }
      const executedCmds = [];
      if (acceptance.total > 0) {
        const cmdFailures = [];
        let manualUnchecked = 0;
        let missingCwd = 0;
        for (const item of acceptance.unchecked) {
          const cmd = extractCmd(item);
          if (!cmd) {
            manualUnchecked += 1;
            continue;
          }
          const builtin = builtinFileCheck(cmd, verifyCwd || undefined);
          if (builtin) {
            executedCmds.push(cmd);
            if (!builtin.ok) cmdFailures.push({ item, cmd, output: builtin.output });
            continue;
          }
          if (!isCmdAllowed(cmd)) {
            // 非白名单命令不自动执行（防提示注入），回落人工判据口径
            ctx.logger.warn(`ai00-x-tools: verification cmd rejected by whitelist: ${cmd}`);
            manualUnchecked += 1;
            continue;
          }
          if (!verifyCwd) {
            ctx.logger.warn(`ai00-x-tools: verification cmd without working directory: ${cmd}`);
            missingCwd += 1;
            continue;
          }
          executedCmds.push(cmd);
          const verdict = await runVerification(cmd, verifyCwd, exec.signal);
          if (verdict.ok) continue;
          cmdFailures.push({ item, cmd, output: verdict.output });
        }
        if (manualUnchecked > 0 || missingCwd > 0 || cmdFailures.length > 0) {
          const lines = [
            `验收标准未通过（共 ${acceptance.total} 项，通过 ${acceptance.done} 项，验证命令失败 ${cmdFailures.length} 项，人工判据未勾 ${manualUnchecked} 项${missingCwd > 0 ? `，缺工作目录未执行 ${missingCwd} 项` : ''}）。`,
          ];
          if (missingCwd > 0) {
            lines.push(
              "有验收命令因为缺少工作目录而没有执行（不会在引擎进程目录里跑）：请带 snapshotDir 重新提交自检。",
            );
          }
          if (cmdFailures.length > 0) {
            lines.push(
              ...cmdFailures.flatMap((f) => [
                `✗ ${f.item}`,
                `  command: ${f.cmd}`,
                `  output: ${f.output || "(no output)"}`,
              ]),
            );
            lines.push("请根据命令输出修复问题后重试。");
          }
          if (manualUnchecked > 0) {
            const items = acceptance.unchecked
              .filter((s) => !extractCmd(s))
              .slice(0, 6)
              .map((s, i) => `  ${i + 1}. ${s}`)
              .join("\n");
            lines.push(
              "请先逐项自检，再用 ai00_plan_check（match: 该验收行的一段文字）把计划「## 验收」对应项勾成 \"- [x]\"——不要整篇重写计划。未通过项：",
              items,
            );
          }
          throw new Error(lines.join("\n"));
        }
      }

      const data = await api.get("/todo", exec.signal);
      // 登记一律用绝对路径：相对路径（如 "brief.md"）在面板上打不开，链接等于没有。
      // 有 snapshotDir 时按它解析；没有时保持原样（调用方本来就该给绝对路径）。
      const registered = deliverables.map((raw) => resolveDeliverable(raw));
      const { data: next, task, already, added = [] } = submitSelfCheckInData(
        data,
        taskId,
        registered
      );
      if (already) {
        // 补登记的交付物需要落盘（否则面板永远看不到产物链接）
        if (added.length) await api.put("/todo", next, exec.signal);
        return {
          ok: true,
          title: task.title ?? "",
          xp: 0,
          already: true,
          deliverables: Array.isArray(task.deliverables) ? task.deliverables : [],
          ...(added.length ? { addedDeliverables: added } : {}),
        };
      }

      // 自检快照（执行产物定格；commit 回写任务卡——验收 diff/回滚用；失败静默）
      let snapshotCommit = null;
      if (snapshotDir) {
        try {
          const snap = await api.post(
            "/git/snapshot",
            { dir: snapshotDir, message: `task: ${task.title} · agent 自检` },
            exec.signal
          );
          snapshotCommit = snap?.commit ?? null;
        } catch (error) {
          ctx.logger.warn(`ai00-x-tools: self-check snapshot skipped: ${error.message}`);
        }
      }
      if (snapshotCommit) {
        next.tasks = next.tasks.map(t =>
          t?.id === taskId ? { ...t, agentCommit: snapshotCommit } : t
        );
      }
      await api.put("/todo", next, exec.signal);

      // 双段验收到此为止：completedAt / XP / 周期克隆全部由人类在策窗口
      // 「验收通过」触发——agent 提交后只等人类，不自行宣告完成
      return {
        ok: true,
        title: task.title ?? "",
        xp: 0,
        // 回显登记的交付物（自检透明度）
        deliverables,
        // 回显实际执行过的验证命令（自检透明度；空 = 全部人工判据/无验收段）
        verifiedByCmd: executedCmds,
      };
    },
  });

  // ---- ai00_task_create：agent 自主建卡（想法池）----
  ctx.tools.register({
    name: "ai00_task_create",
    description:
      "Create a new idea card in the Zhixing board's idea pool (status: requirement) — you and the user are equal plan makers. Use when you discover a subtask, follow-up, or new idea worth tracking while executing. The card then goes through the full lifecycle (discuss → plan → execute → acceptance). Optionally attach it to a goal (goalId). Do NOT stuff subtasks into the current plan document — create cards instead.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short card title (max 120 chars).",
        },
        notes: {
          type: "string",
          description: "Optional context/notes for the card.",
        },
        goalId: {
          type: "string",
          description:
            "Optional goal id to attach the card to (must exist; use ai00_todo_read to list goals). Ignored if not found.",
        },
        due: {
          type: "string",
          description: "Optional due date 'YYYY-MM-DD'.",
        },
        sourceTaskId: {
          type: "string",
          description:
            "Optional id of the task you were executing when you found this — recorded in the card notes for traceability.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
        },
        required: ["taskId", "title"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(`idea card created: ${value.title} (${value.taskId}) — now in the idea pool`),
    },
    async execute(args, exec) {
      const title = String(args?.title ?? "").trim();
      if (!title) throw new Error("title is required");
      const result = await api.post(
        "/todo/task/create",
        {
          title,
          ...(args?.notes ? { notes: String(args.notes) } : {}),
          ...(args?.goalId ? { goalId: String(args.goalId) } : {}),
          ...(args?.due ? { due: String(args.due) } : {}),
          ...(args?.sourceTaskId ? { sourceTaskId: String(args.sourceTaskId) } : {}),
        },
        exec.signal
      );
      return {
        taskId: String(result.taskId ?? ""),
        title: String(result.title ?? title),
      };
    },
  });

  // ---- ai00_focus_log：专注会话记录 ----
  ctx.tools.register({
    name: "ai00_focus_log",
    description:
      "Append a focus (pomodoro) session to the Zhixing log. The host broadcasts an event and the web UI awards XP (1 XP per minute, cap 50). outcome: 'finished' or 'aborted'.",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "integer", description: "Focus duration in minutes." },
        outcome: {
          type: "string",
          enum: ["finished", "aborted"],
          description: "Defaults to 'finished'.",
        },
        taskId: { type: "string", description: "Optional associated task id." },
      },
      required: ["minutes"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          startedAt: { type: "integer" },
          minutes: { type: "integer" },
          outcome: { type: "string" },
        },
        required: ["minutes"],
        additionalProperties: false,
      },
      render: (_args, value) => text(`focus session logged: ${value.minutes} minutes (${value.outcome ?? "finished"})`),
    },
    async execute(args, exec) {
      const minutes = Number(args?.minutes ?? 0);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error("minutes must be a positive integer");
      }
      const session = await api.post(
        "/todo/focus",
        {
          minutes: Math.round(minutes),
          outcome: args?.outcome ? String(args.outcome) : "finished",
          ...(args?.taskId ? { taskId: String(args.taskId) } : {}),
        },
        exec.signal
      );
      // 清洗 null 字段（schema 不接受 null，非 required 直接省略）
      return {
        minutes: session.minutes ?? Math.round(minutes),
        startedAt: session.startedAt,
        outcome: session.outcome ?? "finished",
        ...(session.taskId ? { taskId: session.taskId } : {}),
      };
    },
  });
  // ---- ai00_plan_read：读卡片计划文档 ----
  ctx.tools.register({
    name: "ai00_plan_read",
    description:
      "Read the plan document (Markdown) of a Zhixing board card by taskId — the shared working surface between the user and you. Contains the agreed summary, numbered steps and deliverable. Read it before executing a delegated task, and before ai00_plan_write.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Task id (from the task brief or ai00_todo_read). Optional: derived from the session working directory when omitted.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          markdown: { type: "string" },
          found: { type: "boolean" },
        },
        required: ["taskId", "found"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(
          value.found
            ? `plan document:\n${value.markdown}`
            : "no plan document yet for this task"
        ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const taskId = await resolveTaskId(args, exec);
      if (!taskId) throw new Error("taskId is required");
      const result = await api.get(
        `/plan?taskId=${encodeURIComponent(taskId)}`,
        exec.signal
      );
      return {
        taskId: String(result.taskId ?? taskId),
        found: !!result.found,
        ...(result.markdown != null ? { markdown: String(result.markdown) } : {}),
      };
    },
  });

  // ---- ai00_plan_write：写卡片计划文档 ----
  ctx.tools.register({
    name: "ai00_plan_write",
    description:
      "Write (replace) the plan document (Markdown) of a Zhixing board card. The 策 window refreshes it live, so the user sees your updates. Prefer ai00_plan_check for status flips; use this only for structural edits. Verification/evidence lines already written by ai00_task_verify and the user's reject notes (`- 打回: …`) are preserved automatically, and a step cannot be newly ticked here without that evidence (the write is refused). The FIRST write of a task's plan is a hard stop: after it, end the turn and wait for the user to confirm the plan — never dispatch a worker in the same turn. Editing the goal, the step list or any acceptance wording AFTER approval resets the approval: the write succeeds, but you must end the turn and wait for the user to approve again (never loosen an acceptance item to make it pass — fix the deliverable instead).",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Task id. Optional: derived from the session working directory when omitted.",
        },
        markdown: {
          type: "string",
          description: "Complete updated Markdown document (full replacement, not a patch).",
        },
      },
      required: ["markdown"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          // 首次写入（此前没有计划）：宿主用它给模型发停机指令
          firstPlan: { type: "boolean" },
          // 旧计划里的「验证/证据」行被保留并补回（模型重写时容易漏）
          evidencePreserved: { type: "boolean" },
          // 批准后改了 DoD（目标 / 步骤清单 / 验收措辞）：批准已复位，必须重新等人批
          reapprovalRequired: { type: "boolean" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value.ok) return text("plan write failed");
        // 计划闸口是硬停：把指令贴在模型刚做完的动作旁边，而不是只写在 AGENTS.local.md
        // （2026-11-20 实测：模型忽略文件里的 "stop after writing the plan" 直接派子代理）
        return text(
          value.firstPlan
            ? "plan document saved (first version).\nSTOP NOW: end this turn and wait for the user to confirm the plan. Do not call ai00_plan_read, do not dispatch any worker, do not call ai00_task_complete in this turn. Reply with a 3–6 line plan summary."
            : value.reapprovalRequired
              ? "plan document updated, but it changes the approved contract (goal, step list or acceptance wording), so approval was reset.\nSTOP NOW: end this turn, summarize in 2–4 lines what changed and why, and wait for the user to approve the plan again. Do not dispatch any worker in this turn. Never make an acceptance item easier to pass just to clear it — fix the deliverable, or ask the user to change the criterion."
              : "plan document updated"
        );
      },
    },
    async execute(args, exec) {
      const taskId = await resolveTaskId(args, exec);
      const markdown = String(args?.markdown ?? "");
      if (!taskId || !markdown.trim()) throw new Error("taskId and markdown are required");
      // 先读旧计划判断是否「首次成文」：读失败按非首次处理，不阻断写盘
      let firstPlan = false;
      let prevMarkdown = "";
      try {
        const prev = await api.get(
          `/plan?taskId=${encodeURIComponent(taskId)}`,
          exec.signal
        );
        firstPlan = !prev?.found || !String(prev.markdown ?? "").trim();
        prevMarkdown = typeof prev?.markdown === "string" ? prev.markdown : "";
      } catch {
        firstPlan = false;
      }
      // 整篇重写不得抹掉 ai00_task_verify 写回的验证/证据行，也不得抹掉人的打回记录
      const merged = firstPlan
        ? markdown
        : carryOverRejectNotes(prevMarkdown, carryOverEvidence(prevMarkdown, markdown));
      // 也不得把「没验证过的步骤」勾上（与 plan_check 同一闸门）
      if (!firstPlan) {
        const offenders = newlyTickedWithoutEvidence(prevMarkdown, merged);
        if (offenders.length) {
          throw new Error(
            `refused: no verification evidence for ${offenders.join(", ")} — call ai00_task_verify (stepId) first, then tick with ai00_plan_check. Nothing was written.`
          );
        }
        // 只为翻状态而整篇重写 = 白花 2–3k 输出 token（实测一个任务里发生 3 次）
        if (isStatusOnlyRewrite(prevMarkdown, merged)) {
          throw new Error(
            "refused: this rewrite only flips checkboxes or evidence lines — use ai00_plan_check {taskId, match} instead (a few dozen tokens). Nothing was written."
          );
        }
      }
      // 「幽灵交付物」：Deliverables 承诺了 Steps 里根本没提的文件。
      // 这类承诺永远不成立 → 整体验收恒 failed，必须在写盘前拦。
      const ghosts = ghostDeliverables(merged);
      if (ghosts.length) {
        throw new Error(
          `refused: Deliverables lists ${ghosts.join(", ")} but no step mentions it — overall acceptance would always fail. Either add it to the producing step's Scope, or remove it from Deliverables. Nothing was written.`
        );
      }
      // 弱验收（只量长度/体积）：填充文本就能过，等于没验。只拦**本次新引入**的
      // 条目——旧计划里的历史弱判据仍可编辑（否则改造中任务会被自己的旧计划锁死）。
      const prevWeak = new Set(
        weakAcceptance(prevMarkdown).map((w) => w.text.replace(/\s+/g, " "))
      );
      const weak = weakAcceptance(merged).filter(
        (w) => !prevWeak.has(w.text.replace(/\s+/g, " "))
      );
      if (weak.length) {
        throw new Error(
          [
            `refused: ${weak.length} acceptance check(s) only measure length/size or long character runs — filler text would pass and real defects (missing section, wrong file name, mojibake) would slip through:`,
            ...weak.slice(0, 4).map((w) => `  - ${w.cmd}`),
            'Rewrite each with a content assertion (required heading/table/citation), e.g. node -e "const s=require(\'fs\').readFileSync(\'report.md\',\'utf8\');if(!s.includes(\'## 结论\'))process.exit(1)". Nothing was written.',
          ].join("\n")
        );
      }
      // 写了 `{cmd:}` 但过不了护栏（>500 字符 / 含反引号 / 含 `$(`）：这类命令
      // 会被静默降级成「人工判据」，步骤永远停在 needs-review。
      const prevUnrunnable = new Set(
        unrunnableCmds(prevMarkdown).map((c) => c.text.replace(/\s+/g, " "))
      );
      const unrunnable = unrunnableCmds(merged).filter(
        (c) => !prevUnrunnable.has(c.text.replace(/\s+/g, " "))
      );
      if (unrunnable.length) {
        throw new Error(
          [
            `refused: ${unrunnable.length} acceptance command(s) will never run — each line names the exact rule that blocked it (otherwise it silently degrades to a manual check and the step can never pass verification):`,
            ...unrunnable
              .slice(0, 4)
              .map((c) => `  - ${explainUnparsedCmd(c.text)} :: ${c.text.slice(0, 100)}`),
            "Keep the command under 500 ASCII chars: assert one or two key facts (heading present, table rows, key phrase), or put the logic in a short checker script listed in Scope and call it (e.g. `node check.mjs`). Nothing was written.",
          ].join("\n")
        );
      }
      await api.put("/plan", { taskId, markdown: merged }, exec.signal);
      // 批准之后改 DoD = 人当初批准的那份契约变了：批准必须复位（与人在卡片上改计划同一口径），
      // 否则 agent 可以靠「把验收判据改松」来过验收，而不是把交付物改对。
      let reapprovalRequired = false;
      if (!firstPlan && dodSignature(prevMarkdown) !== dodSignature(merged)) {
        try {
          const data = await api.get("/todo", exec.signal);
          const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
          const task = tasks.find((t) => t.id === taskId);
          if (task?.planApprovedAt) {
            await api.put(
              "/todo",
              {
                ...data,
                tasks: tasks.map((t) => (t.id === taskId ? { ...t, planApprovedAt: null } : t)),
              },
              exec.signal
            );
            reapprovalRequired = true;
          }
        } catch {
          // 任务读不到 / 写不进：不阻断计划落盘，卡片上仍能看到新计划
        }
      }
      return { ok: true, firstPlan, evidencePreserved: merged !== markdown, reapprovalRequired };
    },
  });

  // ---- ai00_plan_check：只勾选/取消勾选计划里的一行（免整篇重写）----
  // 计划文档动辄 2–3k 字，整篇重写一次就是 2–3k 输出 token（实测一个任务里
  // 模型为了改三处状态把全文重写了 3 次 ≈ 8k 输出 token）。这里按「行内片段
  // 匹配」只改一行，模型输出几十 token 即可。
  ctx.tools.register({
    name: "ai00_plan_check",
    description:
      "Toggle checkbox lines of a Zhixing board card plan (Markdown) without rewriting the document. Cheapest way to mark steps done/undone or tick acceptance items: pass short fragments that appear on those lines — use `matches` to tick several lines in ONE call (e.g. the 3–4 acceptance items after an integration review). Ticking a STEP requires prior evidence: the step block must already contain a `- 验证: passed` line written by ai00_task_verify, otherwise the call is refused (no evidence = no progress). Only use ai00_plan_write for structural edits (new steps, changed acceptance wording).",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Task id. Optional: derived from the session working directory when omitted.",
        },
        match: {
          type: "string",
          description:
            "Short fragment that identifies exactly one line, e.g. a step id (\"S2\") or a few words of the step title.",
        },
        matches: {
          type: "array",
          items: { type: "string" },
          description:
            "Batch form: fragments identifying several lines. All are applied in one write; the call is refused as a whole if any fragment is unmatched or lacks evidence.",
        },
        checked: {
          type: "boolean",
          description: "true = mark done ([x]), false = uncheck ([ ]). Default true.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          line: { type: "string", description: "The updated line (trimmed)." },
          lines: {
            type: "array",
            items: { type: "string" },
            description: "Batch form: every updated line.",
          },
          hint: { type: "string", description: "Present when nothing matched." },
        },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.ok) {
          if (Array.isArray(value.lines) && value.lines.length) {
            return text(`plan lines updated (${value.lines.length}):\n${value.lines.join("\n")}`);
          }
          return text(`plan line updated: ${value.line ?? ""}`);
        }
        return text(
          `no line matched (${value.hint ?? "no match"}). Call ai00_plan_read and use ai00_plan_write instead.`
        );
      },
    },
    async execute(args, exec) {
      const taskId = await resolveTaskId(args, exec);
      const batch = Array.isArray(args?.matches)
        ? args.matches.map((m) => String(m ?? "").trim()).filter(Boolean)
        : [];
      const single = String(args?.match ?? "").trim();
      const fragments = batch.length ? batch : single ? [single] : [];
      const checked = args?.checked !== false;
      if (!taskId || !fragments.length) throw new Error("taskId and match/matches are required");
      const prev = await api.get(`/plan?taskId=${encodeURIComponent(taskId)}`, exec.signal);
      if (!prev?.found) return { ok: false, hint: "no plan document yet" };
      const markdown = String(prev.markdown ?? "");
      const lines = markdown.split("\n");
      // 先全部解析、全部过闸，再一次性写盘：批量里只要有一条不合格就整体拒绝，
      // 避免「勾了一半」的半成品计划（用户看不到哪几条真的生效）。
      const picked = [];
      for (const match of fragments) {
        const index = lines.findIndex(
          (line, i) => !picked.some((p) => p.index === i) && line.includes("]") && line.includes(match)
        );
        if (index < 0) {
          return { ok: false, hint: `no unchecked-by-this-call line contains "${match}"` };
        }
        const original = lines[index];
        if (!/\[( |x|X)\]/.test(original)) {
          return { ok: false, hint: `matched line for "${match}" has no checkbox` };
        }
        // 勾选**步骤**前必须有该步的验证证据（ai00_task_verify 会写回「- 验证: passed」）。
        // 没证据就勾选＝假进度：用户看到「已完成」，但没有任何命令或证据支撑。
        // 只在 `## Steps` 段内判断步骤，并认数字开头 id——否则验收行
        // 「The article is written in English…」会被当成步骤 `The` 而永远勾不上。
        const stepHead = inStepsSection(lines, index) ? STEP_LINE_RE.exec(original) : null;
        if (checked && stepHead) {
          const stepId = stepHead[2];
          const evidence = usableEvidence(stepBlock(lines, index));
          if (!evidence.ok) {
            return {
              ok: false,
              hint:
                evidence.reason === "commands-not-run"
                  ? `step ${stepId} lists executable acceptance commands but its evidence says 0/N ran — run ai00_task_verify (stepId: "${stepId}") and get them to pass before ticking`
                  : evidence.verdict
                    ? `verification for ${stepId} is "${evidence.verdict}" — fix it and re-run ai00_task_verify before ticking`
                    : `no verification evidence for ${stepId} — call ai00_task_verify (stepId: "${stepId}") before ticking`,
            };
          }
        }
        picked.push({ index, original, match });
      }
      const changed = [];
      for (const p of picked) {
        const next = checked
          ? p.original.replace(/\[( |x|X)\]/, "[x]")
          : p.original.replace(/\[( |x|X)\]/, "[ ]");
        if (next !== p.original) {
          lines[p.index] = next;
          changed.push(next.trim());
        }
      }
      if (!changed.length) {
        // 已是目标状态：不写盘，省一次 PUT
        const all = picked.map((p) => p.original.trim());
        return batch.length ? { ok: true, lines: all } : { ok: true, line: all[0] };
      }
      await api.put("/plan", { taskId, markdown: lines.join("\n") }, exec.signal);
      return batch.length ? { ok: true, lines: changed } : { ok: true, line: changed[0] };
    },
  });

  // ---- ai00_web_extract：web 有效信息提取（全本地闭环：搜索→并发抓取→本地筛选）----
  ctx.tools.register({
    name: "ai00_web_extract",
    description:
      "Fetch and extract web content, entirely locally (no API key). Two modes — pass exactly one: `url` fetches that page and returns its cleaned body text (use for a specific page); `query` SEARCHES the web (self-hosted SearXNG, no key), fetches up to 12 pages concurrently, and the LOCAL model screens/summarizes each — returns per-page key points (title/url/summary). This is the single search entry point. Pages marked [degraded] fell back to raw snippets. For a distilled summary of a long body, follow up with ai00_text_summarize.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Direct page URL to fetch and extract body text (takes precedence over query).",
        },
        query: { type: "string", description: "Search query (Chinese or English)." },
        max_results: {
          type: "number",
          description: "Query mode only: pages to fetch and screen (1-12, default 8).",
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          pages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                summary: { type: "string" },
                degraded: { type: "boolean" },
              },
              required: ["title", "url", "summary"],
            },
          },
        },
        required: ["pages"],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const pages = Array.isArray(value?.pages) ? value.pages : [];
        if (pages.length === 0) return text("web extract: no results");
        const lines = pages.map(
          (p, i) =>
            `${i + 1}. ${p.title}\n   ${p.url}\n   ${p.summary}${p.degraded ? " [degraded: raw snippet]" : ""}`
        );
        return text(lines.join("\n"));
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const url = String(args?.url ?? "").trim();
      const query = String(args?.query ?? "").trim();
      if (!url && !query) throw new Error("url or query is required");
      const body = url ? { url } : { query };
      if (!url && Number.isFinite(args?.max_results)) body.max_results = args.max_results;
      return api.post("/web/extract", body, exec.signal);
    },
  });

  // ---- ai00_research_collect：一次调用完成「检索 → 抓取 → 筛选 → 落盘」----
  // 本地 3B 的可靠区只有单次工具调用；连续检索多轮必然退化（查询串乱码、
  // 同一查询复读、最后喊 BLOCKED）。把整条链路下沉到宿主，模型只发一次。
  ctx.tools.register({
    name: "ai00_research_collect",
    description:
      "One-shot research collection. Searches the web for `topic`, fetches and locally screens the pages, de-duplicates them and WRITES a Markdown source list (`save_to`, default sources.md) into the session working directory. Use this INSTEAD of many separate search calls. Do not pass `cwd` — the working directory is resolved by the host.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Research topic, e.g. 'agent memory architecture'." },
        cwd: {
          type: "string",
          description: "Optional; leave empty. The host resolves the session working directory.",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Optional short queries (≤8, ≤6 words each, English preferred).",
        },
        urls: {
          type: "array",
          items: { type: "string" },
          description: "Optional seed URLs to fetch directly (≤12).",
        },
        taskId: {
          type: "string",
          description: "Optional associated task id (ignored by this tool).",
        },
        save_to: {
          type: "string",
          description: "Relative .md file name, default sources.md.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          saved: { type: "string" },
          sources: { type: "number" },
          queries: { type: "number" },
          failed: { type: "number" },
          merged: { type: "boolean" },
        },
        required: ["saved", "sources"],
      },
      render: (_args, value) => {
        const saved = String(value?.saved ?? "sources.md");
        const sources = Number(value?.sources ?? 0);
        const queries = Number(value?.queries ?? 0);
        const failed = Number(value?.failed ?? 0);
        const merged = Boolean(value?.merged);
        if (sources === 0) {
          return text(
            `ai00_research_collect: no results (wrote ${saved}: 0 sources from ${queries} queries, ${failed} failed)`
          );
        }
        return text(
          `wrote ${saved}: ${sources} sources from ${queries} queries, ${failed} failed${
            merged ? " (kept sources from earlier collect)" : ""
          }`
        );
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // topic 缺失时从 queries/urls 推一个：本地模型经常只带 queries 就调，白吃一轮
      // 「topic is required」（实测同一任务里出现 2 次）。
      const queriesArg = Array.isArray(args?.queries)
        ? args.queries.filter((q) => typeof q === "string" && q.trim())
        : [];
      const urlsArg = Array.isArray(args?.urls)
        ? args.urls.filter((u) => typeof u === "string" && u.trim())
        : [];
      const topic = String(args?.topic ?? "").trim() || queriesArg[0] || "";
      if (!topic) throw new Error("topic is required (or pass queries[0])");
      // 工作目录由宿主解析：3B 抄长路径必然出错（实测把 t-1795207736548-5kr
      // 抄成 t-179520207736548-5kr），所以模型给的 cwd 只当提示，最终以引擎的
      // 会话工作目录为准。
      let cwd = "";
      try {
        cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      } catch {
        cwd = String(args?.cwd ?? "").trim();
      }
      if (!cwd) throw new Error("cannot resolve the session working directory");
      const body = { topic, cwd };
      if (queriesArg.length > 0) body.queries = queriesArg;
      if (urlsArg.length > 0) body.urls = urlsArg;
      if (typeof args?.save_to === "string" && args.save_to.trim()) body.save_to = args.save_to.trim();
      const saveTo = String(body.save_to ?? "sources.md");
      const target = resolve(cwd, saveTo);
      // 先留住旧汇编：宿主每次都是整份覆盖，本地模型重复调用会把已采来源写没。
      const previous = await readFile(target, "utf8").catch(() => null);
      const result = await api.post("/web/research", body, exec.signal);
      if (previous && previous.trim()) {
        const nextFile = await readFile(target, "utf8").catch(() => null);
        if (nextFile != null) {
          const mergedText = mergeResearchSources(previous, nextFile);
          if (mergedText !== nextFile) {
            await writeFile(target, mergedText, "utf8");
            return {
              ...result,
              saved: saveTo,
              sources: countResearchSources(mergedText),
              merged: true,
            };
          }
        }
      }
      return result;
    },
  });

  // ---- ai00_text_summarize：长文总结（全本地闭环：≤6000 单次 / >6000 map-reduce 并发）----
  ctx.tools.register({
    name: "ai00_text_summarize",
    description:
      "Summarize a long text entirely LOCALLY (no remote model): short texts in one pass; long texts are chunked and summarized with concurrent local map-reduce. Use this for article/paper/document summarization. For a file on disk pass {path} instead of inlining the text — the host reads it from your working directory (never copy long content into arguments). Optional 'focus' steers the summary toward a concrete question or facts (e.g. '性能数据', '暗号'); for fact extraction always pass focus. Result may carry degraded=true when the local quality gate fell back to partial/raw content — mention the caveat to the user if present.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Full text to summarize (up to 200k chars). Alternative to path.",
        },
        path: {
          type: "string",
          description:
            "Path of a text file to summarize — relative to your working directory, or absolute. Alternative to text; prefer this for long files.",
        },
        focus: { type: "string", description: "Optional aspect or fact to focus on." },
        max_length: {
          type: "number",
          description: "Target summary length in chars (50-4000, default 500).",
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          degraded: { type: "boolean" },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(
          (value?.summary ?? "") + (value?.degraded ? "\n\n[degraded: local quality gate fallback]" : "")
        ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const text = String(args?.text ?? "").trim();
      const path = String(args?.path ?? "").trim();
      if (!text && !path) throw new Error("text or path is required");
      // 两者都给：长正文优先（brief 内联），短文本视为占位/残渣 → 以路径为准。
      const useText = text.length >= 200 || !path;
      const body = useText ? { text } : { path, cwd: "" };
      if (!useText) {
        // cwd 由引擎的会话工作目录决定：3B 手抄长路径必错（同 ai00_research_collect
        // 的教训，实测把 taskId/路径抄坏），模型给的 cwd 只当兜底提示。
        try {
          body.cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
        } catch {
          body.cwd = String(args?.cwd ?? "").trim();
        }
        if (!body.cwd) throw new Error("cannot resolve the session working directory");
      }
      if (typeof args?.focus === "string" && args.focus.trim()) body.focus = args.focus.trim();
      if (Number.isFinite(args?.max_length)) body.max_length = args.max_length;
      return api.post("/text/summarize", body, exec.signal);
    },
  });

  // ---- ai00_local_compose：本地模型先写正文，宿主确定性落盘 ----
  //
  // 2026-11-24：章节扩写不再让 3B 把整段正文塞进 write 的参数 JSON（长正文
  // 的 JSON 转义/嵌套稳定失败），改为「模型只生成纯文本 → 宿主补标题写文件」。
  // 本地纯文本探针 66 prompt token / 2s 即产出通顺英文段落，而同一模型在
  // 工具轮里连续 3 次参数损坏（arguments 非对象 / 乱码复读）。
  ctx.tools.register({
    name: "ai00_local_compose",
    description:
      "Write ONE document section with the local RWKV model and save it deterministically: the model returns only the body text, the host prepends the '## heading' and writes the file. Use one call per section (up to 8 parallel calls per round) for long documents (rule 9). Returns {ok:true, path, bytes, preview} on success, or {ok:false, reason} when the local output is empty or clearly garbled (garbage symbols, prompt echo, HTML fragments) — the host already retried once with different sampling; escalate that section alone to the cloud code_worker. Length is not checked; the content is what matters.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Relative path of the section file, e.g. section-2.md.",
        },
        heading: {
          type: "string",
          description: "Section heading text WITHOUT the leading '##'.",
        },
        topic: {
          type: "string",
          description:
            "One sentence describing what the section must cover, in the document's language.",
        },
        language: {
          type: "string",
          description:
            "Language of the body text, matching the user's request (e.g. English, 中文). Never force Chinese.",
        },
      },
      required: ["file_path", "heading", "topic", "language"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          path: { type: "string" },
          bytes: { type: "integer" },
          preview: { type: "string" },
          reason: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(
          value?.ok
            ? `composed ${value.path} (${value.bytes} bytes)`
            : `compose failed: ${value?.reason ?? "empty output"}`
        ),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = String(args?.file_path ?? "").trim();
      const heading = String(args?.heading ?? "")
        .trim()
        .replace(/^#{1,6}\s*/, "");
      const topic = String(args?.topic ?? "").trim();
      const language = String(args?.language ?? "").trim() || "English";
      if (!filePath || !heading || !topic) {
        return { ok: false, reason: "file_path, heading and topic are required" };
      }
      let cwd = "";
      try {
        cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      } catch {
        cwd = "";
      }
      if (!cwd) return { ok: false, reason: "no working directory for this session" };
      const target = resolve(cwd, filePath);
      if (target !== cwd && !target.startsWith(cwd.endsWith(sep) ? cwd : `${cwd}${sep}`)) {
        return { ok: false, reason: `file_path escapes the working directory: ${filePath}` };
      }
      let clean = "";
      let reason = "";
      // 本地 3B 偶发整段乱码/提示词回声（2026-11-24 基准 8 次里 5 次有缺陷）：
      // 先按默认采样试一次，不合格再换 top_p=0.5 重试一次（与网关草稿门同配方）；
      // 仍不合格才把这一节交给编排者升级云端。长度不作为合格条件。
      for (const topP of [undefined, 0.5]) {
        let completion = { text: "", finishReason: "" };
        try {
          completion = await composeLocalSection({
            baseURL: env.baseURL ?? DEFAULT_BASE_URL,
            token: env.token ?? "",
            heading,
            topic,
            language,
            topP,
            signal: exec.signal,
          });
        } catch (error) {
          return { ok: false, reason: `local model call failed: ${error?.message ?? error}` };
        }
        if (completion.finishReason === "length") {
          reason = "truncated local output (hit max_tokens)";
          continue;
        }
        clean = sanitizeComposedSection(completion.text, heading);
        const chars = [...clean].length;
        if (chars < 20) {
          reason = `empty local output (${chars} chars)`;
          continue;
        }
        if (looksRepetitive(clean)) {
          reason = "repetitive local output (degenerate loop)";
          continue;
        }
        if (looksDegenerate(clean, language)) {
          reason = languageMismatch(clean, language)
            ? `wrong-language local output (expected ${language})`
            : "degenerate local output (garbled text or prompt echo)";
          continue;
        }
        reason = "";
        break;
      }
      if (reason) return { ok: false, reason };
      const content = `${clean.startsWith("#") ? clean : `## ${heading}\n\n${clean}`}\n`;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return {
        ok: true,
        path: filePath,
        bytes: Buffer.byteLength(content, "utf8"),
        preview: content.slice(0, 200),
      };
    },
  });

  // ---- ai00_assemble：分节文件按序拼接为交付物（确定性归约）----
  //
  // 契约规则 9 的第三步。以前交给 local_cmd 写 node 一行命令，本地 3B 生成
  // 的拼接脚本实测直接返回乱码（12:34 任务），还得让云端重做一次。拼接是
  // 纯确定性操作，交给宿主：读文件 → 按序拼 → 写交付物 → 删分节 → 回报标题。
  //
  // 删分节是不可逆的：章节步骤的验收命令读 `section-*.md`，一旦先装配再验
  // 章节，这些步骤就永远失败（2026-11-24 真机踩到，任务卡死只能重跑）。
  // 因此删分节前先读计划：引用这些分节、但还没勾选的步骤存在时直接拒绝。
  async function unverifiedSectionSteps(cwd, sections, signal) {
    const taskId = taskIdFromCwd(cwd);
    if (!taskId) return [];
    const plan = await api
      .get(`/plan?taskId=${encodeURIComponent(taskId)}`, signal)
      .catch(() => null);
    const markdown = typeof plan?.markdown === "string" ? plan.markdown : "";
    if (!markdown.trim()) return [];
    const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    const wanted = new Set(sections.map(norm));
    return parsePlanSteps(markdown)
      .filter((step) => !step.done && step.paths.some((p) => wanted.has(norm(p))))
      .map((step) => step.id);
  }

  ctx.tools.register({
    name: "ai00_assemble",
    description:
      "Concatenate section files into the final document in the given order, then delete the section files. Deterministic host-side assembly for rule 9 — never write a node one-liner for this. Refuses to delete sections while the plan has un-ticked steps that reference them (verify + tick those steps first, or pass keep_sections:true). Returns {ok:true, path, bytes, headings} or {ok:false, reason} when a section file is missing/empty or the section steps are not verified.",
    parameters: {
      type: "object",
      properties: {
        output: {
          type: "string",
          description: "Relative path of the final deliverable, e.g. report.md.",
        },
        sections: {
          type: "array",
          items: { type: "string" },
          description: "Section file paths in document order, e.g. ['section-1.md', ...].",
        },
        keep_sections: {
          type: "boolean",
          description: "Keep the section files after assembly (default false: delete them).",
        },
      },
      required: ["output", "sections"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          path: { type: "string" },
          bytes: { type: "integer" },
          headings: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(
          value?.ok
            ? `assembled ${value.path} (${value.bytes} bytes, ${value.headings?.length ?? 0} headings)`
            : `assemble failed: ${value?.reason ?? "unknown"}`
        ),
    },
    async execute(args, exec) {
      const output = String(args?.output ?? "").trim();
      const sections = Array.isArray(args?.sections) ? args.sections.map(String) : [];
      if (!output || sections.length === 0) {
        return { ok: false, reason: "output and sections are required" };
      }
      let cwd = "";
      try {
        cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      } catch {
        cwd = "";
      }
      if (!cwd) return { ok: false, reason: "no working directory for this session" };
      const inside = (rel) => {
        const abs = resolve(cwd, rel);
        return abs === cwd || abs.startsWith(cwd.endsWith(sep) ? cwd : `${cwd}${sep}`) ? abs : null;
      };
      const target = inside(output);
      if (!target) return { ok: false, reason: `output escapes the working directory: ${output}` };
      if (args?.keep_sections !== true) {
        const blocked = await unverifiedSectionSteps(cwd, sections, exec.signal);
        if (blocked.length) {
          return {
            ok: false,
            reason: `refused: section step(s) not verified/ticked yet: ${blocked.join(", ")} — run ai00_task_verify and tick them BEFORE assembling (assembly deletes the section files); or pass keep_sections:true`,
          };
        }
      }
      let content = "";
      const headings = [];
      for (const rel of sections) {
        const file = inside(rel);
        if (!file) return { ok: false, reason: `section escapes the working directory: ${rel}` };
        let body = "";
        try {
          body = await readFile(file, "utf8");
        } catch {
          return { ok: false, reason: `missing section file: ${rel}` };
        }
        if (!body.trim()) return { ok: false, reason: `empty section file: ${rel}` };
        content += `${body.trimEnd()}\n\n`;
        const heading = body.split("\n").find((line) => line.startsWith("## "));
        if (heading) headings.push(heading.slice(3).trim());
      }
      await mkdir(dirname(target), { recursive: true });
      const finalText = `${content.trimEnd()}\n`;
      await writeFile(target, finalText, "utf8");
      if (args?.keep_sections !== true) {
        for (const rel of sections) {
          const file = inside(rel);
          if (file) await unlink(file).catch(() => {});
        }
      }
      return {
        ok: true,
        path: output,
        bytes: Buffer.byteLength(finalText, "utf8"),
        headings,
      };
    },
  });

  // ---- ai00_polish：云端润色，模型只产出文本，宿主校验后原子写回 ----
  //
  // 2026-11-24 实测：让 cloud code_worker 直接改文件，worker 退化后把
  // report.md 写成 0 字节（原稿被截断）。润色与 compose 同理：模型只负责
  // 返回文本，标题序列校验通过后宿主才原子写回；失败时原稿一字不动。
  ctx.tools.register({
    name: "ai00_polish",
    description:
      "Polish an assembled document with the cloud model: the model returns only the revised Markdown, the host verifies that every '## ' heading is preserved, then writes atomically. Never dispatch a code_worker to rewrite a document. Returns {ok:true, path, bytes, headings} or {ok:false, reason} — on failure the file is left untouched.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Relative path of the document, e.g. report.md.",
        },
        language: {
          type: "string",
          description: "Document language (optional; defaults to the document's own language).",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          path: { type: "string" },
          bytes: { type: "integer" },
          headings: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(
          value?.ok
            ? `polished ${value.path} (${value.bytes} bytes, ${value.headings?.length ?? 0} headings)`
            : `polish failed: ${value?.reason ?? "unknown"}`
        ),
    },
    async execute(args, exec) {
      const filePath = String(args?.file_path ?? "").trim();
      if (!filePath) return { ok: false, reason: "file_path is required" };
      let cwd = "";
      try {
        cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      } catch {
        cwd = "";
      }
      if (!cwd) return { ok: false, reason: "no working directory for this session" };
      const target = resolve(cwd, filePath);
      if (target !== cwd && !target.startsWith(cwd.endsWith(sep) ? cwd : `${cwd}${sep}`)) {
        return { ok: false, reason: `file_path escapes the working directory: ${filePath}` };
      }
      let source = "";
      try {
        source = await readFile(target, "utf8");
      } catch {
        return { ok: false, reason: `missing document: ${filePath}` };
      }
      if (!source.trim()) return { ok: false, reason: "document is empty" };
      let result = { text: "", finishReason: "" };
      try {
        result = await polishRemoteDocument({
          baseURL: env.baseURL ?? DEFAULT_BASE_URL,
          token: env.token ?? "",
          content: source,
          language: String(args?.language ?? "").trim(),
          signal: exec.signal,
        });
      } catch (error) {
        return { ok: false, reason: `remote polish failed: ${error?.message ?? error}` };
      }
      if (result.finishReason === "length") {
        return { ok: false, reason: "polish output truncated (hit max_tokens); draft left untouched" };
      }
      const polished = result.text;
      const invalid = validatePolishedDocument(source, polished);
      if (invalid) return { ok: false, reason: invalid };
      const content = `${polished.trimEnd()}\n`;
      const tmp = `${target}.tmp`;
      await writeFile(tmp, content, "utf8");
      await rename(tmp, target);
      return {
        ok: true,
        path: filePath,
        bytes: Buffer.byteLength(content, "utf8"),
        headings: documentHeadings(content),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Cordis 插件入口
// ---------------------------------------------------------------------------

/** 本插件注册的全部工具名（restrict 模式与宿主对齐时用）。 */
const TOOL_NAMES = [
  "ai00_notify",
  "ai00_wallpaper_create",
  "ai00_wallpaper_projects",
  "ai00_set_wallpaper",
  "ai00_todo_read",
  "ai00_todo_write",
  "ai00_task_verify",
  "ai00_task_complete",
  "ai00_task_create",
  "ai00_focus_log",
  "ai00_plan_read",
  "ai00_plan_write",
  "ai00_plan_check",
  "ai00_web_extract",
  "ai00_research_collect",
  "ai00_text_summarize",
  "ai00_local_compose",
  "ai00_assemble",
  "ai00_polish",
];

function apply(ctx, config) {
  // 限制模式：同一个包挂进 agent preset 时不重复注册工具，只对**该 agent 作用域**
  // 收缩全局工具可见集（ctx.tools.restrict）。工具 schema 是每次请求的固定成本，
  // 编排者/工人用不上的业务工具在各自 preset 里 deny 掉即可省下这部分。
  if (config?.mode === "restrict") {
    const filter = {};
    if (Array.isArray(config.allow) && config.allow.length > 0) filter.allow = config.allow;
    if (Array.isArray(config.deny) && config.deny.length > 0) filter.deny = config.deny;
    if (Object.keys(filter).length === 0) {
      ctx.logger.warn(`${name}: restrict mode without allow/deny, nothing to do`);
      return;
    }
    try {
      ctx.tools.restrict(filter);
    } catch (error) {
      // 引擎对**未知全局工具名**直接抛错，整条限制随之失效。（典型场景：
      // 工人 deny 列表里带引擎全局工具名，而某个名字在本引擎版本不存在。）
      // 降级为只 deny 本插件自己的工具——它们由根挂载全局注册，一定存在；
      // 其余名字只能交给 persona 约束。
      const own = (filter.deny ?? []).filter((t) => TOOL_NAMES.includes(t));
      if (filter.allow === undefined && own.length > 0) {
        try {
          ctx.tools.restrict({ deny: own });
          ctx.logger.warn(
            `${name}: restrict narrowed to own tools (${error?.message ?? error})`
          );
          return;
        } catch (retryError) {
          ctx.logger.warn(`${name}: restrict failed (${retryError?.message ?? retryError})`);
          return;
        }
      }
      // 未知工具名 / 全局注册尚未就位时引擎会抛错：按「不限制」降级，不阻断会话。
      ctx.logger.warn(`${name}: restrict failed (${error?.message ?? error})`);
      return;
    }
    const denied = filter.deny ?? TOOL_NAMES.filter((t) => !filter.allow.includes(t));
    ctx.logger.info(`${name}: restricted tools (${denied.length}) for this agent scope`);
    return;
  }

  const baseURL = config?.baseURL ?? DEFAULT_BASE_URL;
  const token = process.env[TOKEN_ENV] ?? "";
  if (!token) {
    ctx.logger.warn(
      `${name}: ${TOKEN_ENV} not set; host API auth will fail unless the host uses its default token`
    );
  }

  const api = makeClient(baseURL, token);
  defineTools(ctx, api, { baseURL, token });
  ctx.logger.info(`${name}: registered business tools -> ${baseURL}`);
}

export { name, inject, apply };
