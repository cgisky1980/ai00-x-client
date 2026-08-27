/**
 * todo 本地 AI 通道（拆解 / 规划对话 / 拟策 / 日终回顾）——走 `plugin_ai_complete`
 * 命令，核心 id `com.ai00x.core.todo` 豁免插件 gate（plugin_api.rs
 * CORE_FEATURE_IDS）。本地 RWKV 优先（Instruction 格式 + T≈1/P≈0.1）。
 * model 引用可选透传（'auto' = 不传：本地 RWKV 优先 + primary 自动回退；
 * 其余引用见 plugin_api.rs resolve_model_selection）。
 */
import { invoke } from '@tauri-apps/api/core';

const CORE_ID = 'com.ai00x.core.todo';

export async function aiComplete(
  prompt: string,
  systemPrompt: string,
  opts?: { temperature?: number; topP?: number; maxTokens?: number; model?: string; tag?: string }
): Promise<string> {
  const res = await invoke<{ text?: string }>('plugin_ai_complete', {
    request: {
      pluginId: CORE_ID,
      prompt,
      systemPrompt,
      temperature: opts?.temperature ?? 0.9,
      topP: opts?.topP ?? 0.1,
      maxTokens: opts?.maxTokens ?? 1024,
      ...(opts?.model && opts.model !== 'auto' ? { model: opts.model } : {}),
      ...(opts?.tag ? { tag: opts.tag } : {}),
    },
  });
  return typeof res?.text === 'string' ? res.text : '';
}

/** 从 LLM 输出提取首个 JSON 值（容忍代码围栏/前后杂文）。 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.search(/[[{]/);
  if (start < 0) return null;
  const open = cleaned[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 任务拆解（检查项）与目标拆解。 */
