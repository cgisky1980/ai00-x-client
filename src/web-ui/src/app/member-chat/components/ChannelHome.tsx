/**
 * ChannelHome — 频道主页（迁移 018：频道=分类容器，不可发言）
 *
 * 顶层 official 频道被选中时替代消息流显示：
 * - 频道通告（announcement，仅 owner/超管可编辑；简介在 ChatHeader 展示）
 * - 房间列表：点击进入房间消息流
 * - 「+ 建房间」入口（owner/超管/create_rooms 分组权限）
 */
import React, { useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Modal, Input, Button } from '@/component-library';
import { chatApi, type ChatChannel } from '../chatApi';
import { CreateChannelModal } from '../ChatModals';
import { useMemberChatStore } from '../store/memberChatStore';

export const ChannelHome: React.FC<{ channel: ChatChannel }> = ({ channel }) => {
  const { t } = useI18n();
  const channels = useMemberChatStore((s) => s.channels);
  const members = useMemberChatStore((s) => s.members);
  const session = useMemberChatStore((s) => s.session);
  const selectChannel = useMemberChatStore((s) => s.selectChannel);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftDesc, setDraftDesc] = useState('');
  const [draftAnn, setDraftAnn] = useState('');
  const [busy, setBusy] = useState(false);

  const rooms = useMemo(
    () => channels.filter((c) => c.parent_id === channel.id),
    [channels, channel.id],
  );

  const myPerms = useMemo(
    () => members.find((m) => m.member_id === session?.memberId)?.permissions ?? [],
    [members, session],
  );
  const canManage =
    !!session && (session.isSuperAdmin || channel.owner_id === session.memberId);
  const canCreateRoom =
    canManage || myPerms.includes('create_rooms');

  const startEdit = () => {
    setDraftDesc(channel.description || '');
    setDraftAnn(channel.announcement || '');
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      await chatApi.updateChannelSettings(channel.id, {
        description: draftDesc.trim(),
        announcement: draftAnn.trim(),
      });
      await useMemberChatStore.getState().refreshChannels();
      setEditing(false);
    } catch (e) {
      useMemberChatStore.getState().clearError();
      useMemberChatStore.setState({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="member-chat__channel-home">
      <section className="member-chat__home-announce">
        <div className="member-chat__home-section-head">
          <h2 className="member-chat__home-section-title">
            {t('memberChat.announcement', { defaultValue: '频道通告' })}
          </h2>
          {canManage && (
            <Button variant="ghost" size="small" onClick={startEdit}>
              {t('memberChat.editChannel', { defaultValue: '编辑' })}
            </Button>
          )}
        </div>
        {channel.announcement ? (
          <p className="member-chat__home-announce-text">{channel.announcement}</p>
        ) : (
          <p className="member-chat__home-announce-empty">
            {t('memberChat.noAnnouncement', { defaultValue: '暂无通告' })}
          </p>
        )}
      </section>

      <section className="member-chat__home-rooms">
        <div className="member-chat__home-section-head">
          <h2 className="member-chat__home-section-title">
            {t('memberChat.rooms', { defaultValue: '房间' })}
          </h2>
          {canCreateRoom && (
            <Button variant="ghost" size="small" onClick={() => setCreating(true)}>
              + {t('memberChat.createRoom', { defaultValue: '建房间' })}
            </Button>
          )}
        </div>
        {rooms.length === 0 && (
          <p className="member-chat__home-announce-empty">
            {t('memberChat.noRooms', { defaultValue: '该频道下暂无房间' })}
          </p>
        )}
        <div className="member-chat__home-room-list">
          {rooms.map((r) => (
            <button
              key={r.id}
              className="member-chat__home-room"
              onClick={() => void selectChannel(r.id)}
            >
              <span className="member-chat__home-room-hash">◇</span>
              <span className="member-chat__home-room-name">{r.name}</span>
              {r.description && (
                <span className="member-chat__home-room-desc">{r.description}</span>
              )}
            </button>
          ))}
        </div>
      </section>

      {editing && (
        <Modal
          isOpen
          title={t('memberChat.editChannelTitle', { defaultValue: '编辑频道' })}
          onClose={() => setEditing(false)}
          size="small"
          contentClassName="member-chat__modal-form"
        >
          <label className="member-chat__modal-field">
            <span>{t('memberChat.channelDesc', { defaultValue: '简介' })}</span>
            <Input value={draftDesc} onChange={(e) => setDraftDesc(e.target.value)} />
          </label>
          <label className="member-chat__modal-field">
            <span>{t('memberChat.channelAnnouncement', { defaultValue: '通告' })}</span>
            <textarea
              className="member-chat__modal-textarea"
              value={draftAnn}
              onChange={(e) => setDraftAnn(e.target.value)}
              rows={4}
            />
          </label>
          <div className="member-chat__modal-actions">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {t('common.cancel', { defaultValue: '取消' })}
            </Button>
            <Button variant="primary" isLoading={busy} onClick={() => void save()}>
              {t('common.save', { defaultValue: '保存' })}
            </Button>
          </div>
        </Modal>
      )}
      {creating && (
        <CreateChannelModal
          channels={channels}
          isSuperAdmin={!!session?.isSuperAdmin}
          parentChannel={channel}
          onClose={() => setCreating(false)}
          onCreated={() => void useMemberChatStore.getState().refreshChannels()}
        />
      )}
    </div>
  );
};
