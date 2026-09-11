/**
 * todo 规划对话 AI 通道（拆解 / 规划对话 / 拟策 / 日终回顾）——走 `plugin_ai_complete`
 * 命令，核心 id `com.ai00x.core.todo` 豁免插件 gate（plugin_api.rs
 * CORE_FEATURE_IDS）。讨论/规划默认远程主模型（ai00-salvo），可在
 * ModelSelector 手切本地（auto = 本地 RWKV 优先 + primary 回退；
 * Instruction 格式 + few-shot 示范 + T≈0.6/P≈0.1）。
 * model 引用可选透传（'auto' 不传 = 本地 RWKV 优先；其余引用见
 * plugin_api.rs resolve_model_selection）。
 *
 * 规划工具环（planChatReplyWithTools）：讨论轮可让模型调用只读三件套
 * （read_file / list_dir / search）实地查看绑定的项目文件——前端执行后把
 * 结果以材料行回注重呼；出计划单发（plan 模式）不挂工具，保持两段式稳定。
 */
import { invoke } from '@tauri-apps/api/core';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';

const CORE_ID = 'com.ai00x.core.todo';

/** 一条直通消息（plugin_ai_complete 的 messages 模式）。 */
export interface AiMsg {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export async function aiComplete(
  prompt: string,
  systemPrompt: string,
  opts?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    model?: string;
    tag?: string;
    messages?: AiMsg[];
    presencePenalty?: number;
    frequencyPenalty?: number;
    /** 覆盖引擎默认停止序列（围栏收尾截断等） */
    stops?: string[];
  }
): Promise<string> {
  const res = await invoke<{ text?: string }>('plugin_ai_complete', {
    request: {
      pluginId: CORE_ID,
      prompt,
      systemPrompt,
      temperature: opts?.temperature ?? 0.9,
      topP: opts?.topP ?? 0.1,
      maxTokens: opts?.maxTokens ?? 4096,
      ...(opts?.messages ? { messages: opts.messages } : {}),
      ...(opts?.presencePenalty != null ? { presencePenalty: opts.presencePenalty } : {}),
      ...(opts?.frequencyPenalty != null ? { frequencyPenalty: opts.frequencyPenalty } : {}),
      ...(opts?.stops?.length ? { stop: opts.stops } : {}),
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

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ===== 策 v3 看板规划对话（需求卡 → 讨论计划） =====

import type { BoardPlan, PlanChatMessage, PlanChatQuestion } from '../api/types';

/** 清洗单条消息作为「材料」：压平换行（RWKV 对 \n\n 空行敏感，易诱发续写幻觉）、去多余空白与角色前缀残留。 */
function cleanMaterial(text: string): string {
  return text
    .replace(/\r?\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^(用户|助手|System|User|Assistant|Instruction)[:：]\s*/i, '')
    .trim()
    .slice(0, 300);
}

/** 把一条助手消息重新渲染为协议 JSON 原文（官方 few-shot 要义：历史中每个助手回合都在示范目标格式；
 *  散文降级的旧回复没有 questions 可依，只能保留原样）。与示范对/预填统一用 ```json 围栏包裹。
 *  不携带 ready 字段——协议已改为 create_plan 工具调用，避免历史教模型模仿旧协议。 */
function aiMsgToProtocolJson(m: PlanChatMessage): string {
  if (!m.questions?.length) return cleanMaterial(m.text);
  const payload = {
    reply: m.text,
    questions: m.questions.map((q) => ({
      q: q.q,
      options: q.options,
      ...(q.allowInput ? { allowInput: true } : {}),
    })),
  };
  return '```json\n' + JSON.stringify(payload) + '\n```';
}

/** 用户交权话术：命中说明用户已放弃「被追问」，可提示模型调用工具。 */
export const DELEGATION_RE = /不用问|别问了|直接安排|你安排|你来安排|你决定|直接拟|开始吧|可以了|就这样/;

/** 快思考预填（官方 G1 格式：<think> + 换行 + </think>）。生成从 </think> 后立即开始。 */
const THINK_PREFILL: AiMsg = { role: 'assistant', content: '<think>\n</think>\n```json' };

/**
 * 组装规划对话的多消息 few-shot 输入（rwkv-rsv 本地实验 2026-08-27 结论）：
 * G1 模型对 JSON 协议的服从度由「User/Assistant 对话形态的示范」决定，
 * Instruction 骨架层几乎无效；协议说明放首个 User 轮 + 两个示范对 +
 * 历史助手回合以协议 JSON 原形出现，最后以 Assistant: <think>\n</think>
 * 快思考预填收尾（官方文档：快思考质量优于不思考；实测 JSON 质变）。
 * 实质单发——历史全部作为最后一条 User 材料注入；
 * 最近 6 条全文保留，更早的每条压到 40 字并入「此前讨论要点」。
 *
 * 讨论模式是三态工具协议：信息不足 → questions 追问；信息足够 → 模型
 * 主动调用 create_plan 工具（arguments 即完整计划契约），前端执行落盘；
 * 已绑定工作区时追加只读三件套（read_file/list_dir/search）供实地查看
 * 项目文件——工具由前端执行、结果回注，出计划单发不挂工具。
 */

/** 只读三件套协议行（仅已绑定工作区的讨论轮注入）。 */
const TOOL_PROTOCOL_LINE =
  '\n三、需要实际查看项目文件再定稿时，可调用只读工具（系统执行后把结果提供给你，再按一/二/三继续）：' +
  '{"tool":"read_file","path":"相对工作区的文件路径"} 读文件内容；' +
  '{"tool":"list_dir","path":"相对工作区的目录路径"} 列目录（省略 path 列根目录）；' +
  '{"tool":"search","query":"关键词"} 在工作区内全文搜索。';
function buildPlanChatMessages(
  title: string,
  notes: string,
  chat: PlanChatMessage[],
  currentPlan?: BoardPlan | null,
  mode: 'chat' | 'plan' = 'chat',
  planHint?: string,
  /** 已绑定工作区（讨论轮协议追加只读三件套；plan 模式不挂工具） */
  hasWorkspace?: boolean
): AiMsg[] {
  if (mode === 'plan') {
    const schema =
      '{"summary":"一段话摘要","goal":"一句话目标","tasks":[{"title":"步骤名","notes":"补充"}],"acceptance":["验收1","验收2"],"deliverable":"交付物描述"}';
    if (currentPlan) {
      // —— 计划编辑器（专用修改格式，用户定稿 2026-08-28）：当前计划 JSON +
      // 修改意见 → 更新后的完整计划 JSON。JSON 进 JSON 出、schema 完全一致，
      // 避免全文再生成时的模式竞争（tasks 劣化为字符串数组的实测教训）——
      const msgs: AiMsg[] = [
        {
          role: 'user',
          content:
            `你是计划编辑器。根据用户的修改意见更新给定的计划 JSON。回复协议：只输出更新后的完整计划 JSON（用 \`\`\`json 围栏包裹），schema：${schema}。用户没有提到的部分原样保留；tasks 每一项必须是含 title 键的对象，绝不能是字符串数组；acceptance 给3-6项可客观检验的判据；deliverable 必填且具体——写明可交付的产物文件名与内容形式（如 "report.md 调研报告"、"报销明细.md + 发票扫描件.zip"），即使纯咨询/调研类任务也必须产出一份汇报文件。` +
            (planHint ? `\n额外要求：${planHint}` : ''),
        },
        {
          role: 'assistant',
          content:
            '```json\n{"summary":"汇总本季报销票据并当面提交财务","goal":"周五前完成报销提交","tasks":[{"title":"核对三张发票金额","notes":""},{"title":"录入财务系统","notes":""},{"title":"周五当面提交给财务","notes":"替代原电话跟进"}],"acceptance":["金额与票据一致","周五完成当面提交"],"deliverable":"报销明细.md 提交清单"}\n```',
        },
        {
          role: 'user',
          content:
            '当前计划：{"summary":"汇总本季报销票据并提交财务系统","goal":"周五前完成报销提交","tasks":[{"title":"核对三张发票金额","notes":""},{"title":"录入财务系统","notes":""},{"title":"跟进部门审批","notes":"周五前完成"}],"acceptance":["金额与票据一致","系统状态为已提交"],"deliverable":"季度报销单"}\n修改意见：第三步审批不用了，改成周五当面提交给财务。其他都不变。',
        },
        {
          role: 'assistant',
          content:
            '```json\n{"summary":"汇总本季报销票据并当面提交财务","goal":"周五前完成报销提交","tasks":[{"title":"核对三张发票金额","notes":""},{"title":"录入财务系统","notes":""},{"title":"周五当面提交给财务","notes":""}],"acceptance":["金额与票据一致","周五完成当面提交"],"deliverable":"报销明细.md 提交清单"}\n```',
        },
      ];
      let s = `当前计划：${JSON.stringify(currentPlan)}\n修改意见与讨论：`;
      s = appendHistory(s, compressedChat(chat, true), { user: '用户', ai: '助手' });
      msgs.push({ role: 'user', content: s });
      msgs.push(THINK_PREFILL);
      return msgs;
    }
    // —— 出计划（从零创建）：协议说明 + 一个示范对 ——
    const msgs: AiMsg[] = [
      {
        role: 'user',
        content:
          `你是规划助手，根据需求和讨论拟定计划契约。回复协议：只输出一个 JSON（用 \`\`\`json 围栏包裹）：${schema}。tasks 给3-7个按推进顺序，每一项必须是含 title 键的对象（如 {"title":"步骤名"}），绝不能是字符串数组；acceptance 是可客观检验的完成判据，给3-6项；deliverable 必填且具体——写明可交付的产物文件名与内容形式（如 "report.md 调研报告"、"summary.md 总结"），即使纯咨询/调研类任务也必须产出一份汇报文件；只依据材料里的信息。所有字段必须填与需求相关的具体内容，禁止照抄示例占位词（如"步骤名""补充""验收1"）；title 不要带 [in_progress]/[pending] 等状态标记；回复的第一个字符必须是 { ，最后一个字符必须是 } 。` +
          (planHint ? `\n额外要求：${planHint}` : ''),
      },
      {
        role: 'assistant',
        content:
          '```json\n{"summary":"汇总本季报销票据并提交财务系统","goal":"完成本季度报销提交","tasks":[{"title":"核对三张发票金额","notes":""},{"title":"录入财务系统","notes":""},{"title":"跟进部门审批","notes":""}],"acceptance":["金额与票据一致","系统状态为已提交"],"deliverable":"报销明细.md 提交清单"}\n```',
      },
    ];
    let s = `规划任务：${title}${notes ? `（${cleanMaterial(notes)}）` : ''}。这是需求与已有讨论：`;
    s = appendHistory(s, compressedChat(chat, true), { user: '用户说', ai: '助手回复' });
    msgs.push({ role: 'user', content: s });
    msgs.push(THINK_PREFILL);
    return msgs;
  }
  // —— 讨论轮：按有无计划分两种接地形态（用户实测反馈：已有计划时讨论
  // 仍停在需求澄清形态，模型反复问已答过的问题造成循环——有计划必须
  // 针对计划文件对话）——
  // create_plan 哨兵式调用的实验依据见下方各注释（tool1/2/3/3h 组）：
  // G1 双态大 schema 单发不可靠，极短哨兵 + 计划专用单发补参数（30/30）。
  let msgs: AiMsg[];
  let s: string;
  if (currentPlan) {
    // —— 计划接地模式：协议/示范/材料全部围绕当前计划 ——
    msgs = [
      {
        role: 'user',
        content:
          '你是规划助手，卡片已有一份计划（材料中给出）。与用户讨论这份计划的调整，你拥有工具 create_plan（更新计划文件）。回复协议：只输出一个 JSON（用 ```json 围栏包裹），按情形回复：\n' +
          '一、用户的调整意向不明确，先追问：{"reply":"简短回应","questions":[{"q":"关键问题","options":["选项1","选项2"],"allowInput":true}]}。questions 最多2个问题，每个配2-4个候选项。\n' +
          '二、用户给出了明确的调整（或认可现状），调用工具：{"tool":"create_plan"}。只输出这个 JSON，不要附加计划内容，系统会按讨论结论更新计划文件。' +
          (hasWorkspace ? TOOL_PROTOCOL_LINE : ''),
      },
      {
        role: 'assistant',
        content:
          '```json\n{"reply":"好的，确认一下第三步想怎么调。","questions":[{"q":"第三步想怎么调整","options":["换成轻松的活动","时间往后挪","直接删掉"],"allowInput":true}]}\n```',
      },
      { role: 'user', content: '当前计划（讨论以此为准）：\n目标：周末前完成报销提交\n摘要：整理发票并提交财务系统\n步骤：1. 核对三张发票金额；2. 录入财务系统；3. 跟进部门审批\n验收：金额与票据一致；系统状态为已提交\n\n用户：嗯第三步太赶了，把审批挪到下周吧，其他都不变，直接改。' },
      {
        role: 'assistant',
        content: '```json\n{"tool":"create_plan"}\n```',
      },
    ];
    const steps = currentPlan.tasks.map((t, i) => `${i + 1}. ${t.title}${t.notes ? `（${t.notes}）` : ''}`).join('；');
    s =
      `当前计划（讨论以此为准）：\n目标：${currentPlan.goal || currentPlan.summary}\n` +
      (currentPlan.summary ? `摘要：${currentPlan.summary}\n` : '') +
      (steps ? `步骤：${steps}\n` : '') +
      (currentPlan.acceptance.length ? `验收：${currentPlan.acceptance.join('；')}\n` : '') +
      (currentPlan.deliverable ? `交付物：${currentPlan.deliverable}\n` : '');
    s += `\n需求：${title}${notes ? `（${cleanMaterial(notes)}）` : ''}`;
    s = appendHistory(s, compressedChat(chat), { user: '用户', ai: '助手' });
    // 充分性信号（与需求澄清模式同机制）：已回答 AI 的追问 / 明确调整意向 → 应调工具
    const lastMsgM = chat[chat.length - 1];
    const lastAiMsgM = [...chat].reverse().find((m) => m.role === 'ai');
    if (lastMsgM?.role === 'user' && lastAiMsgM?.questions?.length) {
      s += '\n（用户刚刚已回答了上面的问题，不要重复提问；调整意向已明确，此时应调用工具更新计划。）';
    } else if (lastMsgM?.role === 'user' && DELEGATION_RE.test(lastMsgM.text)) {
      s += '\n（用户已明确表达调整意向，此时应调用工具更新计划。）';
    }
  } else {
    // —— 需求澄清模式（无计划）：create_plan 工具协议（哨兵式调用）+ 两个追问示范对 ——
    msgs = [
      {
        role: 'user',
        content:
          '你是规划助手，与用户讨论需求，你拥有工具 create_plan（创建计划文件）。回复协议：只输出一个 JSON（用 ```json 围栏包裹），按情形回复：\n' +
          '一、信息不足，先追问：{"reply":"简短回应","questions":[{"q":"关键问题","options":["选项1","选项2"],"allowInput":true}]}。questions 最多2个问题，每个配2-4个候选项。\n' +
          '二、信息足够（时间/数量/方式等关键信息已明确，或用户已表示无需追问），调用工具：{"tool":"create_plan"}。只输出这个 JSON，不要附加计划内容，系统会自动生成计划文件。' +
          (hasWorkspace ? TOOL_PROTOCOL_LINE : ''),
      },
      {
        role: 'assistant',
        content:
          '```json\n{"reply":"好的，先确认发票状态。","questions":[{"q":"发票现在的情况","options":["都已收齐","还差几张","还没整理"],"allowInput":true}]}\n```',
      },
      { role: 'user', content: '需求：整理报销发票。情况我还没梳理，回头看看再说。' },
      {
        role: 'assistant',
        content:
          '```json\n{"reply":"好的，不着急。","questions":[{"q":"大概什么时候要提交","options":["本周内","月底前","还没定"],"allowInput":true},{"q":"大概几张发票","options":["三五张","十张左右","不确定"],"allowInput":false}]}\n```',
      },
    ];
    s = `需求：${title}${notes ? `（${cleanMaterial(notes)}）` : ''}`;
    s = appendHistory(s, compressedChat(chat), { user: '用户', ai: '助手' });
    // 材料级充分性信号（模型自身不会判「信息足够」，tool3/3h 组实测）：
    // a) 上一条 AI 消息带 questions 且用户已作答 → 禁止重复提问，应调工具
    //    （否则模型跟最近示范再问一轮 = 用户实测的「反复询问同样问题」循环）
    // b) 用户明确交权话术 → 应调工具
    const lastMsg = chat[chat.length - 1];
    const lastAiMsg = [...chat].reverse().find((m) => m.role === 'ai');
    if (lastMsg?.role === 'user' && lastAiMsg?.questions?.length) {
      s += '\n（用户刚刚已回答了上面的问题，不要重复提问；关键信息视为足够，此时应调用工具。）';
    } else if (lastMsg?.role === 'user' && DELEGATION_RE.test(lastMsg.text)) {
      s += '\n（用户已明确表示无需继续追问，关键信息视为足够，此时应调用工具。）';
    }
  }
  msgs.push({ role: 'user', content: s });
  msgs.push(THINK_PREFILL);
  return msgs;
}

/**
 * 围栏收尾停止序列：替代引擎默认组。返回文本 = ```json 围栏内的一份 JSON，
 * 遇闭合围栏立即截断；同时保留角色标记兜底（防围栏缺失时无限续写）。
 */
const FENCE_STOPS: string[] = ['\n```', '\n\nUser:', '\n\nSystem:', '\n\nInstruction:', '\n\nInput:', '\n\nAssistant:'];

/**
 * 压缩历史（用户定稿 2026-08-27：RWKV 多轮弱，历史别加太多——实质单轮）：
 * 只保留最近 2 条原文（最后一问一答，这是模型的直接操作对象），
 * 更早的每条压到 30 字、最多 4 条并入「此前讨论要点」一行。
 */
function compressedChat(
  chat: PlanChatMessage[],
  /** plan 模式传 true：历史助手行用纯文本。实验（fence-plan2 组 17/30）证明
   *  讨论协议的围栏 JSON 进入出计划材料会喧宾夺主——模型跟最近的模式，
   *  照抄讨论 schema 导致计划 JSON 崩坏；纯文本则不构成模式竞争。 */
  plainAssistant = false
): Array<{ kind: 'digest' | 'msg'; role?: 'user' | 'ai'; text: string }> {
  const recentCount = 2;
  const recentStart = Math.max(0, chat.length - recentCount);
  // 摘要从原始文本取（纯文本）——截断的围栏 JSON 进材料会教模型模仿坏模式
  const older = chat.slice(0, recentStart).slice(-4);
  const recent = chat.slice(recentStart).map((m) => ({
    kind: 'msg' as const,
    role: m.role as 'user' | 'ai',
    text: m.role === 'ai' ? (plainAssistant ? cleanMaterial(m.text) : aiMsgToProtocolJson(m)) : cleanMaterial(m.text),
  }));
  if (!older.length) return recent;
  const digest = {
    kind: 'digest' as const,
    text: older.map((m) => `${m.role === 'user' ? '用户' : '助手'}说${cleanMaterial(m.text).slice(0, 30)}`).join('；'),
  };
  return [digest, ...recent];
}

/** 把压缩历史渲染进真实 User 材料行。 */
function appendHistory(s: string, list: Array<{ kind: 'digest' | 'msg'; role?: 'user' | 'ai'; text: string }>, labels: { user: string; ai: string }): string {
  let out = s;
  for (const m of list) {
    if (m.kind === 'digest') out += `\n此前讨论要点：${m.text}`;
    else out += `\n${m.role === 'user' ? labels.user : labels.ai}：${m.text}`;
  }
  return out;
}

// ===== 两段式·第一段：讨论澄清（每轮单发，只让模型干一件小事）=====
// 提示词已并入 buildPlanChatMessages 的 few-shot 对话形态（rwkv-rsv 实验结论）。

/** 讨论轮次结果：questions=继续追问；tool='create_plan'=模型调用工具（plan 为
 *  工具参数归一化后的计划契约）。ready 保留为兼容回退标记（旧协议输出）。
 *  只读三件套（read_file/list_dir/search）：模型请求查看项目文件，由
 *  planChatReplyWithTools 前端执行回注。 */
export interface PlanChatTurn {
  reply: string;
  questions?: PlanChatQuestion[];
  ready?: boolean;
  tool?: 'create_plan' | 'read_file' | 'list_dir' | 'search';
  plan?: BoardPlan;
  /** read_file/list_dir 的相对工作区路径 */
  path?: string;
  /** search 的关键词 */
  query?: string;
}

/** 把模型输出的计划契约片段归一化为 BoardPlan；summary 缺失返回 null。 */
function normalizePlan(parsed: Partial<BoardPlan> | null | undefined, title: string): BoardPlan | null {
  if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null;
  // 模型把 todo 状态标记泄进步骤标题（实测 2026-08-29：**[in_progress]** 前缀）
  const stripStatusMarks = (s: string) =>
    s.replace(/\*\*\s*\[[a-z_]+\]\s*\*\*\s*/gi, '').replace(/\[[a-z_]+\]\s*/gi, '').trim();
  // schema 占位字面值（实测 2026-08-29：模型照抄模板骨架未填充 → 整份拒收，
  // 让上层提示重试，防止垃圾计划落盘）
  const PLACEHOLDER_STEP = new Set(['步骤名', '补充', '待补充', 'todo', '待定']);
  const PLACEHOLDER_ACCEPT = new Set(['验收1', '验收2', '验收3', '验收项', '验收条件']);
  const PLACEHOLDER_TEXT = new Set(['一段话摘要', '一句话目标', '交付物或null']);
  const normPh = (s: string) => s.replace(/[：:\s。]+$/g, '');
  const summary = stripStatusMarks(parsed.summary);
  if (!summary || PLACEHOLDER_TEXT.has(normPh(summary))) return null;
  const goalRaw =
    typeof parsed.goal === 'string' && parsed.goal.trim() ? stripStatusMarks(parsed.goal) : '';
  if (goalRaw && PLACEHOLDER_TEXT.has(normPh(goalRaw))) return null;
  const rawTasks: unknown[] = Array.isArray(parsed.tasks) ? (parsed.tasks as unknown[]) : [];
  const tasks = rawTasks
    .map((t): { title: string; notes?: string } | null => {
      // 容忍字符串数组形态（生产实测劣化：tasks 变 ["a","b"]）→ 直接转 title
      if (typeof t === 'string') {
        const s = stripStatusMarks(t);
        return s ? { title: s.slice(0, 80) } : null;
      }
      if (t && typeof t === 'object' && typeof (t as { title?: unknown }).title === 'string' && (t as { title: string }).title.trim()) {
        const obj = t as { title?: unknown; notes?: unknown };
        const clean = stripStatusMarks(String(obj.title));
        if (!clean || PLACEHOLDER_STEP.has(normPh(clean))) return null; // 占位步骤丢弃
        // notes 容忍数组形态（实测 2026-08-29：模型输出 "notes":["..."]）→ join 成串
        const notesStr = Array.isArray(obj.notes)
          ? (obj.notes as unknown[]).filter((n) => typeof n === 'string').join('；')
          : typeof obj.notes === 'string'
            ? obj.notes
            : '';
        return {
          title: clean.slice(0, 80),
          notes: notesStr ? notesStr.slice(0, 200) : undefined,
        };
      }
      return null;
    })
    .filter((t): t is { title: string; notes?: string } => t !== null)
    .slice(0, 7);
  if (!tasks.length) return null; // 全是占位/空步骤 → 整份拒收
  const acceptance = Array.isArray(parsed.acceptance)
    ? parsed.acceptance
        // 模型把多条验收塞进一条（实测："验收1；验收2；验收3"）→ 按分号拆分
        .flatMap((s) => (typeof s === 'string' ? s.split(/[；;]/) : []))
        .map((s) => stripStatusMarks(s))
        .filter((s) => s.trim() && !PLACEHOLDER_ACCEPT.has(normPh(s)))
        .slice(0, 6)
        .map((s) => s.trim().slice(0, 80))
    : [];
  return {
    summary: summary.slice(0, 400),
    goal: goalRaw && goalRaw.trim() ? goalRaw.trim().slice(0, 120) : title.slice(0, 120),
    tasks,
    acceptance,
    ...(typeof parsed.deliverable === 'string' && parsed.deliverable.trim()
      ? { deliverable: parsed.deliverable.trim().slice(0, 120) }
      : {}),
  };
}

/**
 * 规划对话一轮讨论回复（双态工具协议：澄清追问 or 模型调用 create_plan 工具）。
 * 模型调用工具时返回 { tool:'create_plan', plan }，由调用方执行落盘——
 * 计划文件的创建决定权在模型，不在前端流程。
 * JSON 解析失败时降级为纯文本 reply（本地 RWKV 偶发不守格式）。
 * tag = todo:chat:{goalId|none}（用量记账归志）。
 */
/** 计划接地：把工作区概况注入首条 user 材料（代码类任务的计划必须与真实目录一致）。 */
function injectWorkspaceSummary(messages: AiMsg[], workspaceSummary?: string | null): void {
  const s = workspaceSummary?.trim();
  if (!s) return;
  const first = messages[0];
  if (first && first.role === 'user' && typeof first.content === 'string') {
    messages[0] = {
      ...first,
      content: `【工作区概况（真实目录/README/近期提交——计划必须与之匹配）】\n${s.slice(0, 2500)}\n\n${first.content}`,
    };
  }
}

export async function planChatReply(
  title: string,
  notes: string,
  chat: PlanChatMessage[],
  model?: string,
  goalId?: string | null,
  currentPlan?: BoardPlan | null,
  workspaceSummary?: string | null,
  /** 已绑定工作区目录（有值=讨论轮协议开放只读三件套） */
  cwd?: string | null,
  /** 工具结果材料行（工具环重呼时追加到最后一条 user 材料） */
  extraMaterial?: string
): Promise<PlanChatTurn | null> {
  try {
    const messages = buildPlanChatMessages(title, notes, chat, currentPlan, 'chat', undefined, !!cwd);
    injectWorkspaceSummary(messages, workspaceSummary);
    // 工具结果回注（在 THINK_PREFILL 前的最后一条 user 材料尾部追加）
    const extra = extraMaterial?.trim();
    if (extra) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser) lastUser.content = `${lastUser.content}\n${extra}`;
    }
    const out = await aiComplete('', '', {
      messages,
      temperature: 0.6,
      topP: 0.1,
      // 模型在讨论轮直接带完整计划 arguments 时也要写得下（900 会截断 JSON）
      maxTokens: 2048,
      // 近贪心采样（top_p≈0.1）下长 JSON 必现复读循环，惩罚压制
      // （rwkv-rsv 实验 pl-prod-*：遵循率 5/6→6/6）
      presencePenalty: 0.5,
      frequencyPenalty: 0.5,
      // 预填开启 ```json 围栏，遇闭合围栏即停——截断失控续写
      stops: FENCE_STOPS,
      model,
      tag: `todo:chat:${goalId ?? 'none'}`,
    });
    const fallback = (): string | null => {
      // 截断模型幻觉的角色标记/续写（Instruction 格式单发常见）
      const text = out.split(/\n\s*\n(?=.)|System:|User:|Assistant:|Instruction:|Response:/)[0].replace(/\s+/g, ' ').trim();
      return text ? text.slice(0, 300) : null;
    };
    const parsed = extractJson(out) as
      | { tool?: unknown; arguments?: Partial<BoardPlan>; reply?: unknown; questions?: unknown[]; ready?: unknown; summary?: unknown; path?: unknown; query?: unknown }
      | null;
    // 只读三件套判定（工具环由 planChatReplyWithTools 执行回注）
    if (
      parsed &&
      (parsed.tool === 'read_file' || parsed.tool === 'list_dir' || parsed.tool === 'search')
    ) {
      return {
        reply: typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 300) : '',
        tool: parsed.tool,
        ...(typeof parsed.path === 'string' && parsed.path.trim()
          ? { path: parsed.path.trim().slice(0, 300) }
          : {}),
        ...(typeof parsed.query === 'string' && parsed.query.trim()
          ? { query: parsed.query.trim().slice(0, 120) }
          : {}),
      };
    }
    // 工具调用判定（决策信号优先，参数可缺——由计划专用单发补齐）：
    // a) JSON 可解析且 tool=create_plan；b) JSON 坏但含 create_plan 标记
    // （tool3h 组 2/10：模型调对了工具却附加嵌套 payload 括号断裂——
    // 决策有效，标记即认）；c) 模型漏写 tool 直接吐计划契约（summary 可解析）
    if (parsed && parsed.tool === 'create_plan') {
      const plan = normalizePlan(parsed.arguments, title);
      if (plan) return { reply: typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 300) : '', tool: 'create_plan', plan };
      return { reply: '', tool: 'create_plan' };
    }
    if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) {
      const plan = normalizePlan(parsed as Partial<BoardPlan>, title);
      if (plan) return { reply: typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 300) : '', tool: 'create_plan', plan };
    }
    if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
      if (/create_plan/.test(out)) return { reply: '', tool: 'create_plan' };
      console.warn('[todo:chat] JSON 解析失败，降级散文。原始输出前 240 字：', out.slice(0, 240));
      const text = fallback();
      return text ? { reply: text } : null;
    }
    // ready 归一化：模型偶发输出字符串 "true"（旧协议兼容回退）
    const readyFlag = parsed.ready === true || parsed.ready === 'true';
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions
          .map((q) => q as { q?: unknown; options?: unknown; allowInput?: unknown })
          .filter((q) => typeof q.q === 'string' && q.q.trim() && Array.isArray(q.options))
          .slice(0, 2)
          .map((q) => ({
            q: String(q.q).trim().slice(0, 60),
            options: (q.options as unknown[])
              .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
              .slice(0, 4)
              .map((o) => o.trim().slice(0, 20)),
            ...(typeof q.allowInput === 'boolean' && q.allowInput ? { allowInput: true as const } : {}),
          }))
          .filter((q) => q.options.length >= 2)
      : [];
    return {
      reply: parsed.reply.trim().slice(0, 300),
      ...(questions.length && !readyFlag ? { questions } : {}),
      ...(readyFlag ? { ready: true as const } : {}),
    };
  } catch (e) {
    // 通道级失败（模型懒启动失败/显存不足/后端拒绝等）上抛给调用方展示具体
    // 原因——此前静默吞成 null，用户只见「AI 暂时没有回应」无法定位
    // （2026-09-01 实测：Qwen3.8 27B 显存不足被吞成笼统报错）。
    console.warn('[todo:chat] AI 通道失败：', e);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

// ===== 规划工具环：只读三件套前端执行（read_file / list_dir / search）=====

/** 工具环最多执行的工具次数（超出后强制最后一呼收束到回复或 create_plan）。 */
export const PLAN_TOOL_ROUNDS = 4;

/** 单条工具结果材料截断（字）——控制重呼 token 预算。 */
const TOOL_RESULT_MAX_CHARS = 3000;

/** 工作区路径安全归一化：拒绝绝对路径与 .. 逃逸；空 rel = 根目录。 */
function safeJoinWorkspace(cwd: string, rel: string | undefined): string | null {
  const raw = (rel ?? '').trim().replace(/\\/g, '/');
  if (/^([a-zA-Z]:|\/)/.test(raw)) return null;
  const parts = raw.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  const sep = cwd.includes('\\') ? '\\' : '/';
  return cwd.replace(/[\\/]+$/, '') + sep + parts.join(sep);
}

/** 工具调用的人话标签（UI 反馈与材料行头共用）。 */
function planToolLabel(turn: PlanChatTurn): string {
  const arg = turn.tool === 'search' ? turn.query ?? '' : turn.path ?? '';
  if (turn.tool === 'read_file') return `read_file ${arg}`;
  if (turn.tool === 'list_dir') return `list_dir ${arg || '.'}`;
  return `search "${arg}"`;
}

/** 执行一次只读工具调用（cwd 已由调用方保证非空）。 */
async function execPlanTool(turn: PlanChatTurn, cwd: string): Promise<string> {
  if (turn.tool === 'read_file') {
    const p = safeJoinWorkspace(cwd, turn.path);
    if (!p) return '（路径非法：须为工作区内相对路径，且不得包含 ..）';
    const content = await workspaceAPI.readFileContent(p);
    if (!content) return '（空文件）';
    return content.length > TOOL_RESULT_MAX_CHARS
      ? content.slice(0, TOOL_RESULT_MAX_CHARS) + `\n…（已截断，原文 ${content.length} 字）`
      : content;
  }
  if (turn.tool === 'list_dir') {
    const p = safeJoinWorkspace(cwd, turn.path);
    if (!p) return '（路径非法：须为工作区内相对路径，且不得包含 ..）';
    const nodes = await workspaceAPI.getDirectoryChildren(p);
    if (!nodes.length) return '（空目录）';
    const lines = nodes.slice(0, 100).map((n) => (n.isDirectory ? `${n.name}/` : n.name));
    return (
      lines.join('\n') +
      (nodes.length > 100 ? `\n…（共 ${nodes.length} 项，仅列前 100）` : '')
    );
  }
  // search
  const q = (turn.query ?? '').trim();
  if (!q) return '（缺少搜索关键词）';
  const results = await workspaceAPI.searchContentOnly(cwd, q, false, false, false, undefined, 20);
  if (!results.length) return '（无匹配结果）';
  // 绝对路径剥 cwd 前缀显示（省 token；未命中前缀原样保留）
  const prefix = cwd.replace(/[\\/]+$/, '');
  const strip = (p: string) =>
    p.startsWith(prefix) ? p.slice(prefix.length).replace(/^[\\/]/, '') : p;
  const lines = results
    .slice(0, 20)
    .map((r) => {
      const snippet = (r.matchedContent ?? r.previewInside ?? '').trim().slice(0, 120);
      return `${strip(r.path)}${r.lineNumber ? `:${r.lineNumber}` : ''}: ${snippet}`;
    });
  return lines.join('\n');
}

/**
 * 规划讨论的工具环包装：模型请求只读三件套时前端执行 → 结果以
 * 「【工具结果 …】」材料行回注重呼，直至普通回复或 create_plan；
 * 上限 PLAN_TOOL_ROUNDS 次，超限最后一呼强制收束（工具调用被丢弃，
 * 只保留散文回复）。cwd 为空（未绑定工作区）直接透传 planChatReply。
 * onTool = 工具执行回调（UI 反馈「翻阅项目文件…」用）。
 */
export async function planChatReplyWithTools(
  title: string,
  notes: string,
  chat: PlanChatMessage[],
  model?: string,
  goalId?: string | null,
  currentPlan?: BoardPlan | null,
  cwd?: string | null,
  workspaceSummary?: string | null,
  onTool?: (label: string) => void
): Promise<PlanChatTurn | null> {
  if (!cwd) return planChatReply(title, notes, chat, model, goalId, currentPlan, workspaceSummary);
  const toolNotes: string[] = [];
  for (let used = 0; used <= PLAN_TOOL_ROUNDS; used++) {
    const turn = await planChatReply(
      title,
      notes,
      chat,
      model,
      goalId,
      currentPlan,
      workspaceSummary,
      cwd,
      toolNotes.length ? toolNotes.join('\n\n') : undefined
    );
    if (!turn) return null;
    if (turn.tool !== 'read_file' && turn.tool !== 'list_dir' && turn.tool !== 'search') {
      return turn;
    }
    if (used === PLAN_TOOL_ROUNDS) {
      return turn.reply ? { reply: turn.reply } : null;
    }
    onTool?.(planToolLabel(turn));
    let result: string;
    try {
      result = await execPlanTool(turn, cwd);
    } catch (e) {
      result = `（工具执行失败：${e instanceof Error ? e.message : String(e)}）`;
    }
    toolNotes.push(`【工具结果 ${planToolLabel(turn)}】\n${result}`);
  }
  return null; // 不可达（循环必有返回）
}

// ===== 两段式·第二段：出计划（独立单发，专注产出计划契约 JSON）=====
// 提示词已并入 buildPlanChatMessages('plan') 的 few-shot 对话形态。

/**
 * 宽容修复模型 JSON 的常见劣化（仅主解析失败时兜底使用）：
 * 裸键缺值——如 `"notes"}` / `"notes",`（生产实测 2026-08-28：计划 tasks
 * 对象里出现无值的 notes 键导致整份 JSON 非法）→ 补成空串。
 * 带值的 `"notes":"x"` 后跟 `:` 不受影响；出现在字符串值里的同名词极罕见，
 * 且本函数只在正常解析失败后调用，不污染正常路径。
 */
function repairLooseJson(text: string): string {
  return text.replace(/"(notes|title|summary|goal|deliverable|q|reply)"(\s*[,}\]])/g, '"$1":""$2');
}

