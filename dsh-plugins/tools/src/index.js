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
 * - ai00_search        — 搜索兜底（自建 SearXNG s.ai00-x.com，web_search 不可用/空结果时用）
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
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const name = "ai00-x-tools";
const inject = ["tools"];

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
    const token = item[1]
      .replace(/`/g, "")
      .trim()
      .split(/\s+/)[0]
      .replace(/[，。；、,;:：)）】」>]+$/g, "");
    if (!/[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(token)) continue;
    if (!out.includes(token)) out.push(token);
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
 * `passed` 与 `needs-review` 都算「验过」：manual 类验收（`{cmd: …}` 无法执行）
 * 永远只能拿到 needs-review，若只认 passed，这类步骤就永远勾不上（死锁）。
 * `failed` 与「根本没有验证行」一律拒绝——那才是真正的假进度。
 */
function usableEvidence(block) {
  const match = /^\s*-\s*(验证|verification)\s*[:：]\s*([a-z-]+)/im.exec(block);
  if (!match) return { ok: false, verdict: "" };
  const verdict = match[2].toLowerCase();
  return { ok: verdict === "passed" || verdict === "needs-review", verdict };
}

/** 步骤 id → 是否已勾选（用于比较重写前后的勾选变化）。 */
function tickedSteps(markdown) {
  const map = new Map();
  for (const line of String(markdown ?? "").split("\n")) {
    const head = /^\s*-\s+\[([ xX])\]\s+(T[0-9A-Za-z_-]+)\s/.exec(line);
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
  prevLines.forEach((line, i) => {
    const head = /^\s*-\s+\[[ xX]\]\s+(T[0-9A-Za-z_-]+)\s/.exec(line);
    if (!head) return;
    const block = stepBlock(prevLines, i).split("\n");
    const evidence = block.filter((l) => /^\s*-\s*(验证|verification|证据|evidence)\s*[:：]/i.test(l));
    if (evidence.length) kept.set(head[1], evidence);
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

/** 步骤块文本：从步骤行到下一个步骤行或下一个 `## ` 标题（不含）。 */
function stepBlock(lines, startIndex) {
  const out = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    if (/^\s*-\s+\[[ xX]\]\s+T[0-9A-Za-z_-]+\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** 文本块快捷构造。 */
const text = (s) => [{ type: "text", text: String(s) }];

/**
 * 解析计划 MD「## 验收」段的 `- [ ]`/`- [x]` 勾选态（与策窗口
 * utils/planAcceptance.ts 同口径）。返回 {total, done, unchecked[]}。
 */
function parseAcceptance(markdown) {
  const result = { total: 0, done: 0, unchecked: [] };
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
      result.total += 1;
      if (m[1].toLowerCase() === "x") result.done += 1;
      else result.unchecked.push(m[2].trim());
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
  for (const line of lines) {
    const head = /^\s*-\s+\[([ xX])\]\s+(T[0-9A-Za-z_-]+)\s+(.*)$/.exec(line);
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
    const prop = /^\s*-\s*([^:：]{1,24})[:：]\s*(.*)$/.exec(line);
    if (!prop) continue;
    const field = FIELD_ALIASES[prop[1].trim().toLowerCase()];
    if (!field) continue;
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
    if (start >= 0 && /^\s*-\s+\[[ xX]\]\s+T[0-9A-Za-z_-]+\s/.test(line)) {
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

/** 精简证据摘要：命令通过数 / 变更文件数；不写完整输出。 */
function summarizeEvidence(commands, changedFiles) {
  const total = commands.length;
  const passed = commands.filter((cmd) => cmd.ok).length;
  const failed = commands.filter((cmd) => !cmd.ok);
  const parts = [`命令 ${passed}/${total} 通过`];
  if (failed.length) parts.push(`失败 ${failed.length}`);
  if (changedFiles.length) parts.push(`变更 ${changedFiles.length} 文件`);
  return parts.join(" · ");
}

/** 从工作目录取变更清单与 diff（git 不可用时返回空证据，交给 needs-review）。 */
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
  // 幂等：已提交过自检 → 再次调用直接成功（不重复写时间戳）
  if (task.agentCompletedAt) {
    return { data, task, already: true };
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

function defineTools(ctx, api) {
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
      "Run a plan step's acceptance commands and return a compact evidence package (verdict + command outputs + changed files, diff only when needed). Use after EVERY local_code_worker run to check the real result instead of trusting the worker's self-report. verdict: passed = all objective checks passed; failed = a command failed; needs-review = manual/ambiguous/truncated evidence. reviewRequired = true means the orchestrator must have it reviewed (strict mode, high risk, or insufficient evidence). Also returns planPending (unticked step ids + acceptance lines) so you can tick with ai00_plan_check without a separate ai00_plan_read. Passing commands does NOT replace high-risk review or human acceptance.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id from the task brief." },
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
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          stepId: { type: "string" },
          verdict: { type: "string" },
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
          changedFiles: { type: "array", items: { type: "string" } },
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
          `verdict: ${value.verdict} (${value.stepId || "integration"}; risk=${value.risk || "-"}; review=${value.reviewMode || "-"}; reviewRequired=${value.reviewRequired})`,
        ];
        for (const c of value.commands ?? []) {
          lines.push(`${c.ok ? "✓" : "✗"} ${c.cmd}${c.ok ? "" : `\n  ${(c.output || "").slice(0, 1200)}`}`);
        }
        if ((value.manualItems ?? []).length) {
          lines.push(`manual: ${value.manualItems.join(" | ")}`);
        }
        if ((value.changedFiles ?? []).length) {
          lines.push(`changed: ${value.changedFiles.slice(0, 40).join(", ")}`);
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
            "tick with ai00_plan_check (match = step id) — do not re-read the plan just to update it"
          );
        }
        if (value.diff) lines.push(`diff${value.diffTruncated ? " (truncated)" : ""}:\n${value.diff}`);
        return text(lines.join("\n"));
      },
    },
    async execute(args, exec) {
      const taskId = String(args?.taskId ?? "").trim();
      if (!taskId) throw new Error("taskId is required");
      const stepId = String(args?.stepId ?? "").trim();
      const cwd = String(args?.snapshotDir ?? "").trim();
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

      // 验收来源：指定步骤 → 该步骤验收；否则全局「## 验收」
      const acceptance = step
        ? step.acceptance
        : parseAcceptance(markdown).unchecked.map((item) => ({ text: item, cmd: extractCmd(item) }));
      const risk = step?.risk ?? "medium";
      const reviewRequired =
        policy.review === "strict" || risk === "high" || acceptance.length === 0;

      const commands = [];
      const manualItems = [];
      let failed = false;
      for (const item of acceptance) {
        const cmd = item.cmd;
        if (!cmd) {
          manualItems.push(item.text);
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
          manualItems.push(item.text);
          continue;
        }
        const verdict = await runVerification(cmd, cwd || undefined, exec.signal);
        commands.push({ cmd, ok: verdict.ok, output: verdict.output });
        if (!verdict.ok) failed = true;
      }

      const includeDiff =
        args?.includeDiff === true || reviewRequired || failed || policy.review === "strict";
      const evidence = await collectGitEvidence(cwd, pathFilter, includeDiff);

      // 证据不足必须交人工/云端评审，不能假装通过
      const insufficient =
        acceptance.length === 0 ||
        !evidence.repo ||
        (commands.length === 0 && manualItems.length > 0) ||
        (includeDiff && evidence.diffTruncated && evidence.changedFiles.length > 50);
      const verdict = failed ? "failed" : manualItems.length > 0 || insufficient ? "needs-review" : "passed";

      // 把验证结果写回计划（展示层读「验证/证据」两行）；失败不阻断验证结论
      if (stepId && markdown) {
        try {
          const nextMd = upsertStepEvidence(
            markdown,
            stepId,
            verdict,
            summarizeEvidence(commands, evidence.changedFiles)
          );
          if (nextMd !== markdown) {
            await api.put("/plan", { taskId, markdown: nextMd }, exec.signal);
          }
        } catch (error) {
          ctx.logger.warn(`ai00-x-tools: step evidence write-back skipped: ${error.message}`);
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
        changedFiles: evidence.changedFiles,
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
      "Submit a Zhixing task's SELF-CHECK for HUMAN acceptance by id (dual-stage acceptance — this does NOT complete the task; the human reviews and accepts in the Zhixing board). The call is REJECTED when `deliverables` is empty or any listed path does not exist on disk (relative paths resolve against snapshotDir). Self-check gate: if the task's plan document has an '## 验收' (acceptance) section, the call FAILS unless every criterion passes — plain criteria must be checked off in the plan document first (ai00_plan_read then ai00_plan_write with '- [x]'); criteria annotated with {cmd: <shell command>} are executed automatically (in snapshotDir, 120s timeout) and must exit 0 — fix the issue from the command output and retry. On success, if snapshotDir is provided (the working directory from your task brief), a git snapshot of all changes is taken automatically — do NOT commit manually. MUST pass `deliverables`: the absolute paths of every artifact file you produced for this task (report/summary/output files — at least one; write them as real files in the working directory BEFORE calling, e.g. report.md). After submitting, REPORT to the user in the conversation: a short result summary (≤200 words) + the deliverables list (filename + one-line description). XP and completion are granted by the human, not by this tool.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id from the task brief or ai00_todo_read." },
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
        },
        required: ["ok", "title", "xp"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(`self-check submitted for human acceptance: ${value.title} (${(value.deliverables ?? []).length} deliverables registered; awaiting user review in the Zhixing board)`),
    },
    async execute(args, exec) {
      const taskId = String(args?.taskId ?? "").trim();
      if (!taskId) throw new Error("taskId is required");
      const snapshotDir = String(args?.snapshotDir ?? "").trim();
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
        isAbsolute(p) || !snapshotDir ? p : resolve(snapshotDir, p);
      const missing = [];
      for (const raw of deliverables) {
        const target = resolveDeliverable(raw);
        const exists = await stat(target)
          .then((s) => s.isFile() || s.isDirectory())
          .catch(() => false);
        if (!exists) missing.push(raw);
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
      const executedCmds = [];
      if (acceptance.total > 0) {
        const cmdFailures = [];
        let manualUnchecked = 0;
        for (const item of acceptance.unchecked) {
          const cmd = extractCmd(item);
          if (!cmd) {
            manualUnchecked += 1;
            continue;
          }
          const builtin = builtinFileCheck(cmd, snapshotDir || undefined);
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
          executedCmds.push(cmd);
          const verdict = await runVerification(cmd, snapshotDir || undefined, exec.signal);
          if (verdict.ok) continue;
          cmdFailures.push({ item, cmd, output: verdict.output });
        }
        if (manualUnchecked > 0 || cmdFailures.length > 0) {
          const lines = [
            `验收标准未通过（共 ${acceptance.total} 项，通过 ${acceptance.done} 项，验证命令失败 ${cmdFailures.length} 项，人工判据未勾 ${manualUnchecked} 项）。`,
          ];
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
      const { data: next, task, already } = submitSelfCheckInData(data, taskId, deliverables);
      if (already) {
        return { ok: true, title: task.title ?? "", xp: 0 };
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
        taskId: { type: "string", description: "Task id (from the task brief or ai00_todo_read)." },
      },
      required: ["taskId"],
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
      const taskId = String(args?.taskId ?? "").trim();
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
      "Write (replace) the plan document (Markdown) of a Zhixing board card. The 策 window refreshes it live, so the user sees your updates. Prefer ai00_plan_check for status flips; use this only for structural edits. Verification/evidence lines already written by ai00_task_verify are preserved automatically, and a step cannot be newly ticked here without that evidence (the write is refused). The FIRST write of a task's plan is a hard stop: after it, end the turn and wait for the user to confirm the plan — never dispatch a worker in the same turn.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id." },
        markdown: {
          type: "string",
          description: "Complete updated Markdown document (full replacement, not a patch).",
        },
      },
      required: ["taskId", "markdown"],
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
            : "plan document updated"
        );
      },
    },
    async execute(args, exec) {
      const taskId = String(args?.taskId ?? "").trim();
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
      // 整篇重写不得抹掉 ai00_task_verify 写回的验证/证据行
      const merged = firstPlan ? markdown : carryOverEvidence(prevMarkdown, markdown);
      // 也不得把「没验证过的步骤」勾上（与 plan_check 同一闸门）
      if (!firstPlan) {
        const offenders = newlyTickedWithoutEvidence(prevMarkdown, merged);
        if (offenders.length) {
          throw new Error(
            `refused: no verification evidence for ${offenders.join(", ")} — call ai00_task_verify (stepId) first, then tick with ai00_plan_check. Nothing was written.`
          );
        }
      }
      await api.put("/plan", { taskId, markdown: merged }, exec.signal);
      return { ok: true, firstPlan, evidencePreserved: merged !== markdown };
    },
  });

  // ---- ai00_plan_check：只勾选/取消勾选计划里的一行（免整篇重写）----
  // 计划文档动辄 2–3k 字，整篇重写一次就是 2–3k 输出 token（实测一个任务里
  // 模型为了改三处状态把全文重写了 3 次 ≈ 8k 输出 token）。这里按「行内片段
  // 匹配」只改一行，模型输出几十 token 即可。
  ctx.tools.register({
    name: "ai00_plan_check",
    description:
      "Toggle one checkbox line of a Zhixing board card plan (Markdown) without rewriting the document. Cheapest way to mark a step done/undone or tick an acceptance item: pass a short fragment that appears on that line. Ticking a STEP requires prior evidence: the step block must already contain a `- 验证: passed` line written by ai00_task_verify, otherwise the call is refused (no evidence = no progress). Only use ai00_plan_write for structural edits (new steps, changed acceptance wording).",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id." },
        match: {
          type: "string",
          description:
            "Short fragment that identifies exactly one line, e.g. a step id (\"S2\") or a few words of the step title.",
        },
        checked: {
          type: "boolean",
          description: "true = mark done ([x]), false = uncheck ([ ]). Default true.",
        },
      },
      required: ["taskId", "match"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          line: { type: "string", description: "The updated line (trimmed)." },
          hint: { type: "string", description: "Present when nothing matched." },
        },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.ok) return text(`plan line updated: ${value.line ?? ""}`);
        return text(
          `no line matched (${value.hint ?? "no match"}). Call ai00_plan_read and use ai00_plan_write instead.`
        );
      },
    },
    async execute(args, exec) {
      const taskId = String(args?.taskId ?? "").trim();
      const match = String(args?.match ?? "").trim();
      const checked = args?.checked !== false;
      if (!taskId || !match) throw new Error("taskId and match are required");
      const prev = await api.get(`/plan?taskId=${encodeURIComponent(taskId)}`, exec.signal);
      if (!prev?.found) return { ok: false, hint: "no plan document yet" };
      const markdown = String(prev.markdown ?? "");
      const lines = markdown.split("\n");
      const index = lines.findIndex((line) => line.includes("]") && line.includes(match));
      if (index < 0) {
        return { ok: false, hint: `no checkbox line contains "${match}"` };
      }
      const original = lines[index];
      if (!/\[( |x|X)\]/.test(original)) {
        return { ok: false, hint: "matched line has no checkbox" };
      }
      // 勾选**步骤**前必须有该步的验证证据（ai00_task_verify 会写回「- 验证: passed」）。
      // 没证据就勾选＝假进度：用户看到「已完成」，但没有任何命令或证据支撑。
      const stepHead = /^\s*-\s+\[[ xX]\]\s+(T[0-9A-Za-z_-]+)\s/.exec(original);
      if (checked && stepHead) {
        const stepId = stepHead[1];
        const evidence = usableEvidence(stepBlock(lines, index));
        if (!evidence.ok) {
          return {
            ok: false,
            hint: evidence.verdict
              ? `verification for ${stepId} is "${evidence.verdict}" — fix it and re-run ai00_task_verify before ticking`
              : `no verification evidence for ${stepId} — call ai00_task_verify (stepId: "${stepId}") before ticking`,
          };
        }
      }
      const next = checked
        ? original.replace(/\[( |x|X)\]/, "[x]")
        : original.replace(/\[( |x|X)\]/, "[ ]");
      if (next === original) {
        // 已是目标状态：不写盘，省一次 PUT
        return { ok: true, line: original.trim() };
      }
      lines[index] = next;
      await api.put("/plan", { taskId, markdown: lines.join("\n") }, exec.signal);
      return { ok: true, line: next.trim() };
    },
  });

  // ---- ai00_search：搜索兜底（自建 SearXNG）----
  // 引擎的 web_search 由 dsh-web 选单一提供方（DeepSeek 搜索需 API key/登录），
  // 不可用或空结果时用本工具走自建服务，避免 agent 完全搜不到东西。
  ctx.tools.register({
    name: "ai00_search",
    description:
      "Search the web through Ai00-X's self-hosted SearXNG (no API key) — the primary web search tool. Returns title/url/snippet only; pass a result's URL to ai00_web_extract to get the page body, or call ai00_web_extract with a query directly for distilled per-page summaries.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        max_results: {
          type: "number",
          description: "Results to return (1-10, default 8).",
        },
        language: {
          type: "string",
          description: "Language tag, default zh-CN.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                snippet: { type: "string" },
              },
              required: ["title", "url", "snippet"],
            },
          },
        },
        required: ["results"],
      },
      render: (_args, value) => {
        const items = Array.isArray(value?.results) ? value.results : [];
        if (items.length === 0) return text("ai00_search: no results");
        return text(
          items
            .map(
              (item, index) =>
                `${index + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet}`
            )
            .join("\n")
        );
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const max = Math.min(Math.max(Number(args?.max_results) || 8, 1), 10);
      const language = String(args?.language ?? "zh-CN");
      const base = (process.env.AI00_SEARCH_URL || "https://s.ai00-x.com").replace(/\/+$/, "");
      const params = new URLSearchParams({
        q: query,
        format: "json",
        language,
        pageno: "1",
      });
      const response = await fetch(`${base}/search?${params.toString()}`, {
        headers: { accept: "application/json", "user-agent": "Ai00-X/1.0" },
        signal: exec.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`search HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error("search returned non-JSON (SearXNG json format may be disabled)");
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      return {
        results: results.slice(0, max).map((item) => ({
          title: String(item?.title ?? ""),
          url: String(item?.url ?? ""),
          snippet: String(item?.content ?? item?.snippet ?? "").slice(0, 500),
        })),
      };
    },
  });

  // ---- ai00_web_extract：web 有效信息提取（全本地闭环：搜索→并发抓取→本地筛选）----
  ctx.tools.register({
    name: "ai00_web_extract",
    description:
      "Fetch and extract web content, entirely locally (no API key). Two modes — pass exactly one: `url` fetches that page and returns its cleaned body text (use for a specific page, e.g. a link from ai00_search results); `query` searches up to 12 pages, fetches them concurrently, and the LOCAL model screens/summarizes each — returns per-page key points (title/url/summary). Pages marked [degraded] fell back to raw snippets. For a distilled summary of a long body, follow up with ai00_text_summarize.",
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

  // ---- ai00_text_summarize：长文总结（全本地闭环：≤6000 单次 / >6000 map-reduce 并发）----
  ctx.tools.register({
    name: "ai00_text_summarize",
    description:
      "Summarize a long text entirely LOCALLY (no remote model): short texts in one pass; long texts are chunked and summarized with concurrent local map-reduce. Use this for article/paper/document summarization. Optional 'focus' steers the summary (e.g. '性能数据'). Result may carry degraded=true when the local quality gate fell back to partial/raw content — mention the caveat to the user if present.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Full text to summarize (up to 200k chars)." },
        focus: { type: "string", description: "Optional aspect to focus on." },
        max_length: {
          type: "number",
          description: "Target summary length in chars (50-4000, default 500).",
        },
      },
      required: ["text"],
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
      if (!text) throw new Error("text is required");
      const body = { text };
      if (typeof args?.focus === "string" && args.focus.trim()) body.focus = args.focus.trim();
      if (Number.isFinite(args?.max_length)) body.max_length = args.max_length;
      return api.post("/text/summarize", body, exec.signal);
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
  "ai00_search",
  "ai00_web_extract",
  "ai00_text_summarize",
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
  defineTools(ctx, api);
  ctx.logger.info(`${name}: registered business tools -> ${baseURL}`);
}

export { name, inject, apply };
