/**
 * useAgentDelegate — 策卡片 → dsh agent 委托交付（人机对等计划体）。
 *
 * 模块化（M1.3/M4.1）：delegate(task, moduleId?) 按 agent-modules 注册表
 * 解析模块；module.preset 非空时作为 agentPreset 传给 session.create
 * （dsh 引擎原生参数，Rust 侧 .agent-presets 预置同名 preset）。
 * 流程：session.create → prompt（编排者协议：拆解任务书 → 并发派发
 * research_worker/code_worker → 验收子代理结论回写计划 → ai00_task_complete
 * 提交自检）→ 回写卡片（agentModule/agentSessionId/status: doing）→ 唤起主窗
 * Agent 场景。主对话只规划/派发/验收/沟通，不亲自调执行工具（与编排 patch
 * persona 同向加强）；计划文档读写与 ai00_task_* 是编排者保留的职责工具。
 * 会话模型不覆盖（模型解耦）：执行会话=主对话（编排者）跟随引擎默认远端；
 * worker 分工（research=ai00-auto 本地/智能路由 / code=ai00-salvo 远端）由
 * 编排 patch 自动承担；讨论模型只属于讨论通道，不泄漏到执行会话。
 */
import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  dshSession,
  dshEngine,
} from '@/infrastructure/api/service-api/DshAPI';
import { getAgentModule } from '../agent-modules';
import { AIRulesAPI } from '@/infrastructure/api/service-api/AIRulesAPI';
import { getAllMemories } from '@/infrastructure/api/aiMemoryApi';
import type { AIMemory } from '@/infrastructure/api/aiMemoryApi';
import type { TodoTask } from '../api/types';
import { useTodoStore } from '../store/todoStore';
import { useGrowthStore } from '../store/growthStore';
import {
  getDefaultWorkspace,
  pickWorkspaceDir,
  resolveDelegateCwd,
  setDefaultWorkspace,
} from '../ai/workspace';
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
} from '../ai/prompts';

// ===== R1-1 委托上下文配额（分区预算 + 记忆相关性挑选 + 缓存友好序） =====
// 缓存友好序：稳定内容（promptPrefix → 用户规则）在前，易变内容（记忆 →
// 任务书）靠后——远程模型命中提示词缓存省钱（Manus：KV-cache 命中率第一指标）。

