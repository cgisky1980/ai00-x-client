/**
 * Todo core XP API — 服务器游戏化账本（用户扩展属性）。
 *
 * 任务数据不上服务器（本地 todo_store_*）；仅 XP/勋章/等级/金币/连续
 * 天数经 `/api/v1/me/xp/*` 读写，跨设备跟账号走。
 * 模式照抄 BillingApi：fetchWithAuth + ApiResp 解包。
 */
import { fetchWithAuth } from '../../../infrastructure/auth/fetchWithAuth';
import type { XpEvent, XpProfile } from './types';

interface ApiResp<T> {
  code: number;
  message?: string;
  data: T;
}

/** 派生游戏化档案：GET /api/v1/me/xp/profile */
export async function getXpProfile(): Promise<XpProfile> {
  const resp = await fetchWithAuth<ApiResp<XpProfile>>('/api/v1/me/xp/profile');
  if (resp.code !== 0) throw new Error(resp.message || 'Failed to fetch xp profile');
  return resp.data;
}

/**
 * 追加 XP 事件：POST /api/v1/me/xp/events
 * 服务器按 kind 做防刷去重（task_done 按 taskId / badge_unlock 按 badgeId /
 * day_check 每日一条），重复事件幂等接受不入账。
 */
export async function addXpEvent(
  kind: string,
  amount: number,
  meta: Record<string, unknown> = {}
): Promise<{ deduplicated: boolean; id: number }> {
  const resp = await fetchWithAuth<ApiResp<{ deduplicated: boolean; id: number }>>(
    '/api/v1/me/xp/events',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, amount, meta }),
    }
  );
  if (resp.code !== 0) throw new Error(resp.message || 'Failed to add xp event');
  return resp.data;
}

/** XP 事件流水：GET /api/v1/me/xp/history?limit= */
export async function listXpEvents(limit = 100): Promise<XpEvent[]> {
  const resp = await fetchWithAuth<ApiResp<{ events: XpEvent[] }>>(
    `/api/v1/me/xp/history?limit=${limit}`
  );
  if (resp.code !== 0) throw new Error(resp.message || 'Failed to fetch xp history');
  return resp.data.events;
}
