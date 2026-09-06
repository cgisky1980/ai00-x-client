/**
 * 积分中心场景入口事件。
 *
 * 入口处（如 AccountConfig）不能直接依赖 app 层 sceneStore，
 * 走 window 事件解耦：先指定目标页签，再打开 credits 场景
 * （sceneStore 内建监听 'scene:open'）。
 */

export type CreditsTabKey = 'recharge' | 'membership' | 'invite';

const CREDITS_TAB_EVENT = 'credits:open-tab';

/** 打开积分中心并定位到指定页签 */
export function requestCreditsTab(tab: CreditsTabKey): void {
  window.dispatchEvent(new CustomEvent(CREDITS_TAB_EVENT, { detail: { tab } }));
  window.dispatchEvent(
    new CustomEvent('scene:open', { detail: { sceneId: 'credits' } })
  );
}

/** 供 CreditsScene 订阅页签切换请求 */
export function onCreditsTabRequest(handler: (tab: CreditsTabKey) => void): () => void {
  const listener = (e: Event) => {
    const tab = (e as CustomEvent<{ tab?: CreditsTabKey }>).detail?.tab;
    if (tab === 'recharge' || tab === 'membership' || tab === 'invite') handler(tab);
  };
  window.addEventListener(CREDITS_TAB_EVENT, listener);
  return () => window.removeEventListener(CREDITS_TAB_EVENT, listener);
}
