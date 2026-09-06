/**
 * Composer — 输入区
 *
 * - IME 守卫（compositionend 后 Enter 才发送）；Shift+Enter 换行
 * - typing 状态节流（store 内 2s）
 * - postingLocked（official 频道 admin 发帖策略）禁用态说明
 */
import React, { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useMemberChatStore } from '../store/memberChatStore';

export const Composer: React.FC = () => {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [composing, setComposing] = useState(false);

  const currentId = useMemberChatStore((s) => s.currentId);
  const sending = useMemberChatStore((s) => s.sending);
  const sendMessage = useMemberChatStore((s) => s.sendMessage);
  const touchTyping = useMemberChatStore((s) => s.touchTyping);
  const channels = useMemberChatStore((s) => s.channels);
  const members = useMemberChatStore((s) => s.members);
  const session = useMemberChatStore((s) => s.session);

  const current = channels.find((c) => c.id === currentId);
  const isOwner =
    !!session && (session.isSuperAdmin || members.find((m) => m.member_id === session.memberId)?.role === 'owner');
  const postingLocked = !!current && current.post_policy === 'admin' && !isOwner;

  const send = async () => {
    const text = content.trim();
    if (!text || currentId == null || postingLocked || sending) return;
    setContent('');
    const ok = await sendMessage(text);
    if (!ok) setContent(text); // 失败恢复输入
  };

  return (
    <footer className="member-chat__composer">
      <textarea
        className="member-chat__input"
        rows={2}
        value={content}
        disabled={postingLocked}
        onChange={(e) => {
          setContent(e.target.value);
          if (e.target.value.trim()) touchTyping();
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !composing) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={
          postingLocked
            ? t('memberChat.postingLocked', { defaultValue: '仅 owner/admin 可在本频道发帖' })
            : t('memberChat.inputPlaceholder', {
                defaultValue: '输入消息，Enter 发送，Shift+Enter 换行',
              })
        }
        aria-label={t('memberChat.inputLabel', { defaultValue: '消息输入框' })}
      />
      <button
        className="member-chat__send"
        onClick={() => void send()}
        disabled={postingLocked || sending || !content.trim()}
      >
        {t('memberChat.send', { defaultValue: '发送' })}
      </button>
    </footer>
  );
};
