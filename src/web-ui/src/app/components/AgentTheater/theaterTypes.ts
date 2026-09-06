// ========================================================================
// Agent 剧场类型定义（设计：参考/设计-Agent剧场与名场面.md v3.1）
// ========================================================================
// 工灵（AgentImp）= 一个进行中的 dsh 会话在 overlay 层的化身。
// 一只工灵 = 一个 sessionId；形象由 sessionId 种子确定性生成。

/** 工灵可见状态（§3.2 状态表） */
export type ImpPhase =
  | 'appear' // 蹦出（turn/start）
  | 'working' // 干活（tool 节拍，强度调节）
  | 'thinking' // 长静默（>90s 无工具事件）
  | 'trouble' // 翻车（tool/result isError）
  | 'milestone' // 连续成功/大工具
  | 'deliver-big' // 交付庆祝（turn/end 无失败，随后进入待验收驻留）
  | 'acceptance' // 待验收驻留（agent 停止且未失败；验收完成才离场）
  | 'alert' // 执行出错——红色警示驻留（处理完成/验收结束才离场）
  | 'leaving'; // 离场

/** agent 分类（决定形象模板，turn 内不漂移） */
export type AgentCategory = 'coding' | 'debugging' | 'research' | 'writing' | 'general';

/** 名场面规则键（SceneRules，§4.1） */
export type SceneRuleKey =
  | 'reversal' // 逆转
  | 'grind' // 硬仗
  | 'ponderer' // 多疑
  | 'labor' // 苦力
  | 'late-night' // 深夜
  | 'lightning'; // 闪电

/** 单轮统计（按 sessionId:turnId 隔离，防多会话污染） */
export interface TurnStats {
  sessionId: string;
  turnId: string;
  startedAt: number;
  endedAt?: number;
  /** 任务标签（turn/start userInput 截断；空则回退会话标题/通用文案） */
  taskLabel: string;
  toolCalls: number;
  errors: number;
  maxConsecutiveErrors: number;
  consecutiveSuccesses: number;
  /** 错误后是否有成功结果（逆转判定用） */
  recoveredAfterError: boolean;
  /** ≥90s 的长思考次数 */
  thinkGapsOver90s: number;
}

/** 工灵运行时状态（React store 消费的最小快照） */
export interface ImpRuntimeState {
  sessionId: string;
  turnId: string;
  phase: ImpPhase;
  category: AgentCategory;
  taskLabel: string;
  /** 工作强度档位（由最近 60s 工具密度推导：0 慢 / 1 中 / 2 快） */
  intensity: 0 | 1 | 2;
  startedAt: number;
  /** 最近一次工具调用（AgentCard「当前」行；pending 中） */
  lastToolName?: string;
  lastToolArgs?: string;
  /** 是否拿到工灵席位（≤2 并发；第 3+ 会话只进统计） */
  hasImp: boolean;
  /** 最近一次结果是否错误（卡片错误着色） */
  lastResultError?: boolean;
  /** 实时累计（TurnStats 的透出，AgentCard 用） */
  toolCalls: number;
  errors: number;
  maxConsecutiveErrors: number;
}

/** turn 结束（桥事件 theater://turn-ended payload，§4.2） */
export interface TheaterTurnEndedPayload {
  sessionId: string;
  turnId: string;
  outcome: 'success' | 'failed';
  taskLabel: string;
  stats: {
    toolCalls: number;
    errors: number;
    durationMs: number;
    taskLabel: string;
  };
}

/** 名场面卡（桥事件 theater://scene payload，§4.2） */
export interface TheaterScenePayload {
  sessionId: string;
  turnId: string;
  /** 规则键（标题走 i18n：agentTheater.scene.<key>） */
  ruleKey: SceneRuleKey;
  detail: {
    toolCalls: number;
    errors: number;
    durationMs: number;
    taskLabel: string;
  };
}

/** ImpManager 对外的回调集合 */
export interface ImpManagerCallbacks {
  /** 工灵状态变化（upsert） */
  onImpState: (state: ImpRuntimeState) => void;
  /** 工灵离场（删除） */
  onImpRemoved: (sessionId: string) => void;
  /** turn 结束（必发，每 turn 1 次） */
  onTurnEnded: (payload: TheaterTurnEndedPayload) => void;
  /** 名场面命中（每 turn ≤1 次） */
  onScene: (payload: TheaterScenePayload) => void;
}
