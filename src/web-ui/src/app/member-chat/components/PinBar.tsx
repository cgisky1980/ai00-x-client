/**
 * PinBar — 置顶条（按频道置顶；话题机制已随迁移 018 下线）
 */
import React from 'react';
import { useMemberChatStore } from '../store/memberChatStore';

export const PinBar: React.FC = () => {
  const pins = useMemberChatStore((s) => s.pins);
  const messages = useMemberChatStore((s) => s.messages);
  if (pins.length === 0) return null;
  return (
    <div className="member-chat__pin-bar">
      📌
      {pins.map((p) => {
        const m = messages.find((x) => x.id === p.message_id);
        return (
          <button
            key={`${p.id}-${p.message_id}`}
            className="member-chat__pin-item"
            title={m?.content?.slice(0, 60) || `#${p.message_id}`}
            onClick={() => {
              const el = document.querySelector(`[data-mid="${p.message_id}"]`);
              el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          >
            {m ? m.content.slice(0, 24) : `#${p.message_id}`}
          </button>
        );
      })}
    </div>
  );
};
