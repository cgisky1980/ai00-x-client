import { fetchWithAuth } from '@/infrastructure/auth/fetchWithAuth';

export type Ai00sTier = 'free' | 'vip' | 'svip';

/** 用户套餐档位（新体系：free/basic/pro/flagship） */
export type PlanTier = 'free' | 'basic' | 'pro' | 'flagship';

/** 模型价格区间分组（用于 UI 分组展示） */
export type ModelPriceGroup = 'economy' | 'standard' | 'premium';

export const isAi00sModel = (id: string): boolean =>
  id === 'ai00s' || id.startsWith('ai00s-');

export const mapPlanTierToDisplay = (planTier?: string | null): Ai00sTier => {
  switch (planTier) {
    case 'expensive':
      return 'svip';
    case 'cheap':
      return 'vip';
    default:
      return 'free';
  }
};

/**
 * 判断是否为免费套餐档位（新体系）
 *
 * 免费层用户：plan_tier === 'free'
 * 付费套餐用户：basic / pro / flagship
 */
export const isFreeTier = (planTier?: string | null): boolean => {
  return !planTier || planTier === 'free';
};

export const getAi00sTier = (id: string, userTier?: string | null): Ai00sTier | null => {
  if (id === 'ai00s') {
    return mapPlanTierToDisplay(userTier);
  }
  if (id.startsWith('ai00s-free')) return 'free';
  if (id.startsWith('ai00s-vip')) return 'vip';
  if (id.startsWith('ai00s-svip')) return 'svip';
  return null;
};

export const TIER_DISPLAY: Record<Ai00sTier, string> = {
  free: 'Ai00-Free',
  vip: 'Ai00-VIP',
  svip: 'Ai00-SVIP',
};

export const TIER_COLORS: Record<Ai00sTier, { bg: string; text: string }> = {
  free: { bg: 'rgba(34, 197, 94, 0.15)', text: 'rgba(34, 197, 94, 0.9)' },
  vip: { bg: 'rgba(251, 146, 60, 0.15)', text: 'rgba(251, 146, 60, 0.9)' },
  svip: { bg: 'rgba(168, 85, 247, 0.15)', text: 'rgba(168, 85, 247, 0.9)' },
};

let cachedTier: string | null = null;

export function getCachedTier(): string | null {
  return cachedTier;
}

export function setCachedTier(tier: string | null): void {
  cachedTier = tier;
}

export async function fetchUserTier(): Promise<string | null> {
  if (cachedTier) return cachedTier;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const tier = await invoke<string | null>('fetch_user_tier');
    if (tier) {
      cachedTier = tier;
      return cachedTier;
    }
  } catch {
    // fetch_user_tier command not available or failed
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const authInfo = await invoke<{ plan_tier?: string | null } | null>('get_auth_info');
    if (authInfo?.plan_tier) {
      cachedTier = authInfo.plan_tier;
      return cachedTier;
    }
  } catch {
    // not in Tauri environment
  }

  // 用 fetchWithAuth 调 /ai00-s/api/ai/me(token 和 baseUrl 由 fetchWithAuth 内部处理)
  try {
    const data = await fetchWithAuth<{ code: number; data?: { plan_tier?: string }; plan_tier?: string }>('/ai00-s/api/ai/me');
    const tier = data?.data?.plan_tier || data?.plan_tier;
    if (tier) {
      cachedTier = tier;
      return cachedTier;
    }
  } catch {
    // 未登录或 token 失效
  }

  return null;
}

// ===== 讯飞模型 tier 访问控制 =====

/// tier 排序：free < cheap < expensive（值越小越基础）
const XF_TIER_RANK: Record<string, number> = {
  free: 0,
  cheap: 1,
  expensive: 2,
};

/// 用户能否访问某模型（基于后端返回的 tier：free/cheap/expensive）
///
/// 规则：模型 tier rank <= 用户 tier rank 时可访问
/// - free 用户只能用 free 模型
/// - cheap 用户可用 free + cheap 模型
/// - expensive 用户可用所有模型
export const canAccessModel = (modelTier: string, userTier?: string | null): boolean => {
  const userRank = XF_TIER_RANK[userTier ?? 'free'] ?? 0;
  const modelRank = XF_TIER_RANK[modelTier] ?? 0;
  return modelRank <= userRank;
};

/// 模型定价信息（后端 ai_model_pricing 表）
export interface ModelPricingInfo {
  /** 元/百万输入 tokens */
  input: number;
  /** 元/百万输出 tokens */
  output: number;
  /** 元/百万缓存命中 tokens */
  cached: number;
  /** 货币（CNY） */
  currency: string;
}

