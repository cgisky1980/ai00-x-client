/**
 * InviteApi — 邀请有礼 API。
 *
 * 契约：《参考/邀请码机制-实施方案设计.md》v2.11 第 1.6/1.9 节。
 * 服务端（Salvo）未上线前调用会失败，上层 UI 需优雅降级（空态 + 错误提示）。
 *
 * 口径纪律：积分只以积分数字展示，严禁出现任何"积分↔人民币换算率"
 * （与 RechargeView/MembershipView 同一纪律）。券面额为会员抵扣金额，
 * 兑换所需分红由服务端按真实充值档位派生，客户端不做任何折算。
 */

import { fetchWithAuth } from '@/infrastructure/auth/fetchWithAuth';
import type { ListResponse } from './BillingApi';

/** 与 BillingApi 内部一致的统一响应包裹（该类型未导出，此处本地声明） */
interface ApiResp<T> {
  code: number;
  message?: string;
  data: T;
}

/**
 * 老版本服务端（未部署邀请模块）会把 API 路径回落到 SPA index.html，
 * 返回 200 + HTML：解析出的对象没有数字 code。识别并给出可读报错。
 */
function assertInviteResp<T>(resp: ApiResp<T>, fallback: string): T {
  if (typeof resp.code !== 'number') {
    throw new Error('当前服务器未开放邀请功能（版本过旧），请切换服务器后重试');
  }
  if (resp.code !== 0) {
    throw new Error(resp.message || fallback);
  }
  return resp.data;
}

/** 邀请名额（基础 + 消费解锁 + 有效激活回补） */
export interface InviteQuota {
  base: number;
  unlocked: number;
  refunded: number;
  total: number;
  used: number;
  left: number;
}

/** 领码状态 */
export type InviteCodeStatus = 'unclaimed' | 'claimed';

/** 邀请总览（GET /me/invites/summary） */
export interface InviteSummary {
  quota: InviteQuota;
  /** 已邀请人数（注册即计） */
  invited_count: number;
  /** 有效邀请数（被邀请人已首充） */
  activated_count: number;
  /** 本月待结算分红（实时累计，月底结算，当前不可用） */
  month_accrued: number;
  /** 累计已入账分红 */
  rewards_total: number;
  code_status: InviteCodeStatus;
  invite_code: string | null;
  share_url: string | null;
  /** 已解锁的券档 key（累计付费邀请数达标） */
  coupon_unlocked: string[];
}

/** 邀请记录条目（GET /me/invites/list） */
export interface InviteeEntry {
  id: number;
  /** 昵称打码（好友***n） */
  nickname_masked: string;
  registered_at: string;
  /** pending 未充值 / activated 已首充 / retained 留存达标 */
  status: 'pending' | 'activated' | 'retained';
  /** 待结算分红（accrued） */
  reward_accrued: number;
  /** 已入账分红 */
  reward_paid: number;
}

/** 券档定义（GET /me/invites/coupons 返回，服务端派生兑换价） */
export interface InviteCouponTier {
  key: string;
  /** 目标会员档位（basic/pro/flagship） */
  plan_tier: string;
  /** 折扣率（0.9 = 9 折） */
  discount: number;
  /** 兑换所需分红（服务端按月费积分价×折扣率派生） */
  cost: number;
  /** 每月限兑张数 */
  monthly_limit: number;
  /** 本月已兑张数 */
  exchanged_this_month: number;
  /** 是否已解锁（累计付费邀请数达标） */
  unlocked: boolean;
  /** 未解锁时的进度提示（服务端文案，如"还差 2 位付费好友"） */
  lock_hint: string | null;
}

/** 我的会员券（GET /me/invites/coupons 返回） */
export interface InviteCoupon {
  id: number;
  plan_tier: string;
  /** 折扣率（0.9 = 9 折） */
  discount: number;
  status: 'active' | 'used' | 'expired';
  expires_at: string;
}

export interface InviteCouponsPayload {
  tiers: InviteCouponTier[];
  coupons: InviteCoupon[];
}

/** 券包响应（契约中与兑换所需分红一并返回） */
export async function getInviteSummary(): Promise<InviteSummary> {
  const resp = await fetchWithAuth<ApiResp<InviteSummary>>('/api/v1/me/invites/summary');
  return assertInviteResp(resp, 'Failed to fetch invite summary');
}

/** 邀请记录 */
export async function listInvitees(limit = 50, offset = 0): Promise<ListResponse<InviteeEntry>> {
  const resp = await fetchWithAuth<ApiResp<ListResponse<InviteeEntry>>>(
    `/api/v1/me/invites/list?limit=${limit}&offset=${offset}`
  );
  return assertInviteResp(resp, 'Failed to fetch invite list');
}

/** 领取邀请码：无码且名额 > 0 时发放终身唯一码，并预扣 1 个名额。
 * 注意：服务端只返回 { code_status, invite_code, share_url }，不是完整
 * InviteSummary，调用方需自行合并/重拉总览。 */
export async function claimInviteCode(): Promise<Partial<InviteSummary>> {
  const resp = await fetchWithAuth<ApiResp<Partial<InviteSummary>>>(
    '/api/v1/me/invites/claims',
    { method: 'POST' }
  );
  return assertInviteResp(resp, '领取邀请码失败');
}

/** 券包：我的券 + 各档兑换所需分红/解锁状态 */
export async function getInviteCoupons(): Promise<InviteCouponsPayload> {
  const resp = await fetchWithAuth<ApiResp<InviteCouponsPayload>>('/api/v1/me/invites/coupons');
  return assertInviteResp(resp, 'Failed to fetch coupons');
}

/** 用分红兑换一张会员打折券 */
export async function exchangeCoupon(tierKey: string): Promise<InviteCouponsPayload> {
  const resp = await fetchWithAuth<ApiResp<InviteCouponsPayload>>(
    '/api/v1/me/invites/coupons/exchange',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier: tierKey }) }
  );
  return assertInviteResp(resp, '兑换失败');
}
