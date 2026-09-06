/**
 * TypingIndicator — typing 指示（3s 过期由 store 清理）
 */
import React from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useMemberChatStore } from '../store/memberChatStore';

export const TypingIndicator: React.FC = () => {
  const { t } = useI18n();
  const typing = useMemberChatStore((s) => s.typing);
  if (typing.length === 0) return null;
  return (
    <div className="member-chat__typing" role="status">
      {typing.map((u) => u.name).join('、')}{' '}
      {t('memberChat.typing', { defaultValue: '正在输入…' })}
    </div>
  );
};