/// 上游免费模型每日限流 + 当日用量
export interface FreeQuotaInfo {
  /** 每日请求次数上限（0=不限） */
  daily_request_limit: number;
  /** 每日 token 总量上限（0=不限） */
  daily_token_limit: number;
  /** 单次 max_tokens 上限（0=不限） */
  max_tokens_per_request: number;
  /** 今日已用次数（匿名用户无此字段） */
  used_count_today?: number;
  /** 今日已用 tokens */
  used_tokens_today?: number;
  /** 剩余次数（-1=不限；0=已用完） */
  remaining_count?: number;
  /** 剩余 tokens（-1=不限；0=已用完） */
  remaining_tokens?: number;
}

/// 后端返回的讯飞模型信息
///
/// Phase 3.4 改造后字段：
/// - id: 模型 ID（如 "GLM-4.7-Flash"）
/// - displayName: 显示名
/// - tier: 'free'（保留兼容字段）
/// - isUpstreamFree: 是否上游免费模型（NoneLinear 不收平台费，仍按定价扣 credit）
/// - isDefault: 是否为默认模型（服务器指定，客户端默认选中）
/// - modality: LLM/LMM/Image/Video
/// - producer: 机构（OpenAI/Anthropic/Google/GLM/...）
/// - pricing: 模型定价
/// - freeQuota: 免费模型限流 + 当日用量（仅 isUpstreamFree=true 时有）
export interface Ai00sModelInfo {
  id: string;          // 模型名（如 "GLM-4.7-Flash"），作为 model 字段发给后端
  displayName: string; // 显示名
  tier: string;        // 'free' | 'cheap' | 'expensive'（保留兼容字段）
  /** 是否上游免费模型 */
  isUpstreamFree?: boolean;
  /** 是否为默认模型（服务器指定，客户端默认选中） */
  isDefault?: boolean;
  /** 模态：LLM/LMM/Image/Video */
  modality?: string | null;
  /** 机构：OpenAI/Anthropic/Google/GLM/... */
  producer?: string | null;
  /** 模型定价 */
  pricing?: ModelPricingInfo | null;
  /** 免费模型限流 + 当日用量（仅 isUpstreamFree=true 时有） */
  freeQuota?: FreeQuotaInfo | null;
}

let cachedAi00sModels: Ai00sModelInfo[] | null = null;

export function getCachedAi00sModels(): Ai00sModelInfo[] | null {
  return cachedAi00sModels;
}

export function setCachedAi00sModels(models: Ai00sModelInfo[] | null): void {
  cachedAi00sModels = models;
}

/// 后端 /ai00-s/api/ai/models 返回的原始模型对象
interface RawAi00sModel {
  id: string;
  display_name?: string;
  tier?: string;
  is_upstream_free?: boolean;
  is_default?: boolean;
  modality?: string | null;
  producer?: string | null;
  pricing?: { input?: number; output?: number; cached?: number; currency?: string } | null;
  free_quota?: {
    daily_request_limit?: number;
    daily_token_limit?: number;
    max_tokens_per_request?: number;
    used_count_today?: number;
    used_tokens_today?: number;
    remaining_count?: number;
    remaining_tokens?: number;
  } | null;
}

/// 从后端 /ai00-s/api/ai/models 拉取所有讯飞模型（带 tier + 定价 + 限流）
///
/// 后端返回格式：{code, data: {object: "list", data: [{id, tier, display_name, is_upstream_free, pricing, free_quota, ...}]}}
/// 失败时返回空数组（不抛错，降级为不显示讯飞子模型）
export async function fetchAi00sModels(): Promise<Ai00sModelInfo[]> {
  // 用局部变量保存缓存，避免 async 函数中模块级变量无法 narrow 的问题
  const cached = cachedAi00sModels;
  if (cached) return cached;

  try {
    // 用 GET（简单请求，不触发 CORS 预检）；models.ais 脚本标注 @method GET
    // noAuth: 公开端点,无需 token
    const data = await fetchWithAuth<{ data?: { data?: RawAi00sModel[] } }>('/ai00-s/api/ai/models', {
      method: 'GET',
      noAuth: true,
    });
    const models = data?.data?.data || [];
    const result: Ai00sModelInfo[] = models.map((m) => {
      const info: Ai00sModelInfo = {
        id: m.id,
        displayName: m.display_name || m.id,
        tier: m.tier || 'free',
      };
      if (m.is_upstream_free !== undefined) info.isUpstreamFree = m.is_upstream_free;
      if (m.is_default !== undefined) info.isDefault = m.is_default;
      if (m.modality !== undefined) info.modality = m.modality;
      if (m.producer !== undefined) info.producer = m.producer;
      if (m.pricing) {
        info.pricing = {
          input: m.pricing.input ?? 0,
          output: m.pricing.output ?? 0,
          cached: m.pricing.cached ?? 0,
          currency: m.pricing.currency ?? 'CNY',
        };
      }
      if (m.free_quota) {
        info.freeQuota = {
          daily_request_limit: m.free_quota.daily_request_limit ?? 0,
          daily_token_limit: m.free_quota.daily_token_limit ?? 0,
          max_tokens_per_request: m.free_quota.max_tokens_per_request ?? 0,
          used_count_today: m.free_quota.used_count_today,
          used_tokens_today: m.free_quota.used_tokens_today,
          remaining_count: m.free_quota.remaining_count,
          remaining_tokens: m.free_quota.remaining_tokens,
        };
      }
      return info;
    });
    cachedAi00sModels = result;
    return result;
  } catch {
    return [];
  }
}

