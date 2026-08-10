/**
 * 认证工具函数（纯 TS，无平台依赖）
 *
 * 三个前端包（web-ui / loader-ui / underlay-ui）共用的 JWT 工具。
 * 由 packages/shared 统一导出，禁止各包重复定义。
 */

/**
 * 检查 JWT token 是否已过期（仅检查 exp 字段，不验证签名）。
 * 解析失败或无 exp 字段时返回 false（交由服务端 verify 判断）。
 * @param token JWT token 字符串
 * @param bufferSecs 缓冲秒数（默认 10s），提前视为过期以避免边界竞争
 * @returns true 表示已过期（或即将过期）
 */
export function isTokenExpired(token: string, bufferSecs: number = 10): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    // JWT payload 是 base64url 编码，需转为 base64 后 atob
    const base64url = parts[1];
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = atob(padded);
    const claims = JSON.parse(json);
    if (typeof claims.exp !== 'number') return false; // 无 exp 字段，不判断
    // exp 是 Unix 时间戳（秒），留缓冲避免边界竞争
    const now = Math.floor(Date.now() / 1000);
    return now >= claims.exp - bufferSecs;
  } catch {
    return false; // 解析失败不视为过期，交由 verify 判断
  }
}