/**
 * Billing API（web-ui 版）
 *
 * 封装 Phase 4 新增的 NoneLinear 计费系统端点：
 * - Member 自助查询：/api/v1/me/balance、/me/billing/ledger、/me/recharge/orders、/me/subscriptions
 * - 公开套餐列表：/api/v1/plans
 * - Admin 管理：/api/v1/admin/pricing/*、/admin/billing/*、/admin/members/*、/admin/plans/*
 *
 * 改造：使用 fetchWithAuth 封装，token 和 baseUrl 由内部处理
 * - 401 时自动 refresh + 重试一次
 * - 上层无需手动传 token/baseUrl
 */

import { fetchWithAuth } from '@/infrastructure/auth/fetchWithAuth';

// ============================================================================
// 类型定义
// ============================================================================

/** 会员双账户余额（GET /me/balance 返回） */
export interface MemberBalance {
  plan_tier: string;
  plan_display_name: string;
  plan_price_cents: number;
  plan_monthly_credits: number;
  subscription: {
    total: number;
    used: number;
    remaining: number;
    period_start: string | null;
    period_end: string | null;
    will_reset_at: string | null;
  };
  recharge: {
    total: number;
    used: number;
    remaining: number;
  };
  total_remaining: number;
  total_remaining_yuan: number;
}

/** 计费账本条目（GET /me/billing/ledger 返回） */
export interface BillingEntry {
  id: number;
  member_id: number;
  channel_id: number | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  input_price_per_million: number;
  output_price_per_million: number;
  cached_price_per_million: number;
  cost_credits: number;
  deducted_from_subscription: number;
  deducted_from_recharge: number;
  is_free_model: boolean;
  status: string; // charged / pending / refunded
  request_log_id: number | null;
  created_at: string;
}

/** 充值订单（GET /me/recharge/orders 返回） */
export interface RechargeOrder {
  id: number;
  order_no: string;
  member_id: number;
  amount_cents: number;
  credits: number;
  bonus_credits: number;
  status: string; // pending / paid / cancelled / refunded
  payment_method: string; // manual / wechat / alipay
  payment_channel_order_id: string | null;
  paid_at: string | null;
  operator_id: number | null;
  remark: string | null;
  created_at: string;
  updated_at: string;
}

/** 订阅记录（GET /me/subscriptions 返回） */
export interface SubscriptionRecord {
  id: number;
  member_id: number;
  plan_tier: string;
  action: string; // subscribe / renew / upgrade / downgrade / cancel
  period_start: string;
  period_end: string;
  credits_granted: number;
  amount_cents: number;
  operator_id: number | null;
  created_at: string;
}

