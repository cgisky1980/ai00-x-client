/**
 * StartDmModal — 发起私聊（好友选择）
 *
 * 私聊消息不落库（仅本机），好友门禁由服务端把守。
 */
import React, { useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Modal, Search } from '@/component-library';
import type { Friend } from '../chatApi';
import { useMemberChatStore } from '../store/memberChatStore';

export const StartDmModal: React.FC<{
  friends: Friend[];
  onClose: () => void;
}> = ({ friends, onClose }) => {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const createDm = useMemberChatStore((s) => s.createDm);

  const hits = useMemo(() => {
    const text = q.trim().toLowerCase();
    if (!text) return friends;
    return friends.filter(
      (f) =>
        f.username.toLowerCase().includes(text) ||
        (f.nickname || '').toLowerCase().includes(text),
    );
  }, [friends, q]);

  const pick = async (f: Friend) => {
    onClose();
    await createDm(f.member_id, f.nickname || f.username);
  };

  return (
    <Modal
      isOpen
      title={t('memberChat.startDmTitle', { defaultValue: '发起私聊' })}
      onClose={onClose}
      size="small"
      contentClassName="member-chat__modal-form"
    >
      <div className="member-chat__dm-start">
        <Search
          value={q}
          onChange={setQ}
          placeholder={t('memberChat.searchFriend', { defaultValue: '搜索好友…' })}
          autoFocus
          clearable
        />
        <div className="member-chat__dm-hits">
          {hits.length === 0 && (
            <div className="member-chat__empty">
              {t('memberChat.noFriendMatch', { defaultValue: '没有匹配的好友；请先在「联系人」页添加好友。' })}
            </div>
          )}
          {hits.map((f) => (
            <button
              key={f.member_id}
              className="member-chat__dm-hit"
              onClick={() => void pick(f)}
            >
              <span className={`member-chat__friend-dot ${f.online ? 'is-on' : ''}`} />
              <span className="member-chat__dm-hit-name">{f.nickname || f.username}</span>
              <span className="member-chat__count">{f.online ? t('memberChat.online', { defaultValue: '在线' }) : ''}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
};