// ===== Phase 5.1: 模型分组 + 剩余额度 + 套餐判断 =====

/**
 * 计算模型价格区间分组
 *
 * - economy: 上游免费模型（isUpstreamFree=true），平台收低价 credit
 * - standard: 输入价 <= 10 元/百万 tokens
 * - premium: 输入价 > 10 元/百万 tokens
 */
export const getModelPriceGroup = (model: Ai00sModelInfo): ModelPriceGroup => {
  if (model.isUpstreamFree) return 'economy';
  const inputPrice = model.pricing?.input ?? 0;
  if (inputPrice <= 0) return 'economy';
  if (inputPrice <= 10) return 'standard';
  return 'premium';
};

/**
 * 免费模型剩余额度状态
 *
 * 返回值：
 * - unlimited: 不限（limit=0）
 * - available: 有剩余
 * - exhausted: 已用完（remaining=0）
 * - unknown: 无法判断（匿名用户无 used_count_today）
 */
export type FreeQuotaStatus = 'unlimited' | 'available' | 'exhausted' | 'unknown';

export const getFreeQuotaStatus = (
  freeQuota: FreeQuotaInfo | null | undefined
): FreeQuotaStatus => {
  if (!freeQuota) return 'unknown';
  const { remaining_count, remaining_tokens, daily_request_limit, daily_token_limit } = freeQuota;
  // limit=0 表示不限
  const requestUnlimited = daily_request_limit === 0;
  const tokenUnlimited = daily_token_limit === 0;
  if (requestUnlimited && tokenUnlimited) return 'unlimited';
  // remaining=-1 表示不限（后端约定）
  const requestRemaining = remaining_count ?? -1;
  const tokenRemaining = remaining_tokens ?? -1;
  if (requestRemaining === -1 && tokenRemaining === -1) return 'unlimited';
  if (requestRemaining === 0 || tokenRemaining === 0) return 'exhausted';
  if (requestRemaining === undefined || tokenRemaining === undefined) return 'unknown';
  return 'available';
};

/**
 * 判断模型是否可选（额度未用完）
 */
export const isModelSelectable = (model: Ai00sModelInfo): boolean => {
  if (!model.isUpstreamFree) return true;
  const status = getFreeQuotaStatus(model.freeQuota);
  return status !== 'exhausted';
};

/**
 * 用户套餐信息（从 /ai00-s/api/ai/me 获取）
 */
export interface UserPlanInfo {
  /** 套餐档位：free/basic/pro/flagship */
  planTier: string;
  /** 套餐显示名（如「免费层」「专业版」） */
  planDisplayName: string;
  /** 月费（分） */
  planPriceCents: number;
  /** 每月发放的套餐 credit */
  planMonthlyCredits: number;
  /** 总剩余 credit（套餐剩余 + 充值剩余） */
  totalRemaining: number;
}

let cachedUserPlan: UserPlanInfo | null = null;

export function getCachedUserPlan(): UserPlanInfo | null {
  return cachedUserPlan;
}

export function setCachedUserPlan(plan: UserPlanInfo | null): void {
  cachedUserPlan = plan;
}

/**
 * 拉取用户套餐信息：GET /ai00-s/api/ai/me
 *
 * 解包两层：
 * - me.ais 返回 {code:0, data: ai.me_result}
 * - ai.me_result 是 {code:200, data:{member:{...}, account:{...}}}
 *
 * 失败时返回 null（不抛错，降级为 free 档）
 */
export async function fetchUserPlanInfo(): Promise<UserPlanInfo | null> {
  if (cachedUserPlan) return cachedUserPlan;

  try {
    const data = await fetchWithAuth<{
      code: number;
      data?: {
        code?: number;
        data?: {
          member?: { plan_tier?: string };
          account?: {
            plan_tier?: string;
            plan_display_name?: string;
            plan_price_cents?: number;
            plan_monthly_credits?: number;
            total_remaining?: number;
          };
        };
      };
    }>('/ai00-s/api/ai/me');

    const account = data?.data?.data?.account;
    const memberTier = data?.data?.data?.member?.plan_tier;
    const planTier = account?.plan_tier || memberTier || 'free';

    const result: UserPlanInfo = {
      planTier,
      planDisplayName: account?.plan_display_name || '免费层',
      planPriceCents: account?.plan_price_cents ?? 0,
      planMonthlyCredits: account?.plan_monthly_credits ?? 0,
      totalRemaining: account?.total_remaining ?? 0,
    };
    cachedUserPlan = result;
    // 同步更新旧的 cachedTier（向后兼容）
    cachedTier = planTier;
    return result;
  } catch {
    return null;
  }
}