/** 套餐定义（GET /plans 返回） */
export interface PlanDefinition {
  id: number;
  plan_tier: string; // free / basic / pro / flagship
  display_name: string;
  price_cents: number;
  monthly_credits: number;
  is_active: boolean;
  features_json: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** 模型定价（admin 用，含未公开） */
export interface ModelPricing {
  id: number;
  model_id: string;
  provider: string;
  producer: string | null;
  modality: string | null;
  input_price_per_million: number;
  output_price_per_million: number;
  cached_input_price_per_million: number;
  currency: string;
  is_active: boolean;
  is_custom: boolean;
  is_public: boolean;
  is_free: boolean;
  free_daily_request_limit: number;
  free_daily_token_limit: number;
  free_max_tokens_per_request: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 免费模型用量（admin 查询） */
export interface FreeModelUsage {
  id: number;
  member_id: number;
  model_id: string;
  usage_date: string;
  request_count: number;
  total_tokens: number;
}

/** PricingScraper 同步统计 */
export interface PricingSyncStats {
  provider: string;
  channel_id: number | null;
  models_fetched: number;
  synced: number;
  skipped_custom: number;
  failed: number;
  total_scraped: number;
}

// ============================================================================
// 统一响应类型
// ============================================================================

interface ApiResp<T> {
  code: number;
  message?: string;
  data: T;
}

/** 列表响应 */
export interface ListResponse<T> {
  items: T[];
  total?: number;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Member 自助查询 API
// ============================================================================

/**
 * 获取自己的双账户余额：GET /api/v1/me/balance
 */
export async function getMyBalance(): Promise<MemberBalance> {
  const resp = await fetchWithAuth<ApiResp<MemberBalance>>('/api/v1/me/balance');
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch balance');
  }
  return resp.data;
}

/**
 * 列出自己的计费明细：GET /api/v1/me/billing/ledger
 */
export async function listMyLedger(
  limit = 50,
  offset = 0
): Promise<ListResponse<BillingEntry>> {
  const resp = await fetchWithAuth<ApiResp<ListResponse<BillingEntry>>>(
    `/api/v1/me/billing/ledger?limit=${limit}&offset=${offset}`
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch ledger');
  }
  return resp.data;
}

/**
 * 列出自己的充值订单：GET /api/v1/me/recharge/orders
 */
export async function listMyRechargeOrders(
  limit = 50,
  offset = 0
): Promise<ListResponse<RechargeOrder>> {
  const resp = await fetchWithAuth<ApiResp<ListResponse<RechargeOrder>>>(
    `/api/v1/me/recharge/orders?limit=${limit}&offset=${offset}`
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch recharge orders');
  }
  return resp.data;
}

/**
 * 列出自己的订阅记录：GET /api/v1/me/subscriptions
 */
export async function listMySubscriptions(
  limit = 50
): Promise<ListResponse<SubscriptionRecord>> {
  const resp = await fetchWithAuth<ApiResp<ListResponse<SubscriptionRecord>>>(
    `/api/v1/me/subscriptions?limit=${limit}`
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch subscriptions');
  }
  return resp.data;
}

// ============================================================================
// 公开套餐列表（无需登录）
// ============================================================================

/**
 * 获取公开套餐列表：GET /api/v1/plans
 * 用于套餐对比页，未登录可访问
 */
export async function listPublicPlans(): Promise<ListResponse<PlanDefinition>> {
  const resp = await fetchWithAuth<ApiResp<ListResponse<PlanDefinition>>>(
    '/api/v1/plans',
    { noAuth: true }
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch plans');
  }
  return resp.data;
}

// ============================================================================
// Admin API — 定价管理
// ============================================================================

export interface ListPricingParams {
  active?: boolean;
  public?: boolean;
  free?: boolean;
  producer?: string;
}

/**
 * 列出所有模型定价（含未公开）：GET /api/v1/admin/pricing
 */
export async function adminListPricing(
  params: ListPricingParams = {}
): Promise<ListResponse<ModelPricing>> {
  const query = new URLSearchParams();
  query.set('active', String(params.active ?? true));
  if (params.public) query.set('public', 'true');
  if (params.free) query.set('free', 'true');
  if (params.producer) query.set('producer', params.producer);

  const resp = await fetchWithAuth<ApiResp<ListResponse<ModelPricing>>>(
    `/api/v1/admin/pricing?${query.toString()}`
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch pricing');
  }
  return resp.data;
}

export interface UpdatePricingBody {
  input_price_per_million?: number;
  output_price_per_million?: number;
  cached_input_price_per_million?: number;
  producer?: string;
  modality?: string;
}

/**
 * 管理员手动覆盖定价：PUT /api/v1/admin/pricing/:model_id
 */
export async function adminUpdatePricing(
  modelId: string,
  body: UpdatePricingBody
): Promise<{ model_id: string; is_custom: boolean }> {
  const resp = await fetchWithAuth<ApiResp<{ model_id: string; is_custom: boolean }>>(
    `/api/v1/admin/pricing/${encodeURIComponent(modelId)}`,
    { method: 'PUT', body: JSON.stringify(body) }
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to update pricing');
  }
  return resp.data;
}

/**
 * 清除 is_custom，恢复抓取值：DELETE /api/v1/admin/pricing/:model_id/custom
 */
export async function adminResetPricing(
  modelId: string
): Promise<{ model_id: string; is_custom: boolean }> {
  const resp = await fetchWithAuth<ApiResp<{ model_id: string; is_custom: boolean }>>(
    `/api/v1/admin/pricing/${encodeURIComponent(modelId)}/custom`,
    { method: 'DELETE' }
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to reset pricing');
  }
  return resp.data;
}

/**
 * 控制模型是否公开：POST /api/v1/admin/pricing/:model_id/public
 */
export async function adminTogglePublic(
  modelId: string,
  isPublic: boolean
): Promise<{ model_id: string; is_public: boolean }> {
  const resp = await fetchWithAuth<ApiResp<{ model_id: string; is_public: boolean }>>(
    `/api/v1/admin/pricing/${encodeURIComponent(modelId)}/public`,
    { method: 'POST', body: JSON.stringify({ is_public: isPublic }) }
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to toggle public');
  }
  return resp.data;
}

/**
 * 标记为上游免费模型：POST /api/v1/admin/pricing/:model_id/free
 */
export async function adminToggleFree(
  modelId: string,
  isFree: boolean
): Promise<{ model_id: string; is_free: boolean }> {
  const resp = await fetchWithAuth<ApiResp<{ model_id: string; is_free: boolean }>>(
    `/api/v1/admin/pricing/${encodeURIComponent(modelId)}/free`,
    { method: 'POST', body: JSON.stringify({ is_free: isFree }) }
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to toggle free');
  }
  return resp.data;
}

export interface SetFreeLimitsBody {
  daily_request_limit: number;
  daily_token_limit: number;
  max_tokens_per_request: number;
}

/**
 * 设置免费模型限流值：PUT /api/v1/admin/pricing/:model_id/free-limits
 */
export async function adminSetFreeLimits(
  modelId: string,
  body: SetFreeLimitsBody
): Promise<{ model_id: string } & SetFreeLimitsBody> {
  const resp = await fetchWithAuth<ApiResp<{ model_id: string } & SetFreeLimitsBody>>(
    `/api/v1/admin/pricing/${encodeURIComponent(modelId)}/free-limits`,
    { method: 'PUT', body: JSON.stringify(body) }
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to set free limits');
  }
  return resp.data;
}

/**
 * 查询某会员某日免费用量：GET /api/v1/admin/pricing/:model_id/usage
 */
export async function adminGetFreeUsage(
  modelId: string,
  memberId: number,
  date?: string
): Promise<{
  member_id: number;
  model_id: string;
  date: string;
  usage: FreeModelUsage | null;
}> {
  const query = new URLSearchParams();
  query.set('member_id', String(memberId));
  if (date) query.set('date', date);

  const resp = await fetchWithAuth<
    ApiResp<{ member_id: number; model_id: string; date: string; usage: FreeModelUsage | null }>
  >(`/api/v1/admin/pricing/${encodeURIComponent(modelId)}/usage?${query.toString()}`);
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch free usage');
  }
  return resp.data;
}

/**
 * 触发抓取定价 + 上游模型同步：POST /api/v1/admin/pricing/sync
 */
export async function adminSyncPricing(): Promise<PricingSyncStats> {
  const resp = await fetchWithAuth<ApiResp<PricingSyncStats>>(
    '/api/v1/admin/pricing/sync',
    { method: 'POST' }
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to sync pricing');
  }
  return resp.data;
}

// ============================================================================
// Admin API — 计费明细 + 会员余额
// ============================================================================

/**
 * 列出会员计费明细：GET /api/v1/admin/billing/ledger?member_id=
 */
export async function adminListLedger(
  memberId: number,
  limit = 50,
  offset = 0
): Promise<ListResponse<BillingEntry>> {
  const resp = await fetchWithAuth<ApiResp<ListResponse<BillingEntry>>>(
    `/api/v1/admin/billing/ledger?member_id=${memberId}&limit=${limit}&offset=${offset}`
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch ledger');
  }
  return resp.data;
}

/**
 * 退款单条账本：POST /api/v1/admin/billing/ledger/:id/refund
 */
export async function adminRefundEntry(ledgerId: number): Promise<{
  ledger_id: number;
  refunded_from_subscription: number;
  refunded_from_recharge: number;
}> {
  const resp = await fetchWithAuth<
    ApiResp<{
      ledger_id: number;
      refunded_from_subscription: number;
      refunded_from_recharge: number;
    }>
  >(`/api/v1/admin/billing/ledger/${ledgerId}/refund`, { method: 'POST' });
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to refund entry');
  }
  return resp.data;
}

