/**
 * ChatModals — 会员聊天窗口的弹窗集合（ds web 系 Modal + 表单件）：
 * - CreateChannelModal  建官方频道（容器，超管）
 * - ChannelSettingsModal 频道设置（名称/描述/邀请制/发帖策略）
 * - GroupsModal         分组管理（列表/建组/权限/成员）
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Checkbox, Input, Modal, Select, Switch } from '@/component-library';
import { chatApi, type ChatChannel, type ChatGroup, type ChatGroupMember, type Member } from './chatApi';

/** 4 项细颗粒权限 */
const ALL_PERMS: { key: string; label: string }[] = [
  { key: 'create_rooms', label: '建房间' },
  { key: 'manage_members', label: '管理成员' },
  { key: 'manage_messages', label: '管理消息' },
  { key: 'manage_rooms', label: '管理房间' },
];

/** 表单内错误行 */
const FormError: React.FC<{ message: string | null }> = ({ message }) =>
  message ? <div className="member-chat__modal-error">{message}</div> : null;

// ---- 建官方频道（容器）/ 建房间（频道子级） ----

export const CreateChannelModal: React.FC<{
  channels: ChatChannel[];
  /** 仅超管可创建官方频道（本窗口挂载点已做权限裁剪） */
  isSuperAdmin: boolean;
  /** 传入 = 在该频道下建房间（kind='room'）；不传 = 建官方频道容器（超管） */
  parentChannel?: ChatChannel | null;
  onClose: () => void;
  onCreated: () => void;
}> = ({ parentChannel, onClose, onCreated }) => {
  const { t } = useI18n();
  const isRoomMode = !!parentChannel;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [inviteOnly, setInviteOnly] = useState(false);
  const [postPolicy, setPostPolicy] = useState('everyone');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      // 房间模式：kind='room' + 父频道；容器模式：仅超管建顶层 official
      await chatApi.createChannel({
        name: name.trim(),
        description: description.trim(),
        kind: isRoomMode ? 'room' : 'official',
        parent_id: isRoomMode ? parentChannel.id : null,
        invite_only: isRoomMode ? false : inviteOnly,
        post_policy: isRoomMode ? 'everyone' : postPolicy,
      });
      onCreated();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={
        isRoomMode
          ? `${t('memberChat.createRoomTitle', { defaultValue: '创建房间' })} · ${parentChannel.name}`
          : t('memberChat.createChannelTitle', { defaultValue: '创建官方频道' })
      }
      size="small"
      contentClassName="member-chat__modal-form"
    >
      <Input
        label={t('memberChat.fieldName', { defaultValue: '名称' })}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={
          isRoomMode
            ? t('memberChat.roomNamePlaceholder', { defaultValue: '如：综合讨论' })
            : t('memberChat.channelNamePlaceholder', { defaultValue: '如：技术交流' })
        }
        autoFocus
      />
      <Input
        label={t('memberChat.fieldDescription', { defaultValue: '描述' })}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t('memberChat.optional', { defaultValue: '可选' })}
      />
      {!isRoomMode && (
        <>
          <Switch
            label={t('memberChat.inviteOnly', { defaultValue: '邀请制（仅 owner/管理员可加人）' })}
            checked={inviteOnly}
            onChange={(e) => setInviteOnly(e.target.checked)}
          />
          <Select
            label={t('memberChat.postPolicy', { defaultValue: '发帖策略' })}
            options={[
              { value: 'everyone', label: t('memberChat.postPolicyEveryone', { defaultValue: '所有人可发' }) },
              { value: 'admin', label: t('memberChat.postPolicyAdmin', { defaultValue: '仅 owner/管理员可发' }) },
            ]}
            value={postPolicy}
            onChange={(v) => setPostPolicy(String(v))}
          />
        </>
      )}
      <FormError message={err} />
      <div className="member-chat__modal-actions">
        <Button variant="primary" isLoading={busy} disabled={!name.trim()} onClick={submit}>
          {t('memberChat.createAction', { defaultValue: '创建' })}
        </Button>
      </div>
    </Modal>
  );
};

// ---- 频道设置 ----

export const ChannelSettingsModal: React.FC<{
  channel: ChatChannel;
  onClose: () => void;
  onSaved: () => void;
}> = ({ channel, onClose, onSaved }) => {
  const { t } = useI18n();
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description);
  const [inviteOnly, setInviteOnly] = useState(!!channel.invite_only);
  const [postPolicy, setPostPolicy] = useState(channel.post_policy || 'everyone');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await chatApi.updateChannelSettings(channel.id, {
        name: name.trim(),
        description: description.trim(),
        invite_only: inviteOnly,
        post_policy: postPolicy,
      });
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${t('memberChat.channelSettingsTitle', { defaultValue: '频道设置' })} · #${channel.name}`}
      size="small"
      contentClassName="member-chat__modal-form"
    >
      <Input
        label={t('memberChat.fieldName', { defaultValue: '名称' })}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        label={t('memberChat.fieldDescription', { defaultValue: '描述' })}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Switch
        label={t('memberChat.inviteOnlyShort', { defaultValue: '邀请制' })}
        checked={inviteOnly}
        onChange={(e) => setInviteOnly(e.target.checked)}
      />
      <Select
        label={t('memberChat.postPolicy', { defaultValue: '发帖策略' })}
        options={[
          { value: 'everyone', label: t('memberChat.postPolicyEveryone', { defaultValue: '所有人可发' }) },
          { value: 'admin', label: t('memberChat.postPolicyAdmin', { defaultValue: '仅 owner/管理员可发' }) },
        ]}
        value={postPolicy}
        onChange={(v) => setPostPolicy(String(v))}
      />
      <FormError message={err} />
      <div className="member-chat__modal-actions">
        <Button variant="primary" isLoading={busy} onClick={submit}>
          {t('memberChat.saveAction', { defaultValue: '保存' })}
        </Button>
      </div>
    </Modal>
  );
};

