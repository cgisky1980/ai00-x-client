/**
 * 委托任务书组装（纯函数，策 + 工作台共用）。
 *
 * 2026-11-08 从 `tools/todo/hooks/useAgentDelegate.ts` 抽出：组装逻辑与「策」
 * 这个 UI 无关，工作台的默认任务场景 / 插件工作台会话需要同一份四段任务书
 * （目标 / 交付物 / 工具与资料 / 边界 + 完工与收尾），否则 loop 口径会分叉。
 *
 * 保持纯函数：不读 store、不调 Tauri，输入即输出——两处调用方各自解析上下文。
 */
import type { AIMemory } from '@/infrastructure/api/aiMemoryApi';
import {
  DELEGATE_BG_COMMAND_NOTICE,
  DELEGATE_BOOK_TITLE,
  DELEGATE_BOUNDARY_IDEA_POOL,
  DELEGATE_BOUNDARY_PLAN_FIRST,
  DELEGATE_COMPLETION_THREE_STEP,
  DELEGATE_COMPLETION_TITLE,
  DELEGATE_DELIVERABLE_DEFAULT,
  DELEGATE_LONG_OP_NOTICE,
  DELEGATE_MEMORY_HEADER,
  DELEGATE_PROTOCOL_ORCHESTRATION,
  DELEGATE_RULES_HEADER,
  DELEGATE_SUBAGENT_NOTIFY,
} from './promptParts';

// ===== R1-1 委托上下文配额（分区预算 + 记忆相关性挑选 + 缓存友好序） =====
// 缓存友好序：稳定内容（promptPrefix → 用户规则）在前，易变内容（记忆 →
// 任务书）靠后——远程模型命中提示词缓存省钱（Manus：KV-cache 命中率第一指标）。

export const RULES_MAX_CHARS = 4000;
/** 记忆最多带 5 条（按相关性挑，不再前 20 条全塞） */
const MEMORY_MAX_ITEMS = 5;
const MEMORY_LINE_CHARS = 120;
const MEMORY_BLOCK_MAX_CHARS = 1000;
/** 计划书正文上限（超长截断留痕；通常 <2KB 打不满） */
const PLAN_BODY_MAX_CHARS = 12000;
/** 相关性匹配的 haystack 上限（防大计划书 O(n²) 扫描） */
const RELEVANCE_HAYSTACK_CHARS = 6000;

/** 任务书需要的最小任务视图（TodoTask 结构兼容；不反向依赖 todo 模块）。 */
export interface DelegationTaskView {
  title: string;
  notes?: string;
  plan?: {
    goal?: string;
    deliverable?: string;
    tasks: Array<{ title: string; notes?: string }>;
    acceptance: string[];
  } | null;
}

/** 记忆相关性打分：tags/标题命中权重高，内容关键词命中权重低。 */
function scoreMemoryRelevance(mem: AIMemory, taskText: string): number {
  let score = 0;
  for (const tag of mem.tags ?? []) {
    if (tag && taskText.includes(tag)) score += 2;
  }
  const tokenize = (s: string): string[] =>
    s
      .split(/[^\p{L}\p{N}]+/u)
      .map(t => t.trim())
      .filter(t => t.length >= 2);
  for (const tok of tokenize(mem.title).slice(0, 8)) {
    if (taskText.includes(tok)) score += 2;
  }
  for (const tok of tokenize((mem.content ?? '').slice(0, 160)).slice(0, 12)) {
    if (taskText.includes(tok)) score += 1;
  }
  return score;
}

/**
 * 按任务相关性挑记忆：命中分 > 0 的按分降序取前 max 条；
 * 相关的不足 2 条时按原顺序补足（保底核心记忆不被相关性算法饿死）。
 */
export function selectRelevantMemories(mems: AIMemory[], taskText: string): AIMemory[] {
  const hay = taskText.slice(0, RELEVANCE_HAYSTACK_CHARS);
  const scored = mems
    .map(m => ({ m, s: scoreMemoryRelevance(m, hay) }))
    .sort((a, b) => b.s - a.s);
  const picked = scored.filter(x => x.s > 0).slice(0, MEMORY_MAX_ITEMS);
  if (picked.length < 2) {
    for (const x of scored.filter(x => x.s === 0)) {
      if (picked.length >= 2) break;
      picked.push(x);
    }
  }
  return picked.map(x => x.m);
}

/** R1-3 四段任务书的目标行。 */
function goalLine(task: DelegationTaskView): string {
  const goal = task.plan?.goal?.trim();
  return goal ? `${task.title}：${goal}` : task.title;
}

