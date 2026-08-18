import { getApiUrl } from "./config";
import { getMachineCode, getDeviceName } from "./auth";
import { fetchWithAuth, AuthError, getInternalToken } from "./fetchWithAuth";
import { solvePow, type ChallengeResponse } from "./pow";
import { isApiError, unwrapApiResponse, type ApiError } from "@ai00-x/shared";
export type { ApiError };

// P4-L2: 设备绑定错误码
export const DEVICE_BIND_ERROR_CODES = {
  ACCOUNT_BOUND_OTHER_DEVICE: 4020,
  DEVICE_BOUND_OTHER_ACCOUNT: 4021,
  NO_DEVICE_BINDING: 4022,
  MONTHLY_UNBIND_LIMIT: 4023,
  MACHINE_BIND_LIMIT: 4024,
} as const;

export class DeviceBindError extends Error {
  code: number;
  /** Optional payload (e.g. {used, limit}) returned by server for limit-exceeded errors. */
  data?: { used?: number; limit?: number };
  constructor(code: number, message: string, data?: { used?: number; limit?: number }) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "DeviceBindError";
  }
}

// Re-export AuthError 让上层容易捕获 401 错误
export { AuthError };

// === 兼容旧 API:apiFetchJson / apiFetchJsonNoAuth 改为 fetchWithAuth 的 wrapper ===
// 新代码应直接用 fetchWithAuth,旧调用方仍可工作,并自动获得 401 自动刷新能力

export async function apiFetchJson<T = unknown>(
  url: string,
  init?: RequestInit
): Promise<T> {
  return fetchWithAuth<T>(url, init);
}

export async function apiFetchJsonNoAuth<T = unknown>(
  url: string,
  init?: RequestInit
): Promise<T> {
  return fetchWithAuth<T>(url, { ...init, noAuth: true });
}

export interface LoginResponse {
  token: string;
  member_id: number;
  username: string;
}

/**
 * Rust API /api/v1/auth/member/login 返回结构
 * (脚本 login 后用 username+password 二次调 Rust login 拿 token 对)
 */
export interface RustLoginResponse {
  access_token: string;
  refresh_token: string;
  member: {
    id: number;
    username: string;
    email: string;
    plan_tier: string;
  };
}

/** Rust API /api/v1/auth/member/logout 请求体 */
export interface RustLogoutRequest {
  refresh_token?: string;
}

export interface InviteLockResponse {
  registration_id: string;
  expires_in: number;
}

export interface RegisterResponse {
  token: string;
  member_id: number;
  username: string;
  email: string;
}

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
    // P3-14: 扩展资料字段（可选，未设置时为 null）
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
    remaining: number;
  };
  subscriptions: unknown[];
}

