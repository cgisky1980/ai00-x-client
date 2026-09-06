// ========================================================================
// ImpManager：dsh 会话事件 → 工灵状态机（设计 §3.2/§3.3/§4）
// ========================================================================
// 纯逻辑模块（无 React/Tauri 依赖，可单测）：
// - 消费 mux 帧（session/event 的 turn/start|end、tool/call|result 四种）
// - 每个活跃 turn 一只工灵（≤2 席位），状态迁移 + 强度调节 + TurnStats
// - turn/end 结算：onTurnEnded（必发）+ onScene（名场面，≤1 次/turn）
// - 强度：最近 60s 工具密度 → 0/1/2 档，仅调节动画速率，不产生独立动作

import type { DshMuxFrame, DshSessionEvent } from '../../../infrastructure/api/service-api/DshAPI';
import { evaluateSceneRule } from './SceneRules';
import { CATEGORY_KEYWORDS, RESEARCH_TOOLS } from './theaterCopy';
import type {
  AgentCategory,
  ImpManagerCallbacks,
  ImpPhase,
  ImpRuntimeState,
  TurnStats,
} from './theaterTypes';

/** 并发工灵上限（第 3+ 会话只进统计） */
export const MAX_CONCURRENT_IMPS = 2;

/** thinking 判定：距最近工具/turn 事件的静默时长 */
const THINKING_AFTER_MS = 90_000;
/** trouble/milestone/appear 的自动回落时长 */
const TRANSIENT_MS = 2_000;
/** 强度统计窗口 */
const INTENSITY_WINDOW_MS = 60_000;
/** 状态机自检 tick */
const TICK_MS = 1_000;

interface SessionRuntime {
  stats: TurnStats;
  phase: ImpPhase;
  category: AgentCategory;
  intensity: 0 | 1 | 2;
  hasImp: boolean;
  milestoneCount: number;
  /** 最近工具事件时间戳（强度统计用，保留窗口内） */
  toolTimestamps: number[];
  lastEventAt: number;
  lastToolName?: string;
  lastToolArgs?: string;
  lastResultError?: boolean;
  /** 当前连续错误计数（成功清零；逆转判定用） */
  curConsecutiveErrors: number;
  /** transient 状态回落定时 */
  transientTimer: (() => void) | null;
  /** thinking 间隙标记（一次长静默只记 1 次） */
  inThinkingGap: boolean;
}

interface ImpManagerOptions {
  /** 会话标题回退（taskLabel 为空时用；由调用方从会话列表提供） */
  getSessionTitle?: (sessionId: string) => string | undefined;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}

/** 任务标签截断（设计 §3.2：≤14 字符） */
export function truncateTaskLabel(text: string, max = 14): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
}

/** 从 turn/start 事件提取任务标签 */
function extractTaskLabel(data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  const raw = d.userInput ?? d.original_user_input ?? d.message ?? '';
  if (typeof raw === 'string') return truncateTaskLabel(raw);
  return '';
}

export class ImpManager {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly cb: ImpManagerCallbacks;
  private readonly getSessionTitle?: (sessionId: string) => string | undefined;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private tickTimer: (() => void) | null = null;
  private disposed = false;

