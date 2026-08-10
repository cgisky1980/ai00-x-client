/**
 * Account API（web-ui 版）
 *
 * 提供：
 * - 类型：MemberProfileResponse、ProfileUpdateFields、ProfileUpdateResponse
 * - 函数：getMemberProfile()、updateMemberProfile(fields)
 *
 * 改造：使用 fetchWithAuth 封装,token 和 baseUrl 由内部处理
 * - 401 时自动 refresh + 重试一次
 * - 上层无需手动传 token/baseUrl
 */

import { fetchWithAuth } from '@/infrastructure/auth/fetchWithAuth';

// ai00-salvo /ai00-s/api/ai/me 返回结构
export interface MemberProfileResponse {
  member: {
    id: number;
    username: string;
    email: string;
    plan_tier: string;
    status: string;
    created_at: string;
    invite_code?: string;
    invite_by?: number | null;
    // 扩展资料字段（可选，未设置时为 null）
    avatar_data?: string | null;
    nickname?: string | null;
    bio?: string | null;
    phone?: string | null;
    location?: string | null;
    website?: string | null;
    birthdate?: string | null;
    gender?: string | null;
    preferred_language?: string | null;
    timezone?: string | null;
    theme?: string | null;
  };
  quota: {
    total_tokens: number;
    used_tokens: number;
    unlimited: boolean;
  };
  subscriptions: unknown[];
}

// /ai00-s/api/ai/profile_update 请求字段（任意子集）
export interface ProfileUpdateFields {
  avatar_data?: string | null;
  nickname?: string;
  bio?: string;
  phone?: string;
  location?: string;
  website?: string;
  birthdate?: string;
  gender?: string;
  preferred_language?: string;
  timezone?: string;
  theme?: string;
}

// /ai00-s/api/ai/profile_update 返回的 profile 数据
export interface ProfileUpdateResponse {
  avatar_data: string | null;
  nickname: string | null;
  bio: string | null;
  phone: string | null;
  location: string | null;
  website: string | null;
  birthdate: string | null;
  gender: string | null;
  preferred_language: string | null;
  timezone: string | null;
  theme: string | null;
}

/**
 * 获取会员档案：GET /ai00-s/api/ai/me
 *
 * 响应结构：
 *   me.ais 返回 {code:0, data: ai.me_result}
 *   ai.me_result 是 {code:200, data:{member:{...}}}
 *   需要解包两层
 *
 * token 和 baseUrl 由 fetchWithAuth 内部处理(401 自动 refresh + 重试)
 */
export async function getMemberProfile(): Promise<MemberProfileResponse> {
  const data = await fetchWithAuth<{ code: number; message?: string; data: unknown }>('/ai00-s/api/ai/me');
  if (data.code !== 0) {
    throw new Error(data.message || 'Failed to fetch profile');
  }
  // 第一层解包 me.ais 的 {code:0, data: result}
  const result = data.data;
  // 第二层解包 ai.me 的 {code:200, data:{member:...}}
  if (result && typeof result === 'object' && 'code' in result && 'data' in result) {
    const inner = (result as { data: unknown }).data;
    if (inner && typeof inner === 'object' && 'member' in inner) {
      return inner as MemberProfileResponse;
    }
  }
  return result as MemberProfileResponse;
}

/**
 * 更新会员资料：POST /ai00-s/api/ai/profile_update
 * 仅更新提供的字段（部分更新）
 *
 * token 和 baseUrl 由 fetchWithAuth 内部处理(401 自动 refresh + 重试)
 */
export async function updateMemberProfile(
  fields: ProfileUpdateFields
): Promise<ProfileUpdateResponse> {
  const data = await fetchWithAuth<{ code: number; message?: string; data: ProfileUpdateResponse }>(
    '/ai00-s/api/ai/profile_update',
    {
      method: 'POST',
      body: JSON.stringify(fields),
    }
  );
  if (data.code !== 0) {
    throw new Error(data.message || 'Failed to update profile');
  }
  return data.data;
}
