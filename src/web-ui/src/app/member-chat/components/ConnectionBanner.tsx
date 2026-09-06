/**
 * ConnectionBanner — 顶部断线/重连横幅
 */
import React from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useMemberChatStore } from '../store/memberChatStore';

export const ConnectionBanner: React.FC = () => {
  const { t } = useI18n();
  const connection = useMemberChatStore((s) => s.connection);
  if (connection === 'online') return null;
  return (
    <div className={`member-chat__conn-banner is-${connection}`} role="status">
      {connection === 'connecting' &&
        t('memberChat.connConnecting', { defaultValue: '正在连接…' })}
      {connection === 'reconnecting' &&
        t('memberChat.connReconnecting', { defaultValue: '连接已断开，正在重连…' })}
      {connection === 'offline' &&
        t('memberChat.connOffline', { defaultValue: '网络已断开，恢复后自动重连' })}
    </div>
  );
};
