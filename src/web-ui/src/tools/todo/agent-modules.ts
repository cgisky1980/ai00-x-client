/**
 * Agent 模块注册表（策窗口「智囊」）。
 *
 * 设计哲学（2026-08-26 定稿）：agent 和人都是计划的制定与执行者（对等主体）。
 * 本轮只有**一个普通 agent**——特化模块（代码/壁纸/音乐）后置为 agent 系统的
 * 插件；插件接入时注册进 AGENT_MODULES 并自带 planHint（验收侧重指引），
 * generateBoardPlan 会拼进生成 prompt——策窗口零核心改动。
 *
 * 提示文案本体在 `@/agent/orchestrator`（工作台任务共用同一份）。
 */
import { ORCHESTRATOR_PLAN_HINT, ORCHESTRATOR_PROMPT_PREFIX } from '@/agent/orchestrator/modules';

export interface AgentModule {
  id: string;
  /** 卡片名 */
  title: string;
  /** 一句话能力描述 */
  description: string;
  /** dsh agentPreset id（session.create 用；空=默认） */
  preset: string;
  /** 模块职责前缀（注入委托 prompt 首段） */
  promptPrefix: string;
  /** cwd 策略：ask=委托时选目录；none=无需工作目录 */
  cwd: 'ask' | 'none';
  /** 计划生成时的验收侧重指引（注入 generateBoardPlan 的 system prompt） */
  planHint?: string;
  /** 直跳工坊场景 id（设置则点卡跳工坊，不走 agent 会话） */
  openStudio?: string;
}

export const AGENT_MODULES: AgentModule[] = [
  {
    id: 'agent',
    title: 'agent',
    description: '通用编排者：拆解任务派发子代理执行，验收结果回写计划',
    preset: '',
    // 代码/文档类任务需要工作目录（志目录 > 默认工作区 > 首次引导选择）
    cwd: 'ask',
    promptPrefix: ORCHESTRATOR_PROMPT_PREFIX,
    planHint: ORCHESTRATOR_PLAN_HINT,
  },
];

export function getAgentModule(id?: string | null): AgentModule | null {
  if (!id) return null;
  return AGENT_MODULES.find(m => m.id === id) ?? null;
}