/**
 * assembleDelegationPrompt — 委托 prompt 统一组装（R1-1/R1-3/R1-5）。
 *
 * 结构（自上而下）：
 *   module.promptPrefix（稳定）→ 用户规则（稳定，截 4000）→ 用户记忆
 *   （相关性 Top-5，截 1000）→ 任务书四段（目标/交付物/工具与资料/边界，
 *   计划书全文嵌在交付物之后作为契约正文）→ 完工与收尾（稳定）。
 */
export function assembleDelegationPrompt(parts: {
  promptPrefix: string;
  rules: string;
  memories: AIMemory[];
  task: DelegationTaskView;
  planMd: string | null;
  cwd: string | null;
  taskId: string;
  hasPlanDoc: boolean;
  /** 执行策略：缺省 legacy（策等旧流程行为不变）；工作台传 local-first。 */
  execution?: 'legacy' | 'local-first';
}): string {
  const { promptPrefix, rules, memories, task, planMd, cwd, taskId, hasPlanDoc } = parts;
  const localFirst = parts.execution === 'local-first';

  // —— 记忆块（相关性挑选 + 预算）——
  let memoryBlock = '';
  if (memories.length) {
    const lines = memories
      .map(
        m => `- ${m.title}${m.content ? `：${m.content}` : ''}`.slice(0, MEMORY_LINE_CHARS)
      )
      .join('\n')
      .slice(0, MEMORY_BLOCK_MAX_CHARS);
    memoryBlock = `${DELEGATE_MEMORY_HEADER}\n${lines}`;
  }

  // —— 任务书四段 ——
  const book: string[] = [DELEGATE_BOOK_TITLE, `[GOAL] ${goalLine(task)}`];
  if (planMd && planMd.trim()) {
    book.push(`[DELIVERABLES] See the "## Deliverables" section of the plan. ${DELEGATE_DELIVERABLE_DEFAULT}`);
    const body =
      planMd.length > PLAN_BODY_MAX_CHARS
        ? `${planMd.slice(0, PLAN_BODY_MAX_CHARS)}\n…(plan truncated; read the full text with ai00_plan_read)`
        : planMd;
    book.push('—— Full plan (the contract for this brief, including step and acceptance state) ——', body);
  } else if (task.plan) {
    book.push(`[DELIVERABLES] ${task.plan.deliverable?.trim() || DELEGATE_DELIVERABLE_DEFAULT}`);
    const body: string[] = [];
    if (task.plan.tasks.length) {
      body.push('Steps:', ...task.plan.tasks.map((t, i) => `${i + 1}. ${t.title}${t.notes ? ` — ${t.notes}` : ''}`));
    }
    if (task.plan.acceptance.length) {
      body.push(
        'Acceptance criteria (self-check each item, then tick the matching line under "## Acceptance" in the plan as `- [x]`):',
        ...task.plan.acceptance.map((a, i) => `${i + 1}. ${a}`),
      );
    }
    if (body.length) book.push('—— Plan contract ——', ...body);
  } else {
    book.push(`[DELIVERABLES] ${DELEGATE_DELIVERABLE_DEFAULT}`);
    if (task.notes?.trim()) book.push(task.notes.trim());
  }

  // [TOOLS & CONTEXT]
  const tools: string[] = ['[TOOLS & CONTEXT]'];
  if (cwd) {
    tools.push(`- Working directory: ${cwd} (subagents read and write only inside it; put this path in every brief)`);
  }
  tools.push(DELEGATE_PROTOCOL_ORCHESTRATION(taskId, localFirst));
  if (hasPlanDoc) {
    tools.push(
      DELEGATE_SUBAGENT_NOTIFY(localFirst),
      DELEGATE_LONG_OP_NOTICE,
      DELEGATE_BG_COMMAND_NOTICE,
    );
  }

  // [BOUNDARIES]
  const boundaries: string[] = ['[BOUNDARIES]'];
  if (hasPlanDoc) boundaries.push(DELEGATE_BOUNDARY_PLAN_FIRST);
  boundaries.push(DELEGATE_BOUNDARY_IDEA_POOL(taskId));

  return [
    promptPrefix,
    rules ? `${DELEGATE_RULES_HEADER}\n${rules}` : '',
    memoryBlock,
    ...book,
    ...tools,
    ...boundaries,
    DELEGATE_COMPLETION_TITLE,
    DELEGATE_COMPLETION_THREE_STEP(taskId, cwd),
  ]
    .filter(Boolean)
    .join('\n\n');
}
