/**
 * ScheduleAPI — 引擎宿主级定时任务（DSH `dsh-schedule` 的 Remote 方法）。
 *
 * 真源在引擎：本模块只做协议薄封装，规则内容不落本地。
 * - `schedule/catalog` 无参读全量；`schedule/list` 分页；`schedule/view` 单条
 * - `schedule/create` 用 `timing` 判别式（daily/weekly/every/cron/rrule/after/at）
 * - `schedule/edit` 改/删（可带 expectedUpdatedAt 防并发覆盖）
 * - `schedule/run` 立即执行一次；`schedule/history` 投递历史
 * - 投递目标 `target.kind='new'` = 每次触发新建会话（cwd + agentPreset 由我们指定）
 *
 * 与 DshAPI 共用同一 `/dsh-api/{method}` 代理与管理会话 cookie。
 */
const DSH_BASE = import.meta.env.DEV ? 'http://127.0.0.1:2100/dsh-api' : '/dsh-api';

let rpcSeq = 0;

async function rpc<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${DSH_BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `ui-schedule-${Date.now()}-${rpcSeq++}`,
      method,
      payload: { args },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`schedule ${method} failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
  };
  const result = json.result;
  if (!result) throw new Error(`schedule ${method}: empty response`);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** 触发时点（与引擎 wire 契约一致；时间一律带显式时区）。 */
export type ScheduleTiming =
  | { kind: 'after'; after_seconds: number }
  | { kind: 'at'; at: string | { date: string; time: string; time_zone: string } }
  | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: { time: string; time_zone: string } }
  | { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } }
  | { kind: 'cron'; cron: { expression: string; time_zone: string } }
  | { kind: 'rrule'; rrule: string };

/** 投递目标：new = 每次新建会话（我们的自动化用它）。 */
export type ScheduleTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; create?: { cwd?: string; agentPreset?: string } }
  | { kind: 'new'; create?: { cwd?: string; agentPreset?: string } };

export type ScheduleStatus = 'active' | 'paused' | 'ended';

/** 引擎返回的任务行（字段随 kind 不同，这里保留公共部分 + 索引签名）。 */
export interface ScheduleEntry {
  id: string;
  kind: 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule';
  title: string;
  prompt: string;
  scheduledAt: string;
  target: ScheduleTarget;
  status: ScheduleStatus;
  createdAt?: string;
  updatedAt?: string;
  executionActive?: true;
  deliveryFloorEndsAt?: string;
  lastDelivery?: {
    scheduledAt: string;
    deliveredAt: string;
    messageId: string;
    targetSessionId: string;
  };
  /** daily/weekly */
  time?: string;
  timeZone?: string;
  weekdays?: number[];
  /** cron */
  expression?: string;
  /** every */
  everySeconds?: number;
  /** after */
  afterSeconds?: number;
  /** rrule */
  rrule?: string;
}

export interface ScheduleListPage {
  items: ScheduleEntry[];
  shown: number;
  total: number;
  limit: number;
  offset: number;
}

export const scheduleAPI = {
  catalog: (): Promise<ScheduleEntry[]> => rpc<ScheduleEntry[]>('schedule/catalog'),
  list: (request: { active?: boolean; limit?: number; offset?: number } = {}) =>
    rpc<ScheduleListPage>('schedule/list', { request }),
  view: (id: string) => rpc<ScheduleEntry>('schedule/view', { request: { id } }),
  create: (request: {
    title: string;
    prompt: string;
    timing: ScheduleTiming;
    target?: ScheduleTarget;
  }) => rpc<ScheduleEntry>('schedule/create', { request }),
  update: (
    id: string,
    patch: {
      title?: string;
      prompt?: string;
      timing?: ScheduleTiming;
      target?: ScheduleTarget;
      active?: boolean;
    },
    expectedUpdatedAt?: string | null,
  ) =>
    rpc<ScheduleEntry>('schedule/edit', {
      request: {
        id,
        action: 'update',
        patch,
        ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
      },
    }),
  remove: (id: string, expectedUpdatedAt?: string | null) =>
    rpc<unknown>('schedule/edit', {
      request: {
        id,
        action: 'delete',
        ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
      },
    }),
  /** 立即执行一次（调试/手动补跑）。 */
  run: (id: string) => rpc<unknown>('schedule/run', { request: { id } }),
  deliveryLimits: () => rpc<{ newSessionIntervalSeconds: number }>('schedule/deliveryLimits'),
};

export default scheduleAPI;
