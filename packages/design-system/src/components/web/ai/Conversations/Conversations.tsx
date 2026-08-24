/**
 * Conversations —— AI 会话列表（v0.15 AI 系，antd X Conversations 对位）
 * 分组标题 + 激活项黛青左缘指示条；时间 mono+tabular。
 */
import React, { useMemo } from 'react';
import './Conversations.scss';

export interface ConversationItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  group?: string;
  timestamp?: string;
}

export interface ConversationsProps {
  items: ConversationItem[];
  activeId?: string;
  onSelect?(id: string): void;
  /** 右侧 hover 操作（删除/重命名等） */
  itemActions?(id: string): React.ReactNode;
  className?: string;
}

export const Conversations: React.FC<ConversationsProps> = ({
  items,
  activeId,
  onSelect,
  itemActions,
  className = '',
}) => {
  const groups = useMemo(() => {
    const map = new Map<string, ConversationItem[]>();
    for (const item of items) {
      const g = item.group ?? '';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(item);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <div className={['ai-conversations', className].filter(Boolean).join(' ')}>
      {groups.map(([group, groupItems]) => (
        <div key={group || '__ungrouped__'} className="ai-conversations__group">
          {group && <div className="ai-conversations__group-title">{group}</div>}
          {groupItems.map((item) => {
            const active = item.id === activeId;
            return (
              <div
                key={item.id}
                className={`ai-conversations__item ${active ? 'is-active' : ''}`}
                role="button"
                tabIndex={0}
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect?.(item.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(item.id);
                  }
                }}
              >
                {item.icon != null && <span className="ai-conversations__icon">{item.icon}</span>}
                <span className="ai-conversations__label">{item.label}</span>
                {item.timestamp != null && (
                  <span className="ai-conversations__time">{item.timestamp}</span>
                )}
                {itemActions && <span className="ai-conversations__actions">{itemActions(item.id)}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};