const RULES_MAX_CHARS = 4000;
/** 记忆最多带 5 条（按相关性挑，不再前 20 条全塞） */
const MEMORY_MAX_ITEMS = 5;
const MEMORY_LINE_CHARS = 120;
const MEMORY_BLOCK_MAX_CHARS = 1000;
/** 计划书正文上限（超长截断留痕；通常 <2KB 打不满） */
const PLAN_BODY_MAX_CHARS = 12000;
/** 相关性匹配的 haystack 上限（防大计划书 O(n²) 扫描） */
const RELEVANCE_HAYSTACK_CHARS = 6000;

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
function goalLine(task: TodoTask): string {
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
  task: TodoTask;
  planMd: string | null;
  cwd: string | null;
  taskId: string;
  hasPlanDoc: boolean;
}): string {
  const { promptPrefix, rules, memories, task, planMd, cwd, taskId, hasPlanDoc } = parts;

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
  const book: string[] = [DELEGATE_BOOK_TITLE, `【目标】${goalLine(task)}`];
  if (planMd && planMd.trim()) {
    book.push(`【交付物】见计划书「## 交付物」段；${DELEGATE_DELIVERABLE_DEFAULT}`);
    const body =
      planMd.length > PLAN_BODY_MAX_CHARS
        ? `${planMd.slice(0, PLAN_BODY_MAX_CHARS)}\n…（计划书超长已截断，全文用 ai00_plan_read 读取）`
        : planMd;
    book.push('—— 计划书全文（本任务书的契约正文，含步骤与验收勾选状态）——', body);
  } else if (task.plan) {
    book.push(`【交付物】${task.plan.deliverable?.trim() || DELEGATE_DELIVERABLE_DEFAULT}`);
    const body: string[] = [];
    if (task.plan.tasks.length) {
      body.push('步骤：', ...task.plan.tasks.map((t, i) => `${i + 1}. ${t.title}${t.notes ? ` — ${t.notes}` : ''}`));
    }
    if (task.plan.acceptance.length) {
      body.push(
        '验收标准（完成后逐项自检，并在计划文档「## 验收」段把对应项勾为 `- [x]`）：',
        ...task.plan.acceptance.map((a, i) => `${i + 1}. ${a}`),
      );
    }
    if (body.length) book.push('—— 计划契约 ——', ...body);
  } else {
    book.push(`【交付物】${DELEGATE_DELIVERABLE_DEFAULT}`);
    if (task.notes?.trim()) book.push(task.notes.trim());
  }

  // 【工具与资料】
  const tools: string[] = ['【工具与资料】'];
  if (cwd) {
    tools.push(`- 工作目录：${cwd}（子代理的文件读写在此目录下进行，派发时把该目录写进任务书）`);
  }
  tools.push(DELEGATE_PROTOCOL_ORCHESTRATION(taskId));
  if (hasPlanDoc) {
    tools.push(DELEGATE_SUBAGENT_NOTIFY, DELEGATE_LONG_OP_NOTICE, DELEGATE_BG_COMMAND_NOTICE);
  }

  // 【边界】
  const boundaries: string[] = ['【边界】'];
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

export function useAgentDelegate() {
  const busyRef = useRef(false);

  const delegate = useCallback(async (task: TodoTask, moduleId?: string) => {
    if (busyRef.current) return false;
    // 模块解析：显式 moduleId 优先，缺省普通 agent（preset: '' 用默认）
    const module = getAgentModule(moduleId) ?? getAgentModule('agent');
    if (!module) return false;
    busyRef.current = true;
    // 提升作用域：catch 兜底 cancel 用（会话已创建但后续步骤失败 → 孤儿会话）
    let sessionId: string | null = null;
    try {
      // 1. 引擎就绪
      await dshEngine.ensureReady().catch(() => undefined);

      // 2. cwd 解析链（cwd 策略 none 的模块跳过——壁纸等无需工作目录）：
      //    志目录 > 默认工作区；两者皆无且未设置过默认 → 首次引导
      //    选一次（挑过持久化不再问；取消则本次不带 cwd，行为同旧版）
      let cwd: string | null = null;
      if (module.cwd === 'ask') {
        cwd = resolveDelegateCwd(useTodoStore.getState().data, task.goalId);
        if (!cwd && !getDefaultWorkspace()) {
          cwd = await pickWorkspaceDir();
          if (cwd) setDefaultWorkspace(cwd);
        }
      }

      // 3. 创建会话（cwd/agentPreset 缺省必须省略字段——引擎对 '' 做 mkdir 报 ENOENT）
      const created = await dshSession.create({
        ...(cwd ? { cwd } : {}),
        ...(module.preset ? { agentPreset: module.preset } : {}),
      });
      sessionId = created.sessionId;
      // M1.4 VRAM 联动：会话创建即上报 agent 活动上下文 → 预测 warmup 本地 RWKV
      await invoke('vram_set_active_context', { context: 'agent' }).catch(() => undefined);

      // 3.2 会话模型不在此覆盖（模型解耦）：执行会话是主对话（编排者），
      //    跟随引擎默认远端（agent-default-model=ai00-salvo，见
      //    dsh_manager ensure_default_model_setting）；会话内 worker 分工
      //    research_worker=ai00-auto / code_worker=ai00-salvo 由编排 patch
      //    自动承担，前端零干预。讨论模型字段只属于讨论通道。

      // 3.5 委托前基线快照（auto-init 静默；失败不阻塞委托）——commit 存卡，验收 diff/回滚用
      let baseCommit: string | null = null;
      if (cwd) {
        const snap = await invoke<{ commit?: string }>('git_snapshot', {
          request: { dir: cwd, message: `task: ${task.title.slice(0, 60)} · 委托基线` },
        }).catch(() => undefined);
        baseCommit = snap?.commit ?? null;
      }

      // 4. 计划文档探测（契约即任务书）：优先读计划 MD 现文——replan 后的改动
      //    直接生效；读不到再退化用 task.plan 结构化快照
      const planMd = await invoke<string | null>('todo_plan_get', { taskId: task.id }).catch(
        () => null
      );
      const hasPlanDoc = Boolean(planMd && planMd.trim());

      // 用户 AI 规则 + 记忆（R1-1 配额：规则截 4000；记忆按相关性挑 Top-5；
      // 为空/失败静默——不阻塞委托）
      let rules = '';
      if (cwd) {
        try {
          const sys = await AIRulesAPI.buildSystemPrompt(cwd);
          if (sys?.trim()) rules = sys.trim().slice(0, RULES_MAX_CHARS);
        } catch {
          // 规则读取失败静默
        }
      }
      let memories: AIMemory[] = [];
      try {
        const mems = (await getAllMemories()).filter(m => m.enabled !== false);
        memories = selectRelevantMemories(
          mems,
          `${task.title}\n${task.notes ?? ''}\n${planMd ?? ''}`,
        );
      } catch {
        // 记忆读取失败静默
      }

      // R1-3 四段任务书 + R1-5 提示词收口：组装统一走 assembleDelegationPrompt
      const prompt = assembleDelegationPrompt({
        promptPrefix: module.promptPrefix,
        rules,
        memories,
        task,
        planMd: planMd ?? null,
        cwd,
        taskId: task.id,
        hasPlanDoc,
      });

      await dshSession.prompt(sessionId, prompt);

      // 5. 回写卡片（doing 栏 + agent 关联）；不弹会话浮层——交流在策内
      //    进行中卡片的讨论窗/计划窗里进行（点击工灵仍可开浮层，属剧场入口）
      useTodoStore.getState().updateTask(task.id, {
        agentModule: module.id,
        agentSessionId: sessionId,
        agentPrompt: prompt,
        status: 'doing',
        agentBaseCommit: baseCommit,
        agentCommit: null, // 重置上次运行的快照/自检态
        agentCompletedAt: null,
      });
      return true;
    } catch (e) {
      useGrowthStore.getState().showToast('委托失败', e instanceof Error ? e.message : String(e));
      // 会话已创建但后续步骤失败 → 兜底 cancel，避免无卡片关联的孤儿会话残留
      // （DshAPI 无 delete，cancel 停止轮次；会话仍在 dsh 列表但不再耗资源）
      if (sessionId) {
        dshSession.cancel(sessionId).catch(() => undefined);
      }
      return false;
    } finally {
      busyRef.current = false;
    }
  }, []);

  return { delegate };
}
