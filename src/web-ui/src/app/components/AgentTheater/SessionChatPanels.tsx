/**
 * SessionChatPanels — 会话对话浮层宿主（多实例并存）。
 *
 * 数据源 theaterStore.chatPanels；双击工灵 / todo 看板「打开对话 · 干预」
 * 都通过 openChatPanel(sessionId, taskLabel) 打开。全局挂载（App 根），
 * 不依赖剧场开关（对话干预是功能入口，不是装饰）。
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { useTheaterStore } from './theaterStore';
import { SessionChatPanel } from './SessionChatPanel';

export const SessionChatPanels: React.FC = () => {
  const chatPanels = useTheaterStore((s) => s.chatPanels);
  const closeChatPanel = useTheaterStore((s) => s.closeChatPanel);

  const entries = Object.entries(chatPanels).sort(
    (a, b) => a[1].openedAt - b[1].openedAt,
  );

  return createPortal(
    <>
      {entries.map(([sessionId, info], index) => (
        <SessionChatPanel
          key={sessionId}
          sessionId={sessionId}
          info={info}
          index={index}
          onClose={() => closeChatPanel(sessionId)}
        />
      ))}
    </>,
    document.body,
  );
};