/**
 * 第三层兜底：JSON 彻底损坏时按字段名碎片重建计划契约。
 * 实测 2026-08-29：tasks 内对象提前闭合（notes 数组 + 多余键导致 `}` 错位，
 * 第二个 "title" 变成数组裸值）→ 整份 JSON 非法，但各键值字符串本身完整，
 * 可按出现顺序提取重建。summary 缺失返回 null。
 */
function rebuildPlanFromFragments(text: string): Partial<BoardPlan> | null {
  const unescape = (s: string) => {
    try {
      return JSON.parse(`"${s}"`) as string;
    } catch {
      return s;
    }
  };
  const grabStr = (key: string) => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? unescape(m[1]).trim() : '';
  };
  const summary = grabStr('summary');
  const titles = [...text.matchAll(/"title"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/g)]
    .map((m) => unescape(m[1]).trim())
    .filter(Boolean);
  if (!summary || !titles.length) return null;
  // notes 按出现顺序收集（字符串或数组形态），与 titles 按序配对
  const notesList = [
    ...text.matchAll(
      /"notes"\s*:\s*(?:"((?:[^"\\\\]|\\\\.)*)"|\[((?:[^\]"]|"[^"]*")*)\])/g
    ),
  ].map((m) => {
    if (m[1] !== undefined) return unescape(m[1]);
    const items = [...(m[2] || '').matchAll(/"((?:[^"\\\\]|\\\\.)*)"/g)].map((x) => unescape(x[1]));
    return items.join('；');
  });
  const accMatch = text.match(/"acceptance"\s*:\s*\[([^\]]*)\]/);
  const acceptance = accMatch
    ? [...accMatch[1].matchAll(/"((?:[^"\\\\]|\\\\.)*)"/g)].map((m) => unescape(m[1]))
    : [];
  const deliverable = grabStr('deliverable');
  return {
    summary,
    goal: grabStr('goal'),
    tasks: titles.map((title, i) => ({ title, ...(notesList[i] ? { notes: notesList[i] } : {}) })),
    acceptance,
    ...(deliverable ? { deliverable } : {}),
  };
}

