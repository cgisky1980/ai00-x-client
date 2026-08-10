/**
 * PoW (Proof of Work) 真人验证 — 前端计算工具
 *
 * 登录/注册前先 GET /api/v1/auth/challenge 获取 challenge + difficulty,
 * 然后计算 nonce 使 SHA256(challenge + ":" + nonce) 的前 difficulty 个
 * 十六进制字符为 0, 再随登录请求一起提交。
 *
 * 使用浏览器原生 Web Crypto API 计算 SHA-256, 无需第三方依赖。
 */

export interface ChallengeResponse {
  challenge: string;
  difficulty: number;
  expires_at: number;
  algorithm: string;
}

/** 将 ArrayBuffer 转为十六进制字符串 */
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const hexChars: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hexChars.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return hexChars.join("");
}

/**
 * 计算 PoW nonce
 *
 * 找到 nonce 使 SHA256(challenge + ":" + nonce) 的前 difficulty 个十六进制字符为 0
 *
 * @param challenge 挑战字符串
 * @param difficulty 难度(前 N 个十六进制字符需为 0)
 * @param onProgress 进度回调(可选,用于显示计算进度)
 * @returns 满足条件的 nonce
 */
export async function solvePow(
  challenge: string,
  difficulty: number,
  onProgress?: (attempts: number) => void
): Promise<number> {
  const target = "0".repeat(difficulty);
  const encoder = new TextEncoder();
  let nonce = 0;
  const batchSize = 1000;

  while (true) {
    // 批量计算,减少 await 开销
    for (let i = 0; i < batchSize; i++) {
      const input = `${challenge}:${nonce}`;
      const data = encoder.encode(input);
      // 使用原生 crypto.subtle.digest(异步但高性能)
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashHex = bufferToHex(hashBuffer);

      if (hashHex.startsWith(target)) {
        return nonce;
      }

      nonce++;
    }

    // 报告进度
    if (onProgress) {
      onProgress(nonce);
    }

    // 让出 UI 线程,避免阻塞
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
