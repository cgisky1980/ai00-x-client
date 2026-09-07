/**
 * RailNav — 最左功能导航栏（QQ9 结构：icon-only rail）
 *
 * 顶部头像（+在线状态点，点击 → 设置入口）；中部功能图标列
 * （广场/消息/联系人/频道，广场为社区主入口居首）；底部设置。
 * 选中态黛青 + 左指示条微动效。
 */
import React from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { MemberAvatar } from './MemberAvatar';
import { Globe, Hash, MessageCircle, Settings, Users } from 'lucide-react';

export type RailTab = 'chats' | 'contacts' | 'channels' | 'community' | 'settings';

export const RailNav: React.FC<{
  tab: RailTab;
  onTabChange: (t: RailTab) => void;
  /** 消息态角标：DM + 房间未读合计 */
  unreadChats: number;
  /** 联系人态角标：好友申请数 */
  friendReqCount: number;
  /** 广场态角标：社区通知未读数 */
  communityUnread?: number;
  connection: 'connecting' | 'online' | 'reconnecting' | 'offline';
  username: string;
  /** 当前会员头像（data URL；空则回退字母 Avatar） */
  avatarData?: string | null;
}> = ({
  tab,
  onTabChange,
  unreadChats,
  friendReqCount,
  communityUnread,
  connection,
  username,
  avatarData,
}) => {
  const { t } = useI18n();

  const items: { key: RailTab; label: string; icon: React.ReactNode; badge?: number }[] = [
    {
      key: 'chats',
      label: t('memberChat.tabChats', { defaultValue: '消息' }),
      icon: <MessageCircle size={20} strokeWidth={1.8} />,
      badge: unreadChats,
    },
    {
      key: 'contacts',
      label: t('memberChat.tabContacts', { defaultValue: '联系人' }),
      icon: <Users size={20} strokeWidth={1.8} />,
      badge: friendReqCount,
    },
    {
      key: 'channels',
      label: t('memberChat.tabChannels', { defaultValue: '频道' }),
      icon: <Hash size={20} strokeWidth={1.8} />,
    },
    {
      key: 'community',
      label: t('memberChat.tabCommunity', { defaultValue: '广场' }),
      icon: <Globe size={20} strokeWidth={1.8} />,
      badge: communityUnread,
    },
  ];

  return (
    <aside className="member-chat__rail">
      <button
        type="button"
        className={`member-chat__rail-avatar ${tab === 'settings' ? 'is-active' : ''}`}
        onClick={() => onTabChange('settings')}
        title={username}
        aria-label={t('memberChat.railMyAccount', { defaultValue: '我的账号与设置' })}
      >
        <MemberAvatar name={username} size="base" data={avatarData} />
        <span
          className={`member-chat__rail-presence ${connection === 'online' ? 'is-on' : ''}`}
          aria-hidden
        />
      </button>

      <nav className="member-chat__rail-nav" aria-label={t('memberChat.railNav', { defaultValue: '功能导航' })}>
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={`member-chat__rail-item ${tab === it.key ? 'is-active' : ''}`}
            onClick={() => onTabChange(it.key)}
            title={it.label}
            aria-label={it.label}
            aria-current={tab === it.key ? 'page' : undefined}
          >
            {it.icon}
            {!!it.badge && it.badge > 0 && (
              <span className="member-chat__rail-badge">{it.badge > 99 ? '99+' : it.badge}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="member-chat__rail-foot">
        <button
          type="button"
          className={`member-chat__rail-item ${tab === 'settings' ? 'is-active' : ''}`}
          onClick={() => onTabChange('settings')}
          title={t('memberChat.railSettings', { defaultValue: '设置' })}
          aria-label={t('memberChat.railSettings', { defaultValue: '设置' })}
          aria-current={tab === 'settings' ? 'page' : undefined}
        >
          <Settings size={20} strokeWidth={1.8} />
        </button>
      </div>
    </aside>
  );
};
