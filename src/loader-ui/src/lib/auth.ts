import { invoke } from "@tauri-apps/api/core";
import { isTokenExpired, type AuthInfo } from "@ai00-x/shared";
export { isTokenExpired, type AuthInfo };

export async function setLoggedIn(
  username: string,
  token: string,
  planTier?: string,
  memberId?: number | null
): Promise<void> {
  await invoke("set_auth_info", {
    token,
    username,
    planTier: planTier ?? null,
    memberId: memberId ?? null,
  });
}

/**
 * P4-L3: 写入 access + refresh token 对(用于 Rust API /api/v1/auth/member/* 路径)
 * 与 setLoggedIn 区别:同时持久化 refresh_token,启用自动刷新能力
 */
export async function setLoggedInPair(
  username: string,
  accessToken: string,
  refreshToken: string,
  planTier?: string,
  memberId?: number | null
): Promise<void> {
  await invoke("set_auth_info_pair", {
    token: accessToken,
    refreshToken,
    username,
    planTier: planTier ?? null,
    memberId: memberId ?? null,
  });
}

// P4-L2: 设备绑定相关 - 获取本机机器码和设备名
export async function getMachineCode(): Promise<string> {
  try {
    return await invoke<string>("get_machine_id");
  } catch {
    return "";
  }
}

export async function getDeviceName(): Promise<string> {
  try {
    return await invoke<string>("get_device_name");
  } catch {
    return "";
  }
}
export async function getToken(): Promise<string | null> {
  const info = await getCurrentUser();
  return info?.token ?? null;
}

/** P4-L3: 获取 refresh token(用于 tokenManager 自动刷新) */
export async function getRefreshToken(): Promise<string | null> {
  const info = await getCurrentUser();
  return info?.refresh_token ?? null;
}
export async function getCurrentUser(): Promise<AuthInfo | null> {
  try {
    return await invoke<AuthInfo | null>("get_auth_info");
  } catch {
    // invoke 失败时视为未登录（纯 Tauri，不降级到 sessionStorage）
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await invoke("clear_auth_info");
  } catch {
    // 非 Tauri 环境（纯 web dev），无操作
  }
}
export async function isAuthenticated(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_authenticated");
  } catch {
    // invoke 失败时视为未认证（纯 Tauri，不降级到 sessionStorage）
    return false;
  }
}
export async function restoreAuthFromVault(): Promise<boolean> {
  try {
    return await invoke<boolean>("restore_auth_from_vault");
  } catch {
    return false;
  }
}

// === Profile sync (cross-device) ===

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  errors: string[];
}

/** Upload local profile to server (before unbind or manual sync). */
export async function uploadProfile(): Promise<SyncResult> {
  return await invoke<SyncResult>("sync_profile_upload");
}

/** Download profile from server and apply to local (after login on new device). */
export async function downloadProfile(): Promise<SyncResult> {
  return await invoke<SyncResult>("sync_profile_download");
}

/** Clear local profile data (after unbind). */
export async function clearLocalProfile(): Promise<void> {
  await invoke("sync_profile_clear_local");
}