/** 由讨论材料生成看板计划契约（两段式第二段：ready 后单独单发）。 */
export async function generateBoardPlan(
  title: string,
  notes: string,
  chat: PlanChatMessage[],
  model?: string,
  goalId?: string | null,
  currentPlan?: BoardPlan | null,
  workspaceSummary?: string | null
): Promise<BoardPlan | null> {
  try {
    // 通用 agent 的验收指引（插件模块可带各自 planHint）
    const { AGENT_MODULES } = await import('../agent-modules');
    const planHint = AGENT_MODULES.find(m => m.id === 'agent')?.planHint;
    const reportFail = (message: string, out: string) => {
      console.warn(`[todo:plan] ${message}。原始输出前 240 字：`, out.slice(0, 240));
      // 失败样本上报 debug-log-server（scripts/debug-log-server.mjs），便于离线
      // 诊断模型输出不稳定问题；server 未启动时静默忽略
      fetch('http://127.0.0.1:7469/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'consult.ts:generateBoardPlan',
          message,
          data: { out: out.slice(0, 2000) },
          timestamp: Date.now(),
        }),
      }).catch(() => undefined);
    };
    // 自动重试：RWKV 小模型输出有随机性，占位模板/JSON 断裂常见于首发，
    // 重试通常即成功（用户手动重试的实证）；两次都失败才报"计划生成失败"
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const messages = buildPlanChatMessages(title, notes, chat, currentPlan, 'plan', planHint);
      injectWorkspaceSummary(messages, workspaceSummary);
      const out = await aiComplete('', '', {
        messages,
        temperature: 0.6,
        topP: 0.1,
        // 完整计划 JSON（summary/goal/tasks/acceptance/deliverable）较长，
        // 900 会截断导致 JSON 未闭合 → 解析失败；给足 4096（与 rwkv/远程默认一致），
        // 实际消耗由停止围栏（FENCE_STOPS）控制，不会真用满
        maxTokens: 4096,
        presencePenalty: 0.5,
        frequencyPenalty: 0.5,
        stops: FENCE_STOPS,
        model,
        tag: `todo:chat:${goalId ?? 'none'}`,
      });
      // 三层解析：JSON.parse → 宽容修复裸键 → 字段碎片重建
      // （生产实测 2026-08-29：tasks 内对象提前闭合致整份非法，但键值碎片完整）
      let parsed = extractJson(out) as Partial<BoardPlan> | null;
      if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
        parsed = extractJson(repairLooseJson(out)) as Partial<BoardPlan> | null;
      }
      if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
        parsed = rebuildPlanFromFragments(out);
      }
      if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
        reportFail(`第${attempt}/${MAX_ATTEMPTS}次计划 JSON 解析失败`, out);
        continue;
      }
      const plan = normalizePlan(parsed, title);
      if (plan) return plan;
      reportFail(`第${attempt}/${MAX_ATTEMPTS}次计划被拒收（占位内容/空步骤）`, out);
    }
    return null;
  } catch (e) {
    // 通道级失败留痕（不改 null 契约——调用方已按「计划生成失败」处理）
    console.warn('[todo:plan] AI 通道失败：', e);
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
