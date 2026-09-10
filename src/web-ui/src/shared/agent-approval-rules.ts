/**
 * 会话级工具授权记忆——「总是允许」的客户端实现。
 *
 * 引擎审批词汇只有 allowed-once（每次都问），但应答权在客户端：记住
 * 「本会话 + 工具名」的授权后，后续同类 approval/requested 帧由客户端
 * 自动应答 allowed-once，不再弹卡（TodoOverlay / DshScene / 执行面板 /
 * 会话浮层四处订阅方共用本模块判定）。
 * 会话随客户端退出消亡，故记忆仅运行态、无需持久化。
 */
const allowed = new Set<string>();

function key(sessionId: string, toolName: string): string {
  return `${sessionId}\u0000${toolName}`;
}

/** 记住：本会话内该工具不再询问（点「总是允许」时调用）。 */
export function rememberSessionAllow(sessionId: string, toolName: string): void {
  allowed.add(key(sessionId, toolName));
}

/** 该会话该工具是否已被「总是允许」（帧到达时先查这里，命中即自动应答）。 */
export function isSessionAllowed(sessionId: string, toolName: string): boolean {
  return allowed.has(key(sessionId, toolName));
}

/** 会话结束/移除时清理（防集合无限增长；当前会话随客户端退出自然清空）。 */
export function forgetSessionAllowances(sessionId: string): void {
  const prefix = `${sessionId}\u0000`;
  for (const k of Array.from(allowed)) {
    if (k.startsWith(prefix)) allowed.delete(k);
  }
}
