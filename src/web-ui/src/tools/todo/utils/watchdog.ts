/**
 * watchdog — 执行卡死检测/评估/恢复的共享常量与动作。
 *
 * 流程：静默到软阈值（5m）→ 派评估 agent 判断「正常长任务 vs 卡死」并给出
 * 预计剩余时间（ETA）→ 判卡死才自动恢复（上限 2 次，超过转人工）；
 * 判正常则按 ETA（无 ETA 则复查间隔翻倍，封顶 1h）自适应安排下一次复查，
 * **没有任何绝对时间的强制干预**——训练/编译跑几个小时也绝不误杀。
 * 等人工场景（ask_user_question 待答 / 工具审批挂起）由调用方豁免。
 *
 * R1-2（2026-09-12）：恢复词带进度快照——从计划文档勾选状态 + 事件流水账
 * 近期工具动作确定性生成，恢复从"靠赌模型重读质量"变"拿进度条续跑"。
 * 提示词文本统一收口 ../ai/prompts.ts（R1-5）。
 */
import { invoke } from '@tauri-apps/api/core';
import { dshSession, foldEvents } from '@/infrastructure/api/service-api/DshAPI';
import { aiComplete } from '../ai/consult';
import {
  STALL_JUDGE_SYSTEM,
  buildStallJudgePrompt,
  buildWatchdogRecoverPrompt,
} from '../ai/prompts';
import { getDiscussModel } from '../ai/modelCatalog';
import { useGrowthStore } from '../store/growthStore';

export const WATCH_STALL_SOFT_MS = 5 * 60_000;
/** 首次复查间隔（判「正常」后按 ETA/翻倍自适应拉长，封顶 1h） */
export const WATCH_JUDGE_MIN_INTERVAL_MS = 10 * 60_000;
export const WATCH_MAX_DELAY_MS = 60 * 60_000;
/** 判卡死自动恢复次数上限（超过转人工） */
export const WATCH_MAX_RECOVER = 2;

export interface StallJudgment {
  verdict: 'normal' | 'stuck';
  /** 判正常时的预计剩余分钟数（评估 agent 估的；可能缺失） */
  etaMinutes?: number;
  reason?: string;
}

/**
 * 进度快照（R1-2）：从两个权威数据源确定性拼装——
 * ① 计划文档勾选状态（编排者边干边勾，进度的权威账本）；
 * ② 事件流水账最近 3 个工具动作（正在做什么/卡在哪）。
 * 全部尽力而为：任一源失败跳过，两源皆空返回 ''（恢复词回落旧口径）。
 */
