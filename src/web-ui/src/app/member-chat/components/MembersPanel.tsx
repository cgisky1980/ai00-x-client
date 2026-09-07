/**
 * MembersPanel — 右栏成员面板（私聊隐藏）
 *
 * 成员列表：Avatar + owner 标 + 在线点 + 分组名；hover 操作（发私信/移除成员）。
 * 加人：会员 ID 输入（canManageMembers）。
 */
import React, { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { confirmDialog, IconButton, Input } from '@/component-library';
import { MemberAvatar } from './MemberAvatar';
import { ChevronRight } from 'lucide-react';
import { computeMyPerms, conversationType, findChannelIn, useMemberChatStore } from '../store/memberChatStore';

export const MembersPanel: React.FC = () => {
  const { t } = useI18n();
  const [addId, setAddId] = useState('');

  const channels = useMemberChatStore((s) => s.channels);
  const dms = useMemberChatStore((s) => s.dms);
  const currentId = useMemberChatStore((s) => s.currentId);
  const members = useMemberChatStore((s) => s.members);
  const online = useMemberChatStore((s) => s.online);
  const session = useMemberChatStore((s) => s.session);
  const createDm = useMemberChatStore((s) => s.createDm);
  const removeMember = useMemberChatStore((s) => s.removeMember);
  const addMemberAction = useMemberChatStore((s) => s.addMember);
  const selectChannel = useMemberChatStore((s) => s.selectChannel);

  const ch = findChannelIn(channels, dms, currentId);
  const convType = conversationType(ch, ch?.is_dm ?? false);
  const { canManageMembers } = computeMyPerms(session, members);

  if (!ch || convType === 'dm') return null;

  const doAdd = async () => {
    const mid = Number(addId);
    if (!mid) return;
    await addMemberAction(mid);
    setAddId('');
  };

  return (
    <aside className="member-chat__members">
      {ch.announcement && (
        <button
          type="button"
          className="member-chat__notice"
          onClick={() => void selectChannel(ch.parent_id ?? ch.id)}
          title={t('memberChat.openChannelHome', { defaultValue: '查看频道主页' })}
        >
          <div className="member-chat__notice-head">
            {t('memberChat.notice', { defaultValue: '群公告' })}
            <ChevronRight size={14} aria-hidden />
          </div>
          <p className="member-chat__notice-text">{ch.announcement}</p>
        </button>
      )}
      <div className="member-chat__members-header">
        {t('memberChat.members', { defaultValue: '成员' })}
        <span className="member-chat__count">{members.length}</span>
      </div>
      <div className="member-chat__members-list">
        {members.length === 0 && (
          <div className="member-chat__empty">
            {t('memberChat.noMembers', { defaultValue: '暂无成员' })}
          </div>
        )}
        {members.map((m) => (
          <div key={m.member_id} className="member-chat__member">
            <MemberAvatar name={m.member_name} size="sm" data={m.member_avatar} />
            <span className="member-chat__member-name">{m.member_name}</span>
            {m.role === 'owner' && (
              <span className="member-chat__tag member-chat__tag--owner">owner</span>
            )}
            {online.has(m.member_id) && <span className="member-chat__online-dot" />}
            {m.group_name && <span className="member-chat__group">{m.group_name}</span>}
            {m.member_id !== session?.memberId && (
              <span className="member-chat__member-actions">
                <IconButton
                  variant="ghost"
                  size="xs"
                  shape="square"
                  tooltip={t('memberChat.dmAction', { defaultValue: '发私信' })}
                  aria-label={t('memberChat.dmAction', { defaultValue: '发私信' })}
                  onClick={() => void createDm(m.member_id, m.member_name)}
                >
                  ✉️
                </IconButton>
                {canManageMembers && m.role !== 'owner' && (
                  <IconButton
                    variant="ghost"
                    size="xs"
                    shape="square"
                    tooltip={t('memberChat.removeMemberAction', { defaultValue: '移除成员' })}
                    aria-label={t('memberChat.removeMemberAction', { defaultValue: '移除成员' })}
                    onClick={() => {
                      void confirmDialog({
                        title: t('memberChat.removeMemberTitle', { defaultValue: '移除成员' }),
                        message: t('memberChat.removeMemberConfirm', {
                          defaultValue: '确认移除该成员？',
                        }),
                        confirmDanger: true,
                      }).then((ok) => {
                        if (ok) void removeMember(m.member_id);
                      });
                    }}
                  >
                    ✕
                  </IconButton>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
      {canManageMembers && (
        <div className="member-chat__members-footer">
          <Input
            value={addId}
            onChange={(e) => setAddId(e.target.value)}
            placeholder={t('memberChat.addMember', { defaultValue: '会员 ID 加人' })}
            inputSize="small"
            onKeyDown={(e) => e.key === 'Enter' && void doAdd()}
          />
          <button className="member-chat__btn-primary" onClick={() => void doAdd()}>
            {t('memberChat.add', { defaultValue: '加人' })}
          </button>
        </div>
      )}
    </aside>
  );
};