/**
 * 查询会员双账户余额：GET /api/v1/admin/members/:id/balance
 */
export async function adminGetMemberBalance(
  memberId: number
): Promise<MemberBalance> {
  const resp = await fetchWithAuth<ApiResp<MemberBalance>>(
    `/api/v1/admin/members/${memberId}/balance`
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch member balance');
  }
  return resp.data;
}

/**
 * 调整充值余额（delta_credits 正负均可）：PUT /api/v1/admin/members/:id/recharge
 */
export async function adminAdjustRecharge(
  memberId: number,
  deltaCredits: number,
  remark?: string
): Promise<{ member_id: number; delta_credits: number; balance: MemberBalance }> {
  const resp = await fetchWithAuth<
    ApiResp<{ member_id: number; delta_credits: number; balance: MemberBalance }>
  >(`/api/v1/admin/members/${memberId}/recharge`, {
    method: 'PUT',
    body: JSON.stringify({ delta_credits: deltaCredits, remark }),
  });
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to adjust recharge');
  }
  return resp.data;
}

/**
 * 手动充值（开发阶段）：POST /api/v1/admin/members/:id/recharge
 */
export async function adminManualRecharge(
  memberId: number,
  body: { amount_cents: number; credits: number; bonus_credits?: number; remark?: string }
): Promise<{
  order_id: number;
  order_no: string;
  member_id: number;
  amount_cents: number;
  credits: number;
  bonus_credits: number;
  total_credits_added: number;
  status: string;
}> {
  const resp = await fetchWithAuth<
    ApiResp<{
      order_id: number;
      order_no: string;
      member_id: number;
      amount_cents: number;
      credits: number;
      bonus_credits: number;
      total_credits_added: number;
      status: string;
    }>
  >(`/api/v1/admin/members/${memberId}/recharge`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to manual recharge');
  }
  return resp.data;
}