// /ai00-s/api/ai/profile_update 请求字段（任意子集）
export interface ProfileUpdateFields {
  avatar_data?: string;
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

// /ai00-s/api/auth/verify 返回结构
export interface VerifyResponse {
  member_id: number;
  username: string;
  email: string;
  created_at: string;
}

export const authApi = {
  // 会员登录：POST /ai00-s/api/auth/login {identifier, password, machine_code, device_name}
  // 自动注入本机 machine_code + device_name（Tauri 环境）
  login: async (params: {
    identifier: string;
    password: string;
  }): Promise<LoginResponse> => {
    // P4-L2: 自动获取本机机器码和设备名（非 Tauri 环境返回空字符串，服务器会跳过设备验证）
    const [machineCode, deviceName] = await Promise.all([
      getMachineCode(),
      getDeviceName(),
    ]);
    const body = {
      ...params,
      machine_code: machineCode || undefined,
      device_name: deviceName || undefined,
    };
    const result = await apiFetchJsonNoAuth<{ code: number; data: LoginResponse } | ApiError>(
      "/ai00-s/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
    if (isApiError(result)) {
      // 设备绑定错误抛出专用类型，前端可识别并引导用户解绑
      if (
        result.code === DEVICE_BIND_ERROR_CODES.ACCOUNT_BOUND_OTHER_DEVICE ||
        result.code === DEVICE_BIND_ERROR_CODES.DEVICE_BOUND_OTHER_ACCOUNT ||
        result.code === DEVICE_BIND_ERROR_CODES.MACHINE_BIND_LIMIT
      ) {
        // 4024 (MACHINE_BIND_LIMIT) 携带 {used, limit} 信息供前端展示
        const errorData = (result as { data?: { used?: number; limit?: number } }).data;
        throw new DeviceBindError(result.code, result.message, errorData);
      }
      throw new Error(result.message);
    }
    return unwrapApiResponse<LoginResponse>(result);
  },

  // 锁定邀请码：POST /ai00-s/api/auth/invite_lock {invite_code}
  inviteLock: async (invite_code: string): Promise<InviteLockResponse> => {
    const result = await apiFetchJsonNoAuth<{ code: number; data: InviteLockResponse } | ApiError>(
      "/ai00-s/api/auth/invite_lock",
      {
        method: "POST",
        body: JSON.stringify({ invite_code }),
      }
    );
    if (isApiError(result)) throw new Error(result.message);
    return unwrapApiResponse<InviteLockResponse>(result);
  },

  // 发送邮箱验证码：POST /ai00-s/api/auth/email_send_code {email}
  // 注意：万能邀请码 000000000000 跳过邮箱验证，无需调用此接口
  emailSendCode: async (email: string): Promise<void> => {
    const result = await apiFetchJsonNoAuth<{ code: number } | ApiError>(
      "/ai00-s/api/auth/email_send_code",
      {
        method: "POST",
        body: JSON.stringify({ email }),
      }
    );
    if (isApiError(result)) throw new Error(result.message);
  },

  // 会员注册：POST /ai00-s/api/auth/register
  // 万能邀请码时 code 可任意填（脚本跳过邮箱验证）
  register: async (params: {
    registration_id: string;
    email: string;
    code: string;
    username: string;
    password: string;
  }): Promise<RegisterResponse> => {
    const result = await apiFetchJsonNoAuth<{ code: number; data: RegisterResponse } | ApiError>(
      "/ai00-s/api/auth/register",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    );
    if (isApiError(result)) throw new Error(result.message);
    return unwrapApiResponse<RegisterResponse>(result);
  },

  // 验证 token：POST /ai00-s/api/auth/verify (Authorization: Bearer <token>)
  verify: async (): Promise<VerifyResponse> => {
    const result = await apiFetchJson<{ code: number; data: VerifyResponse } | ApiError>(
      "/ai00-s/api/auth/verify",
      { method: "POST" }
    );
    if (isApiError(result)) throw new Error(result.message);
    return unwrapApiResponse<VerifyResponse>(result);
  },

  // 获取会员档案：GET /ai00-s/api/ai/me (Authorization: Bearer <token>)
  // 响应结构：me.ais 返回 {code:0, data: ai.me_result}
  //          ai.me_result 是 {code:200, data:{member:{...}}}
  //          unwrapApiResponse 解包第一层后，还需解包第二层 data.member
  getMemberProfile: async (token: string): Promise<MemberProfileResponse> => {
    const fullUrl = await getApiUrl("/ai00-s/api/ai/me");
    const resp = await fetch(fullUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "X-Ai00-Internal-Token": await getInternalToken(),
      },
    });
    const text = await resp.text();
    const data = JSON.parse(text);
    if (isApiError(data)) throw new Error(data.message);
    // 第一层：解包 me.ais 的 {code:0, data: result}
    let result = unwrapApiResponse<MemberProfileResponse>(data);
    // 第二层：ai.me 返回 {code:200, data:{member:...}}，再解包
    if (result && typeof result === "object" && "code" in result && "data" in result) {
      const inner = (result as { code: number; data: unknown }).data;
      if (inner && typeof inner === "object" && "member" in inner) {
        return inner as MemberProfileResponse;
      }
    }
    return result;
  },