// ---- 分组管理 ----

export const GroupsModal: React.FC<{
  channel: ChatChannel;
  members: Member[];
  onClose: () => void;
  onChanged: () => void;
}> = ({ channel, members, onClose, onChanged }) => {
  const { t } = useI18n();
  const [groups, setGroups] = useState<ChatGroup[]>([]);
  const [openGroupId, setOpenGroupId] = useState<number | null>(null);
  const [groupMembers, setGroupMembers] = useState<ChatGroupMember[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [addMemberId, setAddMemberId] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const { groups: gs } = await chatApi.listGroups(channel.id);
      setGroups(gs || []);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  const openGroup = async (gid: number) => {
    if (openGroupId === gid) {
      setOpenGroupId(null);
      return;
    }
    try {
      const { members: gms } = await chatApi.getGroup(gid);
      setGroupMembers(gms || []);
      setOpenGroupId(gid);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const createGroup = async () => {
    if (!newGroupName.trim()) return;
    try {
      await chatApi.createGroup(newGroupName.trim(), channel.id, []);
      setNewGroupName('');
      await refresh();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const togglePerm = async (g: ChatGroup, perm: string) => {
    const perms = g.permissions.includes(perm)
      ? g.permissions.filter((p) => p !== perm)
      : [...g.permissions, perm];
    try {
      await chatApi.updateGroupPermissions(g.id, perms);
      await refresh();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const addToGroup = async (gid: number) => {
    const mid = Number(addMemberId);
    if (!mid) return;
    try {
      await chatApi.addGroupMember(gid, mid);
      setAddMemberId('');
      await openGroup(gid);
      setOpenGroupId(gid);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const removeFromGroup = async (gid: number, mid: number) => {
    try {
      await chatApi.removeGroupMember(gid, mid);
      const { members: gms } = await chatApi.getGroup(gid);
      setGroupMembers(gms || []);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${t('memberChat.groupsTitle', { defaultValue: '分组管理' })} · #${channel.name}`}
      size="medium"
      contentClassName="member-chat__modal-form"
    >
      <div className="member-chat__group-create">
        <Input
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          placeholder={t('memberChat.newGroupName', { defaultValue: '新分组名称' })}
        />
        <Button variant="primary" disabled={!newGroupName.trim()} onClick={createGroup}>
          {t('memberChat.createGroup', { defaultValue: '建组' })}
        </Button>
      </div>
      {groups.length === 0 && (
        <div className="member-chat__empty">{t('memberChat.noGroups', { defaultValue: '暂无分组' })}</div>
      )}
      {groups.map((g) => (
        <div key={g.id} className="member-chat__group-card">
          <div className="member-chat__group-head" onClick={() => openGroup(g.id)}>
            <span className="member-chat__group-name">{g.name}</span>
            <span className="member-chat__count">{g.member_count ?? 0} 人</span>
          </div>
          <div className="member-chat__group-perms">
            {ALL_PERMS.map((p) => (
              <Checkbox
                key={p.key}
                label={t(`memberChat.perm_${p.key}`, { defaultValue: p.label })}
                checked={g.permissions.includes(p.key)}
                onChange={() => togglePerm(g, p.key)}
              />
            ))}
          </div>
          {openGroupId === g.id && (
            <div className="member-chat__group-members">
              {groupMembers.map((gm) => (
                <div key={gm.member_id} className="member-chat__group-member">
                  <span>{gm.member_name}</span>
                  <Button
                    variant="ghost"
                    size="small"
                    title={t('memberChat.removeMember', { defaultValue: '移出分组' })}
                    onClick={() => removeFromGroup(g.id, gm.member_id)}
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <div className="member-chat__group-add">
                <Select
                  placeholder={t('memberChat.pickMember', { defaultValue: '选择成员加入…' })}
                  options={members
                    .filter((m) => !groupMembers.some((gm) => gm.member_id === m.member_id))
                    .map((m) => ({ value: m.member_id, label: m.member_name }))}
                  value={addMemberId}
                  onChange={(v) => setAddMemberId(v == null ? '' : String(v))}
                />
                <Button variant="primary" disabled={!addMemberId} onClick={() => addToGroup(g.id)}>
                  {t('memberChat.joinGroup', { defaultValue: '加入' })}
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
      <FormError message={err} />
    </Modal>
  );
};
