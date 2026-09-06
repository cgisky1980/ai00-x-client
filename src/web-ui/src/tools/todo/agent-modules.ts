/**
 * Agent 模块注册表（策窗口「智囊」）。
 *
 * 设计哲学（2026-08-26 定稿）：agent 和人都是计划的制定与执行者（对等主体）。
 * 本轮只有**一个普通 agent**——特化模块（代码/壁纸/音乐）后置为 agent 系统的
 * 插件；插件接入时注册进 AGENT_MODULES 并自带 planHint（验收侧重指引），
 * generateBoardPlan 会拼进生成 prompt——策窗口零核心改动。
 */

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
    description: '通用执行者：按计划契约执行并回写验收',
    preset: '',
    // 代码/文档类任务需要工作目录（志目录 > 默认工作区 > 首次引导选择）
    cwd: 'ask',
    promptPrefix:
      '你是 Ai00-X 的执行 agent，与人共同持有同一份计划契约。请按契约执行，执行中把进度与结果更新回计划文档；关键决策用 ask_user_question 与用户确认。',
    planHint:
      'acceptance 侧重可客观检验的完成判据：做成什么样算完成、在哪里可以看到结果，3-6 项。',
  },
  {
    id: 'wallpaper',
    title: '壁纸工坊',
    description: 'HTML 动态壁纸制作与应用（Rust 侧预置 persona，交付走壁纸项目）',
    // Rust 侧预置 preset（dsh_manager.rs ensure_agent_presets →
    // DSH_HOME/.agent-presets/ai00x-wallpaper），session.create 直接引用
    preset: 'ai00x-wallpaper',
    cwd: 'none',
    promptPrefix:
      '你是 Ai00-X 壁纸工坊 agent。与用户确认需求后制作 HTML 动态壁纸，通过 ai00_wallpaper_create 交付并可应用桌面。',
    planHint:
      'acceptance 侧重视觉与交付判据：壁纸风格/动效是否符合需求、壁纸项目是否已创建并可应用桌面，2-4 项。',
    // 点卡直跳壁纸工坊场景（不走 agent 会话的用户路径保留）
    openStudio: 'wallpaper',
  },
];

export function getAgentModule(id?: string | null): AgentModule | null {
  if (!id) return null;
  return AGENT_MODULES.find(m => m.id === id) ?? null;
}
