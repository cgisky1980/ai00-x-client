/**
 * 子代理卡「就地展开」的定位信号。
 *
 * 汇总条点某一行时，把对应卡片展开并滚到可见位置——不离开当前对话、
 * 不在中区开标签。只用进程内回调，不引入新的状态容器或协议。
 */
type Listener = (childSessionId: string) => void;

const listeners = new Set<Listener>();

/** 请求展开某张子代理卡（同一会话多张卡时全部响应，实际只有派发点那张存在）。 */
export function focusSubagentCard(childSessionId: string): void {
  for (const listener of listeners) listener(childSessionId);
}

/** 订阅定位信号；返回取消订阅函数。 */
export function onFocusSubagentCard(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
