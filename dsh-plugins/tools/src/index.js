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
 * - ai00_task_complete — 完成任务（DoD 验收前置校验；周期任务自动克隆下一次 + 服务器 XP 入账）
 * - ai00_task_create   — agent 自主建卡（想法池落卡，人机对等的想法收集）
 * - ai00_focus_log     — 记录专注会话（宿主广播事件，web-ui 发放 XP）
 * - ai00_plan_read     — 读卡片计划文档 MD（与策窗口共享同一文件）
 * - ai00_plan_write    — 写卡片计划文档 MD（策窗口热刷新可见）
 *
 * 本插件只做协议薄壳：业务逻辑在宿主侧（D7 决策）。
 * 不 import @deepseek-ai/dsh-tools（pnpm 严格解析下不可达），用原始
 * ToolDefinition 形状注册——参数校验自行完成，输出声明仍由注册表强制校验。
 */

import { exec } from "node:child_process";

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

/** 文本块快捷构造。 */
const text = (s) => [{ type: "text", text: String(s) }];

// ---------------------------------------------------------------------------
// 知行数据辅助（todoStore.completeTask / TaskRow.onCheck 的 JS 移植）
// ---------------------------------------------------------------------------

/** 本地日期 'YYYY-MM-DD'。 */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' → Date（当日 12:00，与 todoStore.parseDue 一致）。 */
function parseDue(due) {
  const [y, m, d] = due.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

/** Date → 'YYYY-MM-DD'。 */
function fmtDue(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addMonths(date, n) {
  return new Date(date.getFullYear(), date.getMonth() + n, date.getDate(), 12);
}

/** 简短 id（与 todoStore.genId 同风格）。 */
function genId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

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
      inSection = /^##\s*验收/.test(line);
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
  if (!m) return null;
  const cmd = m[1].trim();
  // 基本护栏：长度上限 + 拒绝嵌套 shell 展开（防计划文档被注入任意复合命令）
  if (!cmd || cmd.length > 500) return null;
  if (/`|\$\(|&&\s*rm|;\s*rm/.test(cmd)) return null;
  return cmd;
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
 * 完成任务：completedAt 置当前时间；周期任务克隆下一次（due 推进、
 * remindAt 同时刻映射、状态复位）。返回 {data, task, xp}。
 */
function completeTaskInData(data, taskId) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const index = tasks.findIndex((t) => t?.id === taskId);
  if (index < 0) {
    throw new Error(`task not found: ${taskId} (use ai00_todo_read to list tasks)`);
  }
  const task = tasks[index];
  if (task.completedAt) {
    throw new Error(`task already completed: ${task.title}`);
  }
  const now = Date.now();
  const nextTasks = [...tasks];
  nextTasks[index] = { ...task, completedAt: now };

  // 周期任务：克隆下一次（移植 todoStore.completeTask）
  if (task.repeat) {
    const base =
      task.repeat.afterCompletion || !task.due ? new Date(now) : parseDue(task.due);
    let next;
    switch (task.repeat.type) {
      case "daily":
        next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 12);
        break;
      case "weekly":
        next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7, 12);
        break;
      case "monthly":
        next = addMonths(base, 1);
        break;
      case "weekdays": {
        next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 12);
        while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
        break;
      }
      default:
        next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 12);
    }
    const nextDue = fmtDue(next);
    const nextRemind = task.remindAt ? nextDue + task.remindAt.slice(10) : null;
    nextTasks.push({
      ...task,
      id: genId(),
      completedAt: null,
      createdAt: now,
      remindedAt: null,
      checklist: (task.checklist ?? []).map((c) => ({ ...c, d: false })),
      focus: { pomodoros: 0, minutes: 0 },
      due: nextDue,
      remindAt: nextRemind,
    });
  }

  // XP 公式（移植 TaskRow.onCheck）：10 基础 + 今日到期 5 + 检查项全勾 3（上限 20）
  const today = todayStr();
  let xp = 10;
  if (task.due && task.due <= today) xp += 5;
  if (
    Array.isArray(task.checklist) &&
    task.checklist.length > 0 &&
    task.checklist.every((c) => c.d)
  ) {
    xp += 3;
  }
  xp = Math.min(xp, 20);

  return { data: { ...data, tasks: nextTasks }, task, xp };
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

  // ---- ai00_task_complete：完成任务 + XP（DoD 验收前置校验 + 完成快照）----
  ctx.tools.register({
    name: "ai00_task_complete",
    description:
      "Mark a Zhixing task as completed by id. Acceptance gate: if the task's plan document has an '## 验收' (acceptance) section, the call FAILS unless every criterion passes — plain criteria must be checked off in the plan document first (ai00_plan_read then ai00_plan_write with '- [x]'); criteria annotated with {cmd: <shell command>} are executed automatically (in snapshotDir, 120s timeout) and must exit 0 — fix the issue from the command output and retry. On success, if snapshotDir is provided (the working directory from your task brief), a git snapshot commit of all changes is taken automatically — do NOT commit manually. Handles recurring-task cloning and awards server-side XP (10 base + due-today 5 + checklist 3, cap 20).",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id from the task brief or ai00_todo_read." },
        snapshotDir: {
          type: "string",
          description:
            "Working directory from the task brief (if any). A git snapshot of your changes is committed on completion.",
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
          // 周期任务下一次 due；非周期任务为 null（dsh schema 不支持 type 数组）
          recurringNext: { type: "string" },
        },
        required: ["ok", "title", "xp"],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(
          `task completed: ${value.title} (+${value.xp} XP)${
            value.recurringNext ? `; next occurrence due ${value.recurringNext}` : ""
          }`
        ),
    },
    async execute(args, exec) {
      const taskId = String(args?.taskId ?? "").trim();
      if (!taskId) throw new Error("taskId is required");
      const snapshotDir = String(args?.snapshotDir ?? "").trim();

      // DoD 对等校验（与策窗口人侧「标记完成」同口径）：验收未全勾 → 报错驱动自纠。
      // evals 进环（M2.3）：带 {cmd: ...} 标记的条目由插件实际执行命令判定——
      // 命令通过视同通过（无需人工勾选），失败则把输出回灌给 agent 自纠。
      const plan = await api
        .get(`/plan?taskId=${encodeURIComponent(taskId)}`, exec.signal)
        .catch(() => null);
      const acceptance = parseAcceptance(plan?.markdown);
      if (acceptance.total > 0) {
        const cmdFailures = [];
        let manualUnchecked = 0;
        for (const item of acceptance.unchecked) {
          const cmd = extractCmd(item);
          if (!cmd) {
            manualUnchecked += 1;
            continue;
          }
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
              "请先逐项自检，用 ai00_plan_read + ai00_plan_write 把计划文档「## 验收」段的对应项改为 \"- [x]\"。未通过项：",
              items,
            );
          }
          throw new Error(lines.join("\n"));
        }
      }

      const data = await api.get("/todo", exec.signal);
      const { data: next, task, xp } = completeTaskInData(data, taskId);

      // 完成快照（任务粒度 commit；失败静默——不阻塞完成主流程）
      if (snapshotDir) {
        try {
          await api.post(
            "/git/snapshot",
            { dir: snapshotDir, message: `task: ${task.title} · agent 执行` },
            exec.signal
          );
        } catch (error) {
          ctx.logger.warn(`ai00-x-tools: completion snapshot skipped: ${error.message}`);
        }
      }

      await api.put("/todo", next, exec.signal);

      // XP 入账（服务器按 taskId 幂等去重；未登录时静默跳过）
      try {
        await api.post(
          "/xp",
          { kind: "todo.task_done", amount: xp, meta: { taskId, title: task.title } },
          exec.signal
        );
      } catch (error) {
        ctx.logger.warn(`ai00-x-tools: xp report skipped: ${error.message}`);
      }

      const recurringNext =
        task.repeat && Array.isArray(next.tasks)
          ? (next.tasks[next.tasks.length - 1]?.due ?? null)
          : null;
      // schema 是 string（dsh 不支持 type 数组）：非周期任务省略该字段
      return {
        ok: true,
        title: task.title ?? "",
        xp,
        ...(recurringNext ? { recurringNext } : {}),
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
      "Write (replace) the plan document (Markdown) of a Zhixing board card. The 策 window refreshes it live, so the user sees your updates. ai00_plan_read first, modify, then write back whole. Use it to check off steps, record progress, or adjust the plan as work unfolds.",
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
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      render: (_args, value) => text(value.ok ? "plan document updated" : "plan write failed"),
    },
    async execute(args, exec) {
      const taskId = String(args?.taskId ?? "").trim();
      const markdown = String(args?.markdown ?? "");
      if (!taskId || !markdown.trim()) throw new Error("taskId and markdown are required");
      await api.put("/plan", { taskId, markdown }, exec.signal);
      return { ok: true };
    },
  });
}

// ---------------------------------------------------------------------------
// Cordis 插件入口
// ---------------------------------------------------------------------------

function apply(ctx, config) {
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