  constructor(cb: ImpManagerCallbacks, opts: ImpManagerOptions = {}) {
    this.cb = cb;
    this.getSessionTitle = opts.getSessionTitle;
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  start(): void {
    if (this.tickTimer || this.disposed) return;
    // 自续循环走注入的 schedule（测试用手动时钟也能驱动 tick）
    const loop = (): void => {
      if (this.disposed) return;
      this.tick();
      this.tickTimer = this.schedule(loop, TICK_MS);
    };
    loop();
  }

  dispose(): void {
    this.disposed = true;
    if (this.tickTimer) {
      this.tickTimer();
      this.tickTimer = null;
    }
    for (const rt of this.sessions.values()) {
      if (rt.transientTimer) rt.transientTimer();
    }
    this.sessions.clear();
  }

  getActiveSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** 消费一帧 mux 下行（只关心 session/event） */
  handleMuxFrame(frame: DshMuxFrame): void {
    if (this.disposed || frame.type !== 'session/event') return;
    this.handleSessionEvent(frame.sessionId, frame.event);
  }

  /** 消费一条会话事件（测试可直接喂） */
  handleSessionEvent(sessionId: string, event: DshSessionEvent): void {
    const now = this.now();
    switch (event.type) {
      case 'turn/start':
        this.onTurnStart(sessionId, event, now);
        break;
      case 'tool/call':
        this.onToolCall(sessionId, event, now);
        break;
      case 'tool/result':
        this.onToolResult(sessionId, event, now);
        break;
      case 'turn/end':
        this.onTurnEnd(sessionId, event, now);
        break;
      default:
        break;
    }
  }

  /** 会话标题更新（会话列表刷新时回填，改善 taskLabel 回退） */
  setSessionTitle(sessionId: string, title: string): void {
    const rt = this.sessions.get(sessionId);
    if (rt && !rt.stats.taskLabel && title) {
      rt.stats.taskLabel = truncateTaskLabel(title);
      this.emitState(sessionId);
    }
  }

  // ─── 事件处理 ────────────────────────────────────────────────

  private onTurnStart(sessionId: string, event: DshSessionEvent, now: number): void {
    // 同会话旧 turn 未清（异常流）→ 先结算丢弃
    if (this.sessions.has(sessionId)) this.dropSession(sessionId);

    const category = this.classify(extractTaskLabel(event.data), []);
    const rt: SessionRuntime = {
      ...this.createRuntime(sessionId, extractTaskLabel(event.data) || this.getSessionTitle?.(sessionId) || '', now),
      category,
    };
    this.sessions.set(sessionId, rt);
    this.scheduleTransient(sessionId, 'working');
    this.emitState(sessionId);
  }

  private onToolCall(sessionId: string, event: DshSessionEvent, now: number): void {
    const rt = this.ensureSession(sessionId, now);
    if (!rt) return;
    const d = (event.data ?? {}) as Record<string, unknown>;
    const name = String(d.name ?? '');

    rt.stats.toolCalls += 1;
    rt.toolTimestamps.push(now);
    rt.lastEventAt = now;
    rt.lastToolName = name || undefined;
    rt.lastToolArgs = typeof d.arguments === 'string' ? d.arguments : undefined;
    rt.lastResultError = undefined;

    // 分类兜底：有研究类工具出现且尚未定性 → 研究（仅通用时可升级）
    if (rt.category === 'general' && RESEARCH_TOOLS.has(name)) {
      rt.category = 'research';
    }

    this.updateIntensity(rt, now);
    if (rt.phase !== 'milestone' && rt.phase !== 'deliver-big' && rt.phase !== 'acceptance' && rt.phase !== 'alert') {
      rt.phase = 'working';
    }
    this.emitState(sessionId);
  }

  private onToolResult(sessionId: string, event: DshSessionEvent, now: number): void {
    const rt = this.ensureSession(sessionId, now);
    if (!rt) return;
    const d = (event.data ?? {}) as {
      error?: unknown;
      message?: { content?: Array<{ isError?: boolean; type?: string }> };
    };
    const firstBlock = d.message?.content?.[0];
    const isError = Boolean(d.error) || firstBlock?.isError === true;

    rt.lastEventAt = now;
    rt.lastResultError = isError;

    if (isError) {
      rt.stats.errors += 1;
      rt.stats.consecutiveSuccesses = 0;
      rt.curConsecutiveErrors += 1;
      rt.stats.maxConsecutiveErrors = Math.max(
        rt.stats.maxConsecutiveErrors,
        rt.curConsecutiveErrors,
      );
      if (rt.hasImp) this.enterTransient(sessionId, 'trouble');
    } else {
      rt.stats.consecutiveSuccesses += 1;
      rt.curConsecutiveErrors = 0;
      if (rt.stats.maxConsecutiveErrors > 0) rt.stats.recoveredAfterError = true;
      if (
        rt.hasImp &&
        rt.stats.consecutiveSuccesses >= 5 &&
        rt.milestoneCount < 2
      ) {
        rt.milestoneCount += 1;
        rt.stats.consecutiveSuccesses = 0;
        if (rt.phase === 'working') this.enterTransient(sessionId, 'milestone');
      }
    }
    this.emitState(sessionId);
  }

  private onTurnEnd(_sessionId: string, _event: DshSessionEvent, now: number): void {
    const sessionId = _sessionId;
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    // 已结算（重复 turn/end）→ 忽略
    if (rt.stats.endedAt) return;
    if (rt.transientTimer) rt.transientTimer();

    rt.stats.endedAt = now;
    const outcome = rt.stats.errors > 0 ? 'failed' : 'success';
    const durationMs = Math.max(0, now - rt.stats.startedAt);

    // 结算顺序：名场面先判（用未污染的 endedAt），再发 turn-ended，最后离场
    const ruleKey = evaluateSceneRule(rt.stats, now, new Date(now).getHours());
    const payload = {
      sessionId,
      turnId: rt.stats.turnId,
      outcome: outcome as 'success' | 'failed',
      taskLabel: rt.stats.taskLabel,
      stats: {
        toolCalls: rt.stats.toolCalls,
        errors: rt.stats.errors,
        durationMs,
        taskLabel: rt.stats.taskLabel,
      },
    };

    if (ruleKey) {
      this.cb.onScene({
        sessionId,
        turnId: rt.stats.turnId,
        ruleKey,
        detail: {
          toolCalls: rt.stats.toolCalls,
          errors: rt.stats.errors,
          durationMs,
          taskLabel: rt.stats.taskLabel,
        },
      });
    }

    rt.phase = outcome === 'success' ? 'deliver-big' : 'alert';
    this.emitState(sessionId);
    this.cb.onTurnEnded(payload);

    if (outcome === 'success') {
      // 庆祝展示 4s → 进入待验收驻留（验收完成才离场，见 markCompleted）
      this.schedule(() => {
        const cur = this.sessions.get(sessionId);
        if (!cur || cur.stats.turnId !== rt.stats.turnId) return;
        if (cur.hasImp) {
          cur.phase = 'acceptance';
          this.emitState(sessionId);
        } else {
          this.dropSession(sessionId);
        }
      }, 4_000);
    }
    // 失败 → alert 驻留（红色警示；验收/处理完成才离场）
  }

  /**
   * 对账收敛：会话已不在运行列表，但工灵还处于活跃阶段
   * （错过 turn/end / 会话直接停止）→ 收敛到待验收或失败警示。
   */
  settleNotRunning(runningSessionIds: Set<string>, failedMap: Record<string, boolean>): void {
    for (const [sessionId, rt] of this.sessions) {
      if (runningSessionIds.has(sessionId)) continue;
      if (!['appear', 'working', 'thinking', 'trouble', 'milestone'].includes(rt.phase)) continue;
      const failed = failedMap[sessionId] === true;
      rt.phase = failed ? 'alert' : 'acceptance';
      rt.stats.endedAt = rt.stats.endedAt ?? this.now();
      if (rt.transientTimer) rt.transientTimer();
      this.emitState(sessionId);
    }
  }

  /** 验收完成（任务标记完成）→ 工灵离场 */
  markCompleted(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    if (rt.transientTimer) rt.transientTimer();
    rt.phase = 'leaving';
    this.emitState(sessionId);
    this.schedule(() => this.dropSession(sessionId), 600);
  }

  /** 用户手动关闭（浮层上 ✕）→ 工灵离场 */
  dismiss(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    this.markCompleted(sessionId);
  }

  /**
   * 运行中会话对账：running 且尚无工灵的会话 → 补生成（错过 turn/start 的场景：
   * 中途开启剧场 / 会话先于订阅启动）。taskLabel 优先用会话标题。
   */
  syncRunningSessions(running: Array<{ sessionId: string; title?: string }>): void {
    const now = this.now();
    for (const { sessionId, title } of running) {
      if (this.sessions.has(sessionId)) {
        // 已有工灵：回填空的任务标签
        const rt = this.sessions.get(sessionId);
        if (rt && !rt.stats.taskLabel && title) {
          rt.stats.taskLabel = title;
          this.emitState(sessionId);
        }
        continue;
      }
      if (this.countSlottedImps() >= MAX_CONCURRENT_IMPS) continue;
      const rt: SessionRuntime = this.createRuntime(sessionId, title ?? '', now);
      this.sessions.set(sessionId, rt);
      this.scheduleTransient(sessionId, 'working');
      this.emitState(sessionId);
    }
  }

  /** 无 runtime 时的懒创建（工具事件中途到达）；达席位上限则放弃 */
  private ensureSession(sessionId: string, now: number): SessionRuntime | null {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    if (this.countSlottedImps() >= MAX_CONCURRENT_IMPS) return null;
    const rt: SessionRuntime = this.createRuntime(sessionId, this.getSessionTitle?.(sessionId) ?? '', now);
    this.sessions.set(sessionId, rt);
    this.scheduleTransient(sessionId, 'working');
    this.emitState(sessionId);
    return this.sessions.get(sessionId) ?? null;
  }

  private createRuntime(sessionId: string, taskLabel: string, now: number): SessionRuntime {
    return {
      stats: {
        sessionId,
        turnId: `t${now}`,
        startedAt: now,
        taskLabel,
        toolCalls: 0,
        errors: 0,
        maxConsecutiveErrors: 0,
        consecutiveSuccesses: 0,
        recoveredAfterError: false,
        thinkGapsOver90s: 0,
      },
      phase: 'appear',
      category: 'general',
      intensity: 0,
      hasImp: this.countSlottedImps() < MAX_CONCURRENT_IMPS,
      milestoneCount: 0,
      toolTimestamps: [],
      lastEventAt: now,
      curConsecutiveErrors: 0,
      inThinkingGap: false,
      transientTimer: null,
    };
  }

  // ─── tick：thinking 判定 / 强度衰减 ─────────────────────────

  private tick(): void {
    const now = this.now();
    for (const [sessionId, rt] of this.sessions) {
      // thinking：仅 working 且静默 > 90s
      if (rt.hasImp && rt.phase === 'working' && now - rt.lastEventAt > THINKING_AFTER_MS) {
        rt.phase = 'thinking';
        if (!rt.inThinkingGap) {
          rt.inThinkingGap = true;
          rt.stats.thinkGapsOver90s += 1;
        }
        this.emitState(sessionId);
        continue;
      }
      // thinking 退出由 tool 事件驱动（onToolCall 会置 working），这里无需处理
      this.updateIntensity(rt, now);
      this.emitStateIfChanged(sessionId, rt);
    }
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  private enterTransient(sessionId: string, phase: 'trouble' | 'milestone'): void {
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    rt.phase = phase;
    this.emitState(sessionId);
    this.scheduleTransient(sessionId, 'working');
  }

  /** 安排 transient（appear/trouble/milestone）→ working 回落 */
  private scheduleTransient(sessionId: string, target: ImpPhase): void {
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    if (rt.transientTimer) rt.transientTimer();
    rt.transientTimer = this.schedule(() => {
      const cur = this.sessions.get(sessionId);
      if (!cur || cur.phase === 'deliver-big' || cur.phase === 'acceptance' || cur.phase === 'alert' || cur.phase === 'leaving') return;
      if (cur.phase === 'thinking') return; // thinking 不被回落打断
      cur.phase = target;
      cur.inThinkingGap = false;
      this.emitState(sessionId);
    }, TRANSIENT_MS);
  }

  private updateIntensity(rt: SessionRuntime, now: number): void {
    rt.toolTimestamps = rt.toolTimestamps.filter((t) => now - t <= INTENSITY_WINDOW_MS);
    const n = rt.toolTimestamps.length;
    rt.intensity = n >= 10 ? 2 : n >= 3 ? 1 : 0;
  }

  private countSlottedImps(): number {
    let n = 0;
    for (const rt of this.sessions.values()) if (rt.hasImp) n += 1;
    return n;
  }

  private dropSession(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    if (rt.transientTimer) rt.transientTimer();
    this.sessions.delete(sessionId);
    this.cb.onImpRemoved(sessionId);
    // 席位让贤：不主动给历史会话补派（新 turn 自然申请）
  }

  private emitState(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    this.cb.onImpState(this.snapshot(sessionId, rt));
  }

  /** tick 内只在状态真变化时发（thinking/强度），避免每秒重渲染 */
  private emitStateIfChanged(sessionId: string, rt: SessionRuntime): void {
    // snapshot 比较成本可接受（2 只工灵），直接发亦可；保留钩子语义
    this.emitState(sessionId);
    void rt;
  }

  private snapshot(sessionId: string, rt: SessionRuntime): ImpRuntimeState {
    return {
      sessionId,
      turnId: rt.stats.turnId,
      phase: rt.phase,
      category: rt.category,
      taskLabel: rt.stats.taskLabel,
      intensity: rt.intensity,
      startedAt: rt.stats.startedAt,
      lastToolName: rt.lastToolName,
      lastToolArgs: rt.lastToolArgs,
      hasImp: rt.hasImp,
      lastResultError: rt.lastResultError,
      toolCalls: rt.stats.toolCalls,
      errors: rt.stats.errors,
      maxConsecutiveErrors: rt.stats.maxConsecutiveErrors,
    };
  }

  /** 分类器（§3.4：关键词规则，turn/start 定档） */
  classify(taskLabel: string, toolNames: string[]): AgentCategory {
    const text = taskLabel.toLowerCase();
    for (const group of CATEGORY_KEYWORDS) {
      if (group.patterns.some((p) => text.includes(p))) return group.category;
    }
    if (toolNames.length > 0 && toolNames.every((t) => RESEARCH_TOOLS.has(t))) {
      return 'research';
    }
    return 'general';
  }
}