export async function buildRecoverySnapshot(taskId: string, sid: string): Promise<string> {
  const lines: string[] = [];

  // ① 计划文档勾选状态（todo_plan_get 与委托任务书同源）
  try {
    const md = await invoke<string | null>('todo_plan_get', { taskId }).catch(() => null);
    if (md) {
      const sections = md.split(/^##\s+/m);
      const stepSec = sections.find(s => s.startsWith('步骤')) ?? '';
      const items = [...stepSec.matchAll(/^[-*]\s+\[( |x)\]\s+(.+)$/gim)];
      if (items.length) {
        const done = items.filter(m => m[1].toLowerCase() === 'x');
        lines.push(`计划步骤：${done.length}/${items.length} 已完成`);
        const pending = items
          .filter(m => m[1].toLowerCase() !== 'x')
          .map(m => m[2].trim().slice(0, 40));
        if (pending.length) lines.push(`待做：${pending.slice(0, 3).join('；')}`);
      }
      const accSec = sections.find(s => s.startsWith('验收')) ?? '';
      const acc = [...accSec.matchAll(/^[-*]\s+\[( |x)\]\s+/gim)];
      if (acc.length) {
        const doneAcc = acc.filter(m => m[1].toLowerCase() === 'x').length;
        lines.push(`验收勾选：${doneAcc}/${acc.length}`);
      }
    }
  } catch {
    // 尽力而为
  }

  // ② 事件流水账最近 3 个工具动作（judgeStall 同一数据源）
  try {
    const { events } = await dshSession.history(sid);
    const msgs = foldEvents(events.map(e => e.event));
    const tools: string[] = [];
    for (const m of [...msgs].reverse()) {
      for (const t of [...m.toolCalls].reverse()) {
        tools.push(`${t.name}${t.isError ? '（失败）' : t.pending ? '（未返回）' : '（完成）'}`);
        if (tools.length >= 3) break;
      }
      if (tools.length >= 3) break;
    }
    if (tools.length) lines.push(`最近动作：${tools.join(' → ')}`);
  } catch {
    // 尽力而为
  }

  return lines.length ? `【执行进度快照】\n${lines.join('\n')}` : '';
}

/** 组装恢复词：快照（尽力而为）+ 检测依据。 */
export async function buildRecoverPromptForTask(
  taskId: string,
  sid: string,
  judgeReason?: string
): Promise<string> {
  const snapshot = await buildRecoverySnapshot(taskId, sid).catch(() => '');
  return buildWatchdogRecoverPrompt({ snapshot: snapshot || undefined, judgeReason });
}

/** 手动/自动共用的恢复动作：中断卡住的轮次 + 发继续指令（带进度快照）。 */
export async function recoverSession(
  sid: string,
  judgeReason?: string,
  taskId?: string
): Promise<void> {
  await dshSession.cancel(sid);
  const prompt = taskId
    ? await buildRecoverPromptForTask(taskId, sid, judgeReason)
    : buildWatchdogRecoverPrompt({ judgeReason });
  await dshSession.prompt(sid, prompt);
  useGrowthStore
    .getState()
    .showToast('已中断卡住的轮次', '已发送继续指令（带进度快照），agent 会从计划断点继续');
}

export type StallVerdict = StallJudgment | null;

/**
 * 评估 agent：把任务上下文（标题/当前步骤/最近执行记录/静默时长）交给
 * 讨论模型判断「正常长耗时操作 vs 卡死」，正常时给出预计剩余分钟数。
 * 返回 null = 评估不可用（调用方退回人工提醒）。
 */
export async function judgeStall(params: {
  taskId: string;
  title: string;
  sid: string;
  idleMinutes: number;
  currentStep: string | null;
  model: string;
}): Promise<StallJudgment | null> {
  const { taskId, title, sid, idleMinutes, currentStep, model } = params;
  try {
    let tailDesc = '（无记录）';
    try {
      const { events } = await dshSession.history(sid);
      const msgs = foldEvents(events.map(e => e.event));
      tailDesc = msgs
        .slice(-4)
        .map(m => {
          const tools = m.toolCalls.length
            ? ` [工具: ${m.toolCalls
                .map(t => `${t.name}${t.pending ? '(未返回)' : ''}`)
                .join('、')}]`
            : '';
          return `${m.role === 'user' ? '用户' : 'agent'}: ${m.text.slice(0, 160)}${tools}`;
        })
        .join('\n');
    } catch {
      // 历史拉不到 → 用占位继续
    }

    const prompt = buildStallJudgePrompt({ title, idleMinutes, currentStep, tailDesc });

    const out = await aiComplete(prompt, STALL_JUDGE_SYSTEM, {
      temperature: 0.3,
      maxTokens: 200,
      model: model === 'auto' ? undefined : model,
      tag: `todo:watchdog:${taskId}`,
    });
    const etaMatch = out.match(/"etaMinutes"\s*:\s*(\d+)/);
    if (/"verdict"\s*:\s*"stuck"/.test(out)) {
      const reason = out.match(/"reason"\s*:\s*"([^"]+)"/)?.[1];
      return { verdict: 'stuck', reason };
    }
    if (/"verdict"\s*:\s*"normal"/.test(out)) {
      const reason = out.match(/"reason"\s*:\s*"([^"]+)"/)?.[1];
      return {
        verdict: 'normal',
        etaMinutes: etaMatch ? Number(etaMatch[1]) : undefined,
        reason,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 读取讨论模型引用（卡片字段优先，回落全局默认；'auto' 原样传给评估）。 */
export function judgeModelFor(task: { discussModel?: string | null }): string {
  return task.discussModel ?? getDiscussModel();
}
