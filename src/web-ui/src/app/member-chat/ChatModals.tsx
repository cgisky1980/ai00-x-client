/**
 * ChatModals — 会员聊天窗口的弹窗集合：
 * - CreateChannelModal  建频道/房间
 * - CreateTopicModal    建话题
 * - ChannelSettingsModal 频道设置（名称/描述/邀请制/发帖策略）
 * - GroupsModal         分组管理（列表/建组/权限/成员）
 * - DmCreateModal       发起私信（选成员）
 */
import React, { useEffect, useState } from 'react';
import { chatApi, type ChatChannel, type ChatGroup, type ChatGroupMember, type Member } from './chatApi';

/** 4 项细颗粒权限 */
export const ALL_PERMS: { key: string; label: string }[] = [
  { key: 'create_rooms', label: '建房间' },
  { key: 'manage_members', label: '管理成员' },
  { key: 'manage_messages', label: '管理消息' },
  { key: 'manage_rooms', label: '管理房间' },
];

/** 通用弹窗外壳 */
const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({
  title,
  onClose,
  children,
}) => (
  <div className="member-chat__modal-mask" onClick={onClose}>
    <div className="member-chat__modal" onClick={(e) => e.stopPropagation()}>
      <div className="member-chat__modal-header">
        <span>{title}</span>
        <button className="member-chat__modal-close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="member-chat__modal-body">{children}</div>
    </div>
  </div>
);

// ---- 建频道 / 房间 ----

export const CreateChannelModal: React.FC<{
  channels: ChatChannel[];
  isSuperAdmin: boolean;
  onClose: () => void;
  onCreated: () => void;
}> = ({ channels, isSuperAdmin, onClose, onCreated }) => {
  const officials = channels.filter((c) => c.kind === 'official');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<'official' | 'room'>('room');
  const [parentId, setParentId] = useState<number | null>(officials[0]?.id ?? null);
  const [inviteOnly, setInviteOnly] = useState(false);
  const [postPolicy, setPostPolicy] = useState('everyone');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await chatApi.createChannel({
        name: name.trim(),
        description: description.trim(),
        kind,
        parent_id: kind === 'room' ? parentId : null,
        invite_only: inviteOnly,
        post_policy: postPolicy,
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
    <Modal title="创建频道 / 房间" onClose={onClose}>
      <label className="member-chat__field">
        <span>名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：技术交流" />
      </label>
      <label className="member-chat__field">
        <span>描述</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="可选"
        />
      </label>
      <label className="member-chat__field">
        <span>类型</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'official' | 'room')}
        >
          {isSuperAdmin && <option value="official">官方频道（消息存服务器）</option>}
          <option value="room">房间（本地优先，需选择父频道）</option>
        </select>
      </label>
      {kind === 'room' && (
        <label className="member-chat__field">
          <span>父频道</span>
          <select
            value={parentId ?? ''}
            onChange={(e) => setParentId(Number(e.target.value) || null)}
          >
            {officials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="member-chat__field member-chat__field--row">
        <input
          type="checkbox"
          checked={inviteOnly}
          onChange={(e) => setInviteOnly(e.target.checked)}
        />
        <span>邀请制（仅 owner/管理员可加人）</span>
      </label>
      <label className="member-chat__field">
        <span>发帖策略</span>
        <select value={postPolicy} onChange={(e) => setPostPolicy(e.target.value)}>
          <option value="everyone">所有人可发</option>
          <option value="admin">仅 owner/管理员可发</option>
        </select>
      </label>
      {err && <div className="member-chat__modal-error">{err}</div>}
      <div className="member-chat__modal-actions">
        <button className="member-chat__btn-primary" disabled={busy || !name.trim()} onClick={submit}>
          创建
        </button>
      </div>
    </Modal>
  );
};

// ---- 建话题 ----

export const CreateTopicModal: React.FC<{
  channelId: number;
  onClose: () => void;
  onCreated: (topicId: number) => void;
}> = ({ channelId, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { topic_id } = await chatApi.createTopic(channelId, name.trim());
      onCreated(topic_id);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="新建话题" onClose={onClose}>
      <label className="member-chat__field">
        <span>话题名称</span>
        <input
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="如：本周发布"
        />
      </label>
      {err && <div className="member-chat__modal-error">{err}</div>}
      <div className="member-chat__modal-actions">
        <button className="member-chat__btn-primary" disabled={busy || !name.trim()} onClick={submit}>
          创建
        </button>
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
    <Modal title={`频道设置 · #${channel.name}`} onClose={onClose}>
      <label className="member-chat__field">
        <span>名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="member-chat__field">
        <span>描述</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="member-chat__field member-chat__field--row">
        <input
          type="checkbox"
          checked={inviteOnly}
          onChange={(e) => setInviteOnly(e.target.checked)}
        />
        <span>邀请制</span>
      </label>
      <label className="member-chat__field">
        <span>发帖策略</span>
        <select value={postPolicy} onChange={(e) => setPostPolicy(e.target.value)}>
          <option value="everyone">所有人可发</option>
          <option value="admin">仅 owner/管理员可发</option>
        </select>
      </label>
      {err && <div className="member-chat__modal-error">{err}</div>}
      <div className="member-chat__modal-actions">
        <button className="member-chat__btn-primary" disabled={busy} onClick={submit}>
          保存
        </button>
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
  const [groups, setGroups] = useState<ChatGroup[]>([]);
  const [openGroupId, setOpenGroupId] = useState<number | null>(null);
  const [groupMembers, setGroupMembers] = useState<ChatGroupMember[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [addMemberId, setAddMemberId] = useState('');
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
    <Modal title={`分组管理 · #${channel.name}`} onClose={onClose}>
      <div className="member-chat__group-create">
        <input
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          placeholder="新分组名称"
        />
        <button className="member-chat__btn-primary" onClick={createGroup}>
          建组
        </button>
      </div>
      {groups.length === 0 && <div className="member-chat__empty">暂无分组</div>}
      {groups.map((g) => (
        <div key={g.id} className="member-chat__group">
          <div className="member-chat__group-head" onClick={() => openGroup(g.id)}>
            <span className="member-chat__group-name">{g.name}</span>
            <span className="member-chat__count">{g.member_count ?? 0} 人</span>
          </div>
          <div className="member-chat__group-perms">
            {ALL_PERMS.map((p) => (
              <label key={p.key} className="member-chat__perm">
                <input
                  type="checkbox"
                  checked={g.permissions.includes(p.key)}
                  onChange={() => togglePerm(g, p.key)}
                />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
          {openGroupId === g.id && (
            <div className="member-chat__group-members">
              {groupMembers.map((gm) => (
                <div key={gm.member_id} className="member-chat__group-member">
                  <span>{gm.member_name}</span>
                  <button
                    className="member-chat__msg-btn"
                    title="移出分组"
                    onClick={() => removeFromGroup(g.id, gm.member_id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="member-chat__group-add">
                <select value={addMemberId} onChange={(e) => setAddMemberId(e.target.value)}>
                  <option value="">选择成员加入…</option>
                  {members
                    .filter((m) => !groupMembers.some((gm) => gm.member_id === m.member_id))
                    .map((m) => (
                      <option key={m.member_id} value={m.member_id}>
                        {m.member_name}
                      </option>
                    ))}
                </select>
                <button className="member-chat__btn-primary" onClick={() => addToGroup(g.id)}>
                  加入
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      {err && <div className="member-chat__modal-error">{err}</div>}
    </Modal>
  );
};