  // 更新会员资料：POST /ai00-s/api/ai/profile_update (Authorization: Bearer <token>)
  // 仅更新提供的字段（部分更新）
  updateMemberProfile: async (
    token: string,
    fields: ProfileUpdateFields
  ): Promise<ProfileUpdateResponse> => {
    const fullUrl = await getApiUrl("/ai00-s/api/ai/profile_update");
    const resp = await fetch(fullUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Ai00-Internal-Token": await getInternalToken(),
      },
      body: JSON.stringify(fields),
    });
    const text = await resp.text();
    const data = JSON.parse(text);
    if (isApiError(data)) throw new Error(data.message);
    return unwrapApiResponse<ProfileUpdateResponse>(data);
  },

  // === P4-L2: 设备绑定管理 ===

  // 查询设备绑定状态：GET /ai00-s/api/auth/device_status
  deviceStatus: async (): Promise<DeviceStatusResponse> => {
    const result = await apiFetchJson<{ code: number; data: DeviceStatusResponse } | ApiError>(
      "/ai00-s/api/auth/device_status",
      { method: "GET" }
    );
    if (isApiError(result)) throw new Error(result.message);
    return unwrapApiResponse<DeviceStatusResponse>(result);
  },

  // 发送设备解绑验证码：POST /ai00-s/api/auth/device_send_code
  // 邮箱地址由服务器从会员记录查询，前端无需传入
  deviceSendCode: async (): Promise<DeviceSendCodeResponse> => {
    const result = await apiFetchJson<{ code: number; data: DeviceSendCodeResponse } | ApiError>(
      "/ai00-s/api/auth/device_send_code",
      { method: "POST" }
    );
    if (isApiError(result)) throw new Error(result.message);
    return unwrapApiResponse<DeviceSendCodeResponse>(result);
  },

  // 设备解绑（验证邮箱验证码）：POST /ai00-s/api/auth/device_unbind {code}
  deviceUnbind: async (code: string): Promise<DeviceUnbindResponse> => {
    const result = await apiFetchJson<{ code: number; data: DeviceUnbindResponse } | ApiError>(
      "/ai00-s/api/auth/device_unbind",
      {
        method: "POST",
        body: JSON.stringify({ code }),
      }
    );
    if (isApiError(result)) throw new Error(result.message);
    return unwrapApiResponse<DeviceUnbindResponse>(result);
  },

  // 忘记密码：发送重置验证码（公开 API，无需 token）
  // identifier 为用户名或邮箱
  forgotPasswordSendCode: async (
    identifier: string
  ): Promise<{ sent: boolean; email_masked: string }> => {
    const result = await apiFetchJsonNoAuth<
      { code: number; data: { sent: boolean; email_masked: string } } | ApiError
    >("/ai00-s/api/auth/forgot_password_send_code", {
      method: "POST",
      body: JSON.stringify({ identifier }),
    });
    if (isApiError(result)) throw new Error(result.message);
    return unwrapApiResponse<{ sent: boolean; email_masked: string }>(result);
  },

  // 忘记密码：重置密码（公开 API，无需 token）
  // 验证邮箱验证码后设置新密码
  forgotPasswordReset: async (params: {
    identifier: string;
    code: string;
    new_password: string;
  }): Promise<{ reset: boolean }> => {
    const result = await apiFetchJsonNoAuth<
      { code: number; data: { reset: boolean } } | ApiError
    >("/ai00-s/api/auth/forgot_password_reset", {
      method: "POST",
      body: JSON.stringify(params),
    });
    if (isApiError(result)) throw new Error(result.message);
    return unwrapApiResponse<{ reset: boolean }>(result);
  },

  // === P4-L3: Rust API /api/v1/auth/member/* ===

  /**
   * Rust API 登录:POST /api/v1/auth/member/login {username, password, challenge, nonce}
   * 不带 machine_code/device_name(不做设备绑定,由脚本路径 login 触发设备绑定)
   * 返回 access + refresh token 对
   *
   * PoW 流程: 先 GET /api/v1/auth/challenge 获取 challenge, 客户端计算 nonce,
   * 再随登录请求一起提交。
   */
  loginRust: async (params: {
    username: string;
    password: string;
  }): Promise<RustLoginResponse> => {
    // 1. 获取 PoW challenge
    const challengeResult = await apiFetchJsonNoAuth<
      { code: number; data: ChallengeResponse } | ApiError
    >("/api/v1/auth/challenge", { method: "GET" });
    if (isApiError(challengeResult)) {
      throw new Error(challengeResult.message);
    }
    const challenge = unwrapApiResponse<ChallengeResponse>(challengeResult);

    // 2. 计算 nonce 使 SHA256(challenge:nonce) 前 difficulty 个十六进制字符为 0
    const nonce = await solvePow(challenge.challenge, challenge.difficulty);

    // 3. 带上 challenge + nonce 登录
    const result = await apiFetchJsonNoAuth<{ code: number; data: RustLoginResponse } | ApiError>(
      "/api/v1/auth/member/login",
      {
        method: "POST",
        body: JSON.stringify({
          username: params.username,
          password: params.password,
          challenge: challenge.challenge,
          nonce,
        }),
      }
    );
    if (isApiError(result)) throw new Error(result.message);
    return unwrapApiResponse<RustLoginResponse>(result);
  },

  /**
   * Rust API 登出:POST /api/v1/auth/member/logout {refresh_token?}
   * 需 Authorization: Bearer <access_token>(由 fetchWithAuth 自动注入)
   * 同时吊销 access_token 和可选的 refresh_token
   */
  logout: async (refreshToken?: string): Promise<void> => {
    const result = await apiFetchJson<{ code: number; data: { message: string } } | ApiError>(
      "/api/v1/auth/member/logout",
      {
        method: "POST",
        body: JSON.stringify({ refresh_token: refreshToken } as RustLogoutRequest),
      }
    );
    if (isApiError(result)) throw new Error(result.message);
  },

  /**
   * Rust API 修改密码:PUT /api/v1/auth/member/password {old_password, new_password}
   * 改密成功后服务端会将当前 access token 加入黑名单,前端需重新登录
   */
  changePassword: async (oldPassword: string, newPassword: string): Promise<void> => {
    const result = await apiFetchJson<{ code: number; data: { message: string } } | ApiError>(
      "/api/v1/auth/member/password",
      {
        method: "PUT",
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      }
    );
    if (isApiError(result)) throw new Error(result.message);
  },
};

// P4-L2: 设备绑定状态
export interface DeviceStatusResponse {
  bound: boolean;
  machine_code: string | null;
  device_name: string | null;
  bound_at: string | null;
  last_seen_at: string | null;
}

// P4-L2: 发送解绑验证码响应
export interface DeviceSendCodeResponse {
  sent: boolean;
  email_masked: string;
}

// P4-L2: 解绑响应
export interface DeviceUnbindResponse {
  unbound: boolean;
  machine_code: string;
  device_name: string;
}
