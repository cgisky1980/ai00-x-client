/**
 * Portal 容器注入 —— 解耦包对消费方 portal context 的依赖
 * 默认 portal 到 document.body；消费方（如 web-ui）可在根部包 Provider
 * 将弹层引导到自定义容器（如 #root 内的 overlay 层）。
 */
import { createContext, useContext } from 'react';

export const PortalContainerContext = createContext<HTMLElement | null>(null);

/** 取 portal 目标容器：Provider 值 → document.body */
export function usePortalContainer(): HTMLElement {
  const container = useContext(PortalContainerContext);
  if (container && container.isConnected) return container;
  return document.body;
}
