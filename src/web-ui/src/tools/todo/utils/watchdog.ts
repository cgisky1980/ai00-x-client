/**
 * watchdog — 执行卡死检测/评估/恢复的共享常量与动作。
 *
 * 流程：静默到软阈值（5m）→ 派评估 agent 判断「正常长任务 vs 卡死」并给出
 * 预计剩余时间（ETA）→ 判卡死才自动恢复（上限 2 次，超过转人工）；
 * 判正常则按 ETA（无 ETA 则复查间隔翻倍，封顶 1h）自适应安排下一次复查，
 * **没有任何绝对时间的强制干预**——训练/编译跑几个小时也绝不误杀。
 * 等人工场景（ask_user_question 待答 / 工具审批挂起）由调用方豁免。
 */
import { dshSession, foldEvents } from '@/infrastructure/api/service-api/DshAPI';
import { aiComplete } from '../ai/consult';
import { getDiscussModel } from '../ai/modelCatalog';
import { useGrowthStore } from '../store/growthStore';

export const WATCH_STALL_SOFT_MS = 5 * 60_000;
/** 首次复查间隔（判「正常」后按 ETA/翻倍自适应拉长，封顶 1h） */
export const WATCH_JUDGE_MIN_INTERVAL_MS = 10 * 60_000;
export const WATCH_MAX_DELAY_MS = 60 * 60_000;
/** 判卡死自动恢复次数上限（超过转人工） */
export const WATCH_MAX_RECOVER = 2;

export const WATCH_RECOVER_PROMPT =
  '【自动恢复】检测到执行长时间无响应，已中断卡住的轮次。请先用 ai00_plan_read 重读计划文档确认当前进度，然后从断点继续执行；刚才未完成的工具调用请重新执行。';

export interface StallJudgment {
  verdict: 'normal' | 'stuck';
  /** 判正常时的预计剩余分钟数（评估 agent 估的；可能缺失） */
  etaMinutes?: number;
  reason?: string;
}

/** 手动/自动共用的恢复动作：中断卡住的轮次 + 发继续指令。 */
export async function recoverSession(sid: string, judgeReason?: string): Promise<void> {
  await dshSession.cancel(sid);
  const prompt = judgeReason
    ? `${WATCH_RECOVER_PROMPT}\n（检测依据：${judgeReason}）`
    : WATCH_RECOVER_PROMPT;
  await dshSession.prompt(sid, prompt);
  useGrowthStore
    .getState()
    .showToast('已中断卡住的轮次', '已发送继续指令，agent 会从计划断点继续');
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

    const prompt = [
      `一个 AI agent 正在执行任务「${title}」，已 ${idleMinutes} 分钟没有任何新事件（无新 token、无工具返回——说明当前操作没有可观察的输出流）。`,
      currentStep ? `当前计划步骤：${currentStep}` : '',
      '最近的执行记录：',
      tailDesc,
      '',
      '注意：模型训练、程序编译等操作可能合法运行数小时，不要仅因静默时间长就判卡死。',
      '请结合操作类型判断这是【正常的长耗时操作】还是【卡死/异常】（死循环、弹窗阻塞、进程挂起等）。',
      '只输出 JSON：',
      '正常：{"verdict":"normal","etaMinutes":<预计还需的分钟数>,"reason":"一句话"}',
      '卡死：{"verdict":"stuck","reason":"一句话依据"}',
    ]
      .filter(Boolean)
      .join('\n');

    const out = await aiComplete(prompt, '你是 agent 执行监督员，只输出严格 JSON。', {
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