/**
 * 列出充值订单：GET /api/v1/admin/recharge/orders
 */
export async function adminListRechargeOrders(params: {
  member_id?: number;
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<ListResponse<RechargeOrder>> {
  const query = new URLSearchParams();
  if (params.member_id) query.set('member_id', String(params.member_id));
  if (params.status) query.set('status', params.status);
  query.set('limit', String(params.limit ?? 50));
  query.set('offset', String(params.offset ?? 0));

  const resp = await fetchWithAuth<ApiResp<ListResponse<RechargeOrder>>>(
    `/api/v1/admin/recharge/orders?${query.toString()}`
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch recharge orders');
  }
  return resp.data;
}

/**
 * 退款充值订单：POST /api/v1/admin/recharge/orders/:order_no/refund
 */
export async function adminRefundRechargeOrder(orderNo: string): Promise<{
  order_no: string;
  member_id: number;
  refunded_credits: number;
  status: string;
}> {
  const resp = await fetchWithAuth<
    ApiResp<{ order_no: string; member_id: number; refunded_credits: number; status: string }>
  >(`/api/v1/admin/recharge/orders/${encodeURIComponent(orderNo)}/refund`, {
    method: 'POST',
  });
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to refund recharge order');
  }
  return resp.data;
}

// ============================================================================
// Admin API — 套餐订阅管理
// ============================================================================

/**
 * 列出会员订阅记录：GET /api/v1/admin/members/:id/subscriptions
 */
export async function adminListSubscriptionRecords(
  memberId: number,
  limit = 50
): Promise<ListResponse<SubscriptionRecord>> {
  const resp = await fetchWithAuth<ApiResp<ListResponse<SubscriptionRecord>>>(
    `/api/v1/admin/members/${memberId}/subscriptions?limit=${limit}`
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch subscription records');
  }
  return resp.data;
}

/**
 * 修改会员订阅（立即生效）：PUT /api/v1/admin/members/:id/subscription
 */
export async function adminChangeSubscription(
  memberId: number,
  planTier: string
): Promise<{
  member_id: number;
  old_plan_tier: string;
  new_plan_tier: string;
  action: string;
  period_start: string;
  period_end: string;
  credits_granted: number;
}> {
  const resp = await fetchWithAuth<
    ApiResp<{
      member_id: number;
      old_plan_tier: string;
      new_plan_tier: string;
      action: string;
      period_start: string;
      period_end: string;
      credits_granted: number;
    }>
  >(`/api/v1/admin/members/${memberId}/subscription`, {
    method: 'PUT',
    body: JSON.stringify({ plan_tier: planTier }),
  });
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to change subscription');
  }
  return resp.data;
}

