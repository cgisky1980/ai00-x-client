/**
 * todo 本地 AI 通道（细谈 / 拆解）——走 `plugin_ai_complete` 命令，
 * 核心 id `com.ai00x.core.todo` 豁免插件 gate（plugin_api.rs
 * CORE_FEATURE_IDS）。本地 RWKV 优先（Instruction 格式 + T≈1/P≈0.1）。
 */
import { invoke } from '@tauri-apps/api/core';

const CORE_ID = 'com.ai00x.core.todo';

export async function aiComplete(
  prompt: string,
  systemPrompt: string,
  opts?: { temperature?: number; topP?: number; maxTokens?: number }
): Promise<string> {
  const res = await invoke<{ text?: string }>('plugin_ai_complete', {
    request: {
      pluginId: CORE_ID,
      prompt,
      systemPrompt,
      temperature: opts?.temperature ?? 0.9,
      topP: opts?.topP ?? 0.1,
      maxTokens: opts?.maxTokens ?? 1024,
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

// ===== 细谈式创建（对话澄清模式） =====

export interface ConsultDraft {
  title: string;
  notes: string;
  due: string | null; // 'YYYY-MM-DD'
  remindTime: string | null; // 'HH:MM'
  repeat: 'daily' | 'weekly' | 'monthly' | 'weekdays' | null;
  checklist: string[];
  goalTitle: string | null;
}

const QUESTION_SYSTEM =
  '你是任务细谈助手。根据用户想做的事，每次只问一个最关键的问题（最多3轮）：' +
  '先问清【做什么/交付物】，再问【何时/截止】，再问【怎么做/拆步骤】。' +
  '每轮只输出一个问题，不超过40字。信息足够时不再提问，只输出"好了"。';

const DRAFT_SYSTEM = (today: string) =>
  '你是任务整理助手。根据细谈对话，为用户生成一个任务草稿。今天是 ' + today + '。' +
  '输出严格 JSON：{"title":"简短任务名","notes":"补充说明","due":"YYYY-MM-DD 或 null",' +
  '"remindTime":"HH:MM 或 null","repeat":"daily|weekly|monthly|weekdays 或 null",' +
  '"checklist":["步骤1","步骤2"],"goalTitle":"关联目标名或 null"}。' +
  '只输出 JSON，不要任何其他文字。';

/** 拼接细谈对话历史为单轮输入（RWKV 无多轮状态，手工拼）。 */
export function buildConsultInput(main: string, qa: { q: string; a: string }[]): string {
  let s = `用户想做：${main}`;
  for (const { q, a } of qa) s += `\n问：${q}\n答：${a}`;
  return s;
}

/** 追问下一问；返回 null 表示信息已足够（模型答"好了"或达到轮次上限）。 */
export async function nextQuestion(main: string, qa: { q: string; a: string }[]): Promise<string | null> {
  if (qa.length >= 3) return null;
  try {
    const out = await aiComplete(buildConsultInput(main, qa), QUESTION_SYSTEM, {
      temperature: 1.0,
      topP: 0.3,
      maxTokens: 80,
    });
    const line = out.trim().split('\n')[0].slice(0, 60).trim();
    if (!line || /^好了|^好了。|^好了！/.test(line)) return null;
    return line;
  } catch {
    return null;
  }
}

/** 由细谈对话生成任务草稿。 */
export async function generateDraft(main: string, qa: { q: string; a: string }[]): Promise<ConsultDraft | null> {
  try {
    const out = await aiComplete(buildConsultInput(main, qa), DRAFT_SYSTEM(todayStr()), {
      temperature: 1.0,
      topP: 0.1,
      maxTokens: 700,
    });
    const parsed = extractJson(out) as Partial<ConsultDraft> | null;
    if (!parsed || typeof parsed.title !== 'string' || !parsed.title.trim()) return null;
    const dueOk = typeof parsed.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due);
    const timeOk = typeof parsed.remindTime === 'string' && /^\d{2}:\d{2}$/.test(parsed.remindTime);
    return {
      title: parsed.title.trim().slice(0, 80),
      notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 200) : '',
      due: dueOk ? (parsed.due as string) : null,
      remindTime: timeOk ? (parsed.remindTime as string) : null,
      repeat:
        parsed.repeat === 'daily' || parsed.repeat === 'weekly' || parsed.repeat === 'monthly' || parsed.repeat === 'weekdays'
          ? parsed.repeat
          : null,
      checklist: Array.isArray(parsed.checklist)
        ? parsed.checklist.filter((s) => typeof s === 'string' && s.trim()).slice(0, 7).map((s) => String(s).trim().slice(0, 40))
        : [],
      goalTitle: typeof parsed.goalTitle === 'string' && parsed.goalTitle.trim() ? parsed.goalTitle.trim().slice(0, 30) : null,
    };
  } catch {
    return null;
  }
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

export async function draftPlan(title: string, why: string, deadline: string | null): Promise<PlanDraft | null> {
  const today = todayStr();
  try {
    const out = await aiComplete(
      `志向：${title}${why ? `（${why}）` : ''}${deadline ? `，截止 ${deadline}` : ''}`,
      '你是谋士。为给定志向拟定实施方案：先给 2-4 段简明策略（每段不超过80字），' +
        '再划 2-4 个阶段，最后给 3-7 个可执行任务（标注所属阶段序号，0=未分阶段，及日期）。今天是 ' + today + '。' +
        '输出严格 JSON：{"plan":["策略段1","策略段2"],"milestones":["阶段1","阶段2"],' +
        '"tasks":[{"title":"任务名","due":"YYYY-MM-DD","milestone":1}]}。只输出 JSON，不要任何其他文字。',
      { temperature: 1.0, maxTokens: 1100 }
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
      { temperature: 1.0, maxTokens: 200 }
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