export async function breakdownTask(title: string): Promise<string[] | null> {
  try {
    const out = await aiComplete(
      `任务：${title}`,
      '把给定任务拆解为 3-7 个可勾选的检查项（每项一个简短动作）。' +
        '输出严格 JSON：{"items":["检查项1","检查项2"]}。只输出 JSON，不要任何其他文字。' +
        '示例：输入"任务：写周报"，输出 {"items":["收集本周进展","整理数据","写初稿","发邮件"]}。',
      { temperature: 1.0, maxTokens: 600 }
    );
    const parsed = extractJson(out) as { items?: unknown } | null;
    if (parsed && Array.isArray(parsed.items)) {
      const items = parsed.items.filter((s) => typeof s === 'string' && s.trim()).slice(0, 7) as string[];
      return items.length ? items : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function breakdownGoal(title: string, why: string, deadline: string | null): Promise<{ title: string; due: string | null; milestone: number }[] | null> {
  const today = todayStr();
  try {
    const out = await aiComplete(
      `目标：${title}${why ? `（${why}）` : ''}${deadline ? `，截止 ${deadline}` : ''}`,
      '把给定目标拆解为 2-4 个阶段和 3-7 个跨天推进的任务（每任务标注所属阶段，0=未分阶段）。今天是 ' + today +
        '。输出严格 JSON：{"milestones":["阶段1","阶段2"],"tasks":[{"title":"简短任务名","due":"YYYY-MM-DD","milestone":1}]}。' +
        'due 从今天到目标截止日之间合理分布；没有截止日就分布在未来两周。只输出 JSON。',
      { temperature: 1.0, maxTokens: 900 }
    );
    const parsed = extractJson(out) as { tasks?: { title?: unknown; due?: unknown; milestone?: unknown }[] } | null;
    if (parsed && Array.isArray(parsed.tasks)) {
      const items = parsed.tasks
        .filter((t) => t && typeof t.title === 'string' && t.title.trim())
        .slice(0, 7)
        .map((t) => ({
          title: String(t.title).trim().slice(0, 80),
          due: typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : null,
          milestone: Number(t.milestone) || 0,
        }));
      return items.length ? items : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 方案草稿（谋士）：策略段 + 阶段 + 任务三段一体。 */
export interface PlanDraft {
  plan: string[];
  milestones: string[];
  tasks: { title: string; due: string | null; milestone: number }[];
}

export async function draftPlan(
  title: string,
  why: string,
  deadline: string | null,
  goalId?: string | null
): Promise<PlanDraft | null> {
  const today = todayStr();
  try {
    const out = await aiComplete(
      `志向：${title}${why ? `（${why}）` : ''}${deadline ? `，截止 ${deadline}` : ''}`,
      '你是谋士。为给定志向拟定实施方案：先给 2-4 段简明策略（每段不超过80字），' +
        '再划 2-4 个阶段，最后给 3-7 个可执行任务（标注所属阶段序号，0=未分阶段，及日期）。今天是 ' + today + '。' +
        '输出严格 JSON：{"plan":["策略段1","策略段2"],"milestones":["阶段1","阶段2"],' +
        '"tasks":[{"title":"任务名","due":"YYYY-MM-DD","milestone":1}]}。只输出 JSON，不要任何其他文字。',
      { temperature: 1.0, maxTokens: 1100, tag: `todo:draft:${goalId ?? 'none'}` }
    );
    const parsed = extractJson(out) as Partial<PlanDraft> | null;
    if (!parsed) return null;
    const plan = Array.isArray(parsed.plan)
      ? parsed.plan.filter((s) => typeof s === 'string' && s.trim()).slice(0, 6).map((s) => String(s).trim().slice(0, 200))
      : [];
    const milestones = Array.isArray(parsed.milestones)
      ? parsed.milestones.filter((s) => typeof s === 'string' && s.trim()).slice(0, 6).map((s) => String(s).trim().slice(0, 40))
      : [];
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks
          .filter((t) => t && typeof (t as { title?: unknown }).title === 'string' && String((t as { title?: unknown }).title).trim())
          .slice(0, 7)
          .map((t) => {
            const obj = t as { title?: unknown; due?: unknown; milestone?: unknown };
            return {
              title: String(obj.title).trim().slice(0, 80),
              due: typeof obj.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.due) ? obj.due : null,
              milestone: Number(obj.milestone) || 0,
            };
          })
      : [];
    if (!plan.length && !tasks.length) return null;
    return { plan, milestones, tasks };
  } catch {
    return null;
  }
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ===== 策 v3 看板规划对话（需求卡 → 讨论计划） =====

import type { BoardPlan, PlanChatMessage } from '../api/types';

/** 拼接规划对话历史（RWKV 无多轮状态，手工拼）。 */
function buildPlanChatInput(title: string, notes: string, chat: PlanChatMessage[]): string {
  let s = `需求：${title}${notes ? `（${notes}）` : ''}`;
  for (const m of chat) s += `\n${m.role === 'user' ? '用户' : '助手'}：${m.text}`;
  return s;
}

const PLAN_CHAT_SYSTEM =
  '你是规划助手。与用户讨论需求、澄清模糊点、建议拆解思路。' +
  '每轮回复简洁（不超过120字），可以追问一个关键问题，也可以给建议。' +
  '当需求已经清晰时，建议用户点击「生成计划」。直接输出正文，不要角色前缀。';

/** 规划对话一轮 AI 回复（讨论模式）。tag = todo:chat:{goalId|none}（用量记账归志）。 */
export async function planChatReply(
  title: string,
  notes: string,
  chat: PlanChatMessage[],
  model?: string,
  goalId?: string | null
): Promise<string | null> {
  try {
    const out = await aiComplete(buildPlanChatInput(title, notes, chat), PLAN_CHAT_SYSTEM, {
      temperature: 1.0,
      topP: 0.3,
      maxTokens: 300,
      model,
      tag: `todo:chat:${goalId ?? 'none'}`,
    });
    const text = out
      .split(/\n\s*\n|System:|User:|Assistant:|Instruction:|Response:/)[0]
      .trim()
      .slice(0, 300);
    return text || null;
  } catch {
    return null;
  }
}

const BOARD_PLAN_SYSTEM = (today: string, planHint?: string) =>
  '你是规划助手。根据需求讨论，生成一份计划契约（人机共同签署：目标+步骤+验收）。今天是 ' + today + '。' +
  '输出严格 JSON：{"summary":"一段话计划摘要","goal":"一句话目标","tasks":[{"title":"步骤名","notes":"补充"}],' +
  '"acceptance":["验收标准1","验收标准2"],"deliverable":"交付物描述或 null"}。' +
  'tasks 3-7 个；' + (planHint ?? 'acceptance 是可客观检验的完成判据（DoD），3-6 项。') +
  '只输出 JSON，不要任何其他文字。';

/** 由规划对话生成看板计划契约（目标+步骤+验收）。 */
export async function generateBoardPlan(
  title: string,
  notes: string,
  chat: PlanChatMessage[],
  model?: string,
  goalId?: string | null
): Promise<BoardPlan | null> {
  try {
    // 通用 agent 的验收指引（插件模块可带各自 planHint）
    const { AGENT_MODULES } = await import('../agent-modules');
    const planHint = AGENT_MODULES.find(m => m.id === 'agent')?.planHint;
    const out = await aiComplete(buildPlanChatInput(title, notes, chat), BOARD_PLAN_SYSTEM(todayStr(), planHint), {
      temperature: 1.0,
      topP: 0.1,
      maxTokens: 900,
      model,
      tag: `todo:chat:${goalId ?? 'none'}`,
    });
    const parsed = extractJson(out) as Partial<BoardPlan> | null;
    if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null;
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks
          .filter((t) => t && typeof t === 'object' && typeof (t as { title?: unknown }).title === 'string' && (t as { title: string }).title.trim())
          .slice(0, 7)
          .map((t) => {
            const obj = t as { title?: unknown; notes?: unknown };
            return {
              title: String(obj.title).trim().slice(0, 80),
              notes: typeof obj.notes === 'string' ? obj.notes.slice(0, 200) : undefined,
            };
          })
      : [];
    const acceptance = Array.isArray(parsed.acceptance)
      ? parsed.acceptance
          .filter((s) => typeof s === 'string' && s.trim())
          .slice(0, 6)
          .map((s) => String(s).trim().slice(0, 80))
      : [];
    return {
      summary: parsed.summary.trim().slice(0, 400),
      goal: typeof parsed.goal === 'string' ? parsed.goal.trim().slice(0, 120) : title.slice(0, 120),
      tasks,
      acceptance,
      ...(typeof parsed.deliverable === 'string' && parsed.deliverable.trim()
        ? { deliverable: parsed.deliverable.trim().slice(0, 120) }
        : {}),
    };
  } catch {
    return null;
  }
}

// ===== 志·AI 评估（结合项目实况的阶段评估报告） =====

/** 评估输入：志信息 + 志愿进度 + 项目实况摘要（绑定目录时采集；缺省纯愿景评估）。 */
export interface AssessGoalInput {
  title: string;
  why: string;
  deadline: string | null;
  /** 阶段名与完成态 */
  milestones: { title: string; done: boolean }[];
  /** 关联行卡进度（已完成/总数 + 未完成标题样本） */
  progress: { done: number; total: number; openTitles: string[] };
  /** 项目实况摘要（目录树/README/git 记录拼好的文本；null=未绑定目录） */
  workspaceSummary: string | null;
}

/** 结构化评估报告（固定四段）。 */
export interface GoalAssessment {
  /** 【阶段】当前阶段判断 */
  stage: string;
  /** 【亮点】列表 */
  highlights: string[];
  /** 【缺口】列表 */
  gaps: string[];
  /** 【建议】下一步最值得做的一件事 */
  advice: string;
}

/** 从标记文本解析四段结构；无任何标记时全文兜底进 stage。 */
function parseAssessment(text: string): GoalAssessment {
  const grab = (mark: string): string => {
    const m = text.match(new RegExp(`【${mark}】([\\s\\S]*?)(?=【|$)`));
    return m ? m[1].trim() : '';
  };
  const stage = grab('阶段');
  const highlights = grab('亮点').split('\n').map(s => s.trim()).filter(Boolean);
  const gaps = grab('缺口').split('\n').map(s => s.trim()).filter(Boolean);
  const advice = grab('建议');
  if (!stage && !highlights.length && !gaps.length && !advice) {
    return { stage: text, highlights: [], gaps: [], advice: '' };
  }
  return { stage, highlights: highlights.slice(0, 4), gaps: gaps.slice(0, 4), advice };
}

/**
 * AI 评估：固定四段标记格式（本地 RWKV 生成 JSON 不可靠，走标记文本 + 客户端解析）。
 * 解析兜底：模型未按格式输出时全文进 stage，保证有内容可渲染。
 */
export async function assessGoal(
  input: AssessGoalInput,
  model?: string,
  tag?: string
): Promise<GoalAssessment | null> {
  const parts: string[] = [`志向：${input.title}${input.why ? `（${input.why}）` : ''}`];
  if (input.deadline) parts.push(`截止：${input.deadline}`);
  if (input.milestones.length) {
    parts.push(
      `阶段：${input.milestones.map(m => `${m.title}${m.done ? '（已完成）' : ''}`).join('、')}`
    );
  }
  parts.push(
    `任务进度：${input.progress.done}/${input.progress.total} 完成` +
      (input.progress.openTitles.length ? `；未完成：${input.progress.openTitles.slice(0, 8).join('、')}` : '')
  );
  if (input.workspaceSummary) parts.push(`项目实况（目录/README/git 记录）：\n${input.workspaceSummary}`);

  try {
    const out = await aiComplete(
      parts.join('\n'),
      '你是项目评估师。基于志向与项目实况写评估报告，固定四段格式：' +
        '第一段以【阶段】开头，判断项目当前阶段与推进程度（一两句）；' +
        '第二段以【亮点】开头，列出实况中可见的进展或优势（1-3 条，每条一行）；' +
        '第三段以【缺口】开头，列出最突出的风险或欠缺（1-3 条，每条一行，没有就写一条「暂无明显缺口」）；' +
        '第四段以【建议】开头，给下一步最值得做的一件事（一句）。' +
        '依据实据说话，不要空话套话，除这四段外不要输出任何其他文字。',
      { temperature: 1.0, topP: 0.2, maxTokens: 600, model, tag }
    );
    // 截断模型幻觉的角色标记/续写（Instruction 格式单发常见）
    const text = out
      .split(/\n\s*\n(?=.)|System:|User:|Assistant:|Instruction:|Response:/)[0]
      .trim()
      .slice(0, 1500);
    if (text.length < 20) return null;
    return parseAssessment(text);
  } catch {
    return null;
  }
}

/** 日终回顾（知己）：今日完成/新增/专注 → 一段温润小结（先肯定，再一句建议）。 */
export async function dailyReview(input: {
  doneTitles: string[];
  createdCount: number;
  focusMin: number;
}): Promise<string | null> {
  try {
    const summary =
      `今日完成 ${input.doneTitles.length} 项` +
      (input.doneTitles.length ? `：${input.doneTitles.slice(0, 5).join('、')}` : '') +
      `；新增 ${input.createdCount} 项；专注 ${input.focusMin} 分钟。`;
    const out = await aiComplete(
      summary,
      '你是知己。根据今日完成情况写一段日终回顾：先真诚肯定亮点，再给一句具体的明日建议。' +
        '不超过 80 字，语气温润克制，不用列表，不用感叹号，直接输出正文。',
      { temperature: 1.0, maxTokens: 200, tag: 'todo:review' }
    );
    // 截断模型幻觉的角色标记/续写（Instruction 格式单发常见）
    const text = out
      .split(/\n\s*\n|System:|User:|Assistant:|Instruction:|Response:/)[0]
      .trim()
      .slice(0, 120);
    return text.length >= 10 ? text : null;
  } catch {
    return null;
  }
}
