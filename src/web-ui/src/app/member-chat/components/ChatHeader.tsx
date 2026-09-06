/**
 * ChatHeader — 中栏头：名称 + 类型 Tag + 描述 + 成员数 + 管理（DropdownMenu）
 *
 * 类型 Tag 明示记录策略：官方频道「已保存」/ 房间「已保存」（落库，迁移 018）/
 * 私聊「仅本机」。管理菜单：官方频道 owner → 设置/分组；私聊 → 清空本机记录。
 */
import React from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Info } from 'lucide-react';
import {
  confirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Tag,
} from '@/component-library';
import { computeMyPerms, conversationType, findChannelIn, useMemberChatStore } from '../store/memberChatStore';

export const ChatHeader: React.FC<{
  onOpenSettings: () => void;
  onOpenGroups: () => void;
  infoOpen: boolean;
  onToggleInfo: () => void;
}> = ({ onOpenSettings, onOpenGroups, infoOpen, onToggleInfo }) => {
  const { t } = useI18n();
  const channels = useMemberChatStore((s) => s.channels);
  const dms = useMemberChatStore((s) => s.dms);
  const currentId = useMemberChatStore((s) => s.currentId);
  const members = useMemberChatStore((s) => s.members);
  const online = useMemberChatStore((s) => s.online);
  const session = useMemberChatStore((s) => s.session);
  const clearDmHistory = useMemberChatStore((s) => s.clearDmHistory);

  const ch = findChannelIn(channels, dms, currentId);
  const convType = conversationType(ch, ch?.is_dm ?? false);
  const { canManageRooms } = computeMyPerms(session, members);

  if (!ch) return <header className="member-chat__header" />;

  const typeTagColor = convType === 'dm' ? 'gray' : 'green';
  const typeTagText =
    convType === 'dm'
      ? t('memberChat.localOnly', { defaultValue: '仅本机' })
      : t('memberChat.saved', { defaultValue: '已保存' });
  const typeTagTitle =
    convType === 'dm'
      ? t('memberChat.localOnlyDetail', {
          defaultValue: '私聊仅保存在双方本机；服务端不留存，离线期间的消息不会送达',
        })
      : typeTagText;

  const onlineCount = members.filter((m) => online.has(m.member_id)).length;

  return (
    <header className="member-chat__header">
      <div className="member-chat__header-title">
        <span className="member-chat__header-hash">
          {convType === 'dm' ? '@' : convType === 'room' ? '◇' : '#'}
        </span>
        <span className="member-chat__header-name">{ch.name}</span>
        <Tag color={typeTagColor} title={typeTagTitle}>
          {typeTagText}
        </Tag>
        <span className="member-chat__header-meta">
          {t('memberChat.memberCount', {
            defaultValue: `${members.length} 人${onlineCount > 0 ? ` · ${onlineCount} 在线` : ''}`,
          })}
        </span>
      </div>

      <div className="member-chat__header-actions">
        {ch.description && (
          <span className="member-chat__header-desc">{ch.description}</span>
        )}
        {(canManageRooms || convType === 'dm') && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                variant="ghost"
                size="xs"
                shape="square"
                tooltip={t('memberChat.moreActions', { defaultValue: '更多' })}
                aria-label={t('memberChat.moreActions', { defaultValue: '更多' })}
              >
                ⚙
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canManageRooms && (
                <>
                  <DropdownMenuItem onSelect={onOpenSettings}>
                    {t('memberChat.settings', { defaultValue: '频道设置' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onOpenGroups}>
                    {t('memberChat.groups', { defaultValue: '分组管理' })}
                  </DropdownMenuItem>
                </>
              )}
              {convType === 'dm' && (
                <DropdownMenuItem
                  onSelect={() => {
                    void confirmDialog({
                      title: t('memberChat.clearDmTitle', { defaultValue: '清空私聊记录' }),
                      message: t('memberChat.clearDmMsg', {
                        defaultValue: '将删除本机保存的这条私聊的全部历史，服务端不受影响。确认？',
                      }),
                      confirmDanger: true,
                    }).then((ok) => {
                      if (ok) void clearDmHistory();
                    });
                  }}
                >
                  {t('memberChat.clearDm', { defaultValue: '清空本机记录' })}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <IconButton
          variant="ghost"
          size="xs"
          shape="square"
          className={`member-chat__info-toggle ${infoOpen ? 'is-open' : ''}`}
          tooltip={t('memberChat.infoPanel', { defaultValue: '信息面板' })}
          aria-label={t('memberChat.infoPanel', { defaultValue: '信息面板' })}
          aria-pressed={infoOpen}
          onClick={onToggleInfo}
        >
          <Info size={14} />
        </IconButton>
      </div>
    </header>
  );
};
