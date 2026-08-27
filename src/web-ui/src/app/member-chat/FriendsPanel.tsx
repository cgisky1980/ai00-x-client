/**
 * FriendsPanel — 好友体系弹窗集合：
 * - AddFriendModal       添加好友（用户名搜索 → 发送申请）
 * - FriendRequestsModal  待处理好友申请（接受/拒绝）
 */
import React, { useEffect, useRef, useState } from 'react';
import { chatApi, type FriendReq, type MemberHit } from './chatApi';

/** 通用弹窗外壳（与 ChatModals 同款类名） */
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

// ---- 添加好友 ----

export const AddFriendModal: React.FC<{
  onClose: () => void;
  onNotice: (msg: string) => void;
}> = ({ onClose, onNotice }) => {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<MemberHit[]>([]);
  const [searching, setSearching] = useState(false);
  /** 本会话内已发送申请的会员 id → 状态文案 */
  const [sentMap, setSentMap] = useState<Record<number, string>>({});
  const [err, setErr] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 搜索防抖 300ms
  useEffect(() => {
    const text = q.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!text) {
      setHits([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { hits: list } = await chatApi.searchMembers(text);
        setHits(list || []);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  const doSend = async (hit: MemberHit) => {
    setErr('');
    try {
      const fr = await chatApi.sendFriendRequest(hit.id);
      setSentMap((prev) => ({
        ...prev,
        [hit.id]: fr.status === 'accepted' ? '已成为好友' : '已发送申请',
      }));
      onNotice(fr.status === 'accepted' ? `已与 ${hit.username} 成为好友` : '好友申请已发送');
    } catch (e) {
      const msg = (e as Error).message;
      // 幂等重放 / 已是好友时不打断用户
      setErr(msg);
    }
  };

  return (
    <Modal title="添加好友" onClose={onClose}>
      <label className="member-chat__field">
        <span>用户名</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="输入对方用户名搜索"
          autoFocus
        />
      </label>
      {err && <div className="member-chat__modal-error">{err}</div>}
      <div className="member-chat__friend-hits">
        {searching && <div className="member-chat__empty">搜索中…</div>}
        {!searching && q.trim() && hits.length === 0 && (
          <div className="member-chat__empty">未找到匹配的用户</div>
        )}
        {hits.map((h) => (
          <div key={h.id} className="member-chat__friend-hit">
            <span className="member-chat__friend-hit-name">
              {h.username}
              {h.nickname && h.nickname !== h.username && (
                <span className="member-chat__group">{h.nickname}</span>
              )}
            </span>
            <button
              className="member-chat__btn-primary member-chat__btn-small"
              disabled={!!sentMap[h.id]}
              onClick={() => doSend(h)}
            >
              {sentMap[h.id] || '加好友'}
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
};

// ---- 待处理好友申请 ----

export const FriendRequestsModal: React.FC<{
  requests: FriendReq[];
  onClose: () => void;
  onRespond: (id: number, accept: boolean) => Promise<void>;
}> = ({ requests, onClose, onRespond }) => {
  const [busyId, setBusyId] = useState<number | null>(null);

  const respond = async (id: number, accept: boolean) => {
    setBusyId(id);
    try {
      await onRespond(id, accept);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal title={`好友申请（${requests.length}）`} onClose={onClose}>
      {requests.length === 0 && <div className="member-chat__empty">暂无待处理的申请</div>}
      {requests.map((r) => (
        <div key={r.id} className="member-chat__friend-hit">
          <span className="member-chat__friend-hit-name">{r.requester_name}</span>
          <span className="member-chat__friend-hit-actions">
            <button
              className="member-chat__btn-primary member-chat__btn-small"
              disabled={busyId === r.id}
              onClick={() => respond(r.id, true)}
            >
              接受
            </button>
            <button
              className="member-chat__btn-ghost member-chat__btn-small"
              disabled={busyId === r.id}
              onClick={() => respond(r.id, false)}
            >
              拒绝
            </button>
          </span>
        </div>
      ))}
    </Modal>
  );
};
