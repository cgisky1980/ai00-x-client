// ========================================================================
// dsh 会话唤起桥：AgentCard「打开会话」→ DshScene（懒加载）选中会话
// ========================================================================
// DshScene 是 React.lazy 组件：弹 AgentCard 时可能尚未挂载、事件监听未注册。
// 用模块级 pending 变量跨越加载边界：先记 pending 再开场景，
// DshScene 挂载时 consume；已挂载则走事件即时选中。

let pendingSessionId: string | null = null;

/** 请求打开 dsh 场景并选中会话（幂等，跨加载边界） */
export function requestDshSession(sessionId: string): void {
  pendingSessionId = sessionId;
  window.dispatchEvent(new CustomEvent('scene:open', { detail: { sceneId: 'dsh' } }));
  window.dispatchEvent(new CustomEvent('dsh:open-session', { detail: { sessionId } }));
}

/** DshScene 挂载/激活时取走 pending 会话（取走即清） */
export function consumePendingDshSession(): string | null {
  const id = pendingSessionId;
  pendingSessionId = null;
  return id;
}