/**
 * 强制重置当前周期：POST /api/v1/admin/members/:id/subscription/reset
 */
export async function adminResetSubscription(memberId: number): Promise<{
  member_id: number;
  plan_tier: string;
  period_start: string;
  period_end: string;
  credits_granted: number;
}> {
  const resp = await fetchWithAuth<
    ApiResp<{
      member_id: number;
      plan_tier: string;
      period_start: string;
      period_end: string;
      credits_granted: number;
    }>
  >(`/api/v1/admin/members/${memberId}/subscription/reset`, { method: 'POST' });
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to reset subscription');
  }
  return resp.data;
}

// ============================================================================
// Admin API — 套餐定义管理
// ============================================================================

/**
 * 列出所有套餐定义：GET /api/v1/admin/plans
 */
export async function adminListPlans(
  onlyActive = false
): Promise<ListResponse<PlanDefinition>> {
  const resp = await fetchWithAuth<ApiResp<ListResponse<PlanDefinition>>>(
    `/api/v1/admin/plans${onlyActive ? '?active=true' : ''}`
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to fetch plans');
  }
  return resp.data;
}

export interface UpsertPlanBody {
  plan_tier: string;
  display_name: string;
  price_cents?: number;
  monthly_credits?: number;
  is_active?: boolean;
  features_json?: string | null;
  sort_order?: number;
}

/**
 * 创建新套餐：POST /api/v1/admin/plans
 */
export async function adminCreatePlan(
  body: UpsertPlanBody
): Promise<PlanDefinition> {
  const resp = await fetchWithAuth<ApiResp<PlanDefinition>>(
    '/api/v1/admin/plans',
    { method: 'POST', body: JSON.stringify(body) }
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to create plan');
  }
  return resp.data;
}

/**
 * 更新套餐：PUT /api/v1/admin/plans/:tier
 */
export async function adminUpdatePlan(
  tier: string,
  body: Omit<UpsertPlanBody, 'plan_tier'>
): Promise<PlanDefinition> {
  const resp = await fetchWithAuth<ApiResp<PlanDefinition>>(
    `/api/v1/admin/plans/${encodeURIComponent(tier)}`,
    { method: 'PUT', body: JSON.stringify(body) }
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to update plan');
  }
  return resp.data;
}

/**
 * 停用套餐：DELETE /api/v1/admin/plans/:tier
 */
export async function adminDeactivatePlan(
  tier: string
): Promise<{ plan_tier: string; is_active: boolean }> {
  const resp = await fetchWithAuth<ApiResp<{ plan_tier: string; is_active: boolean }>>(
    `/api/v1/admin/plans/${encodeURIComponent(tier)}`,
    { method: 'DELETE' }
  );
  if (resp.code !== 0) {
    throw new Error(resp.message || 'Failed to deactivate plan');
  }
  return resp.data;
}
