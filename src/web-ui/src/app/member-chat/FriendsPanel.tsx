/**
 * FriendsPanel — 好友体系弹窗集合（ds web 系 Modal + 表单件）：
 * - AddFriendModal       添加好友（用户名搜索 → 发送申请）
 * - FriendRequestsModal  待处理好友申请（接受/拒绝）
 */
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Empty, Modal, Search } from '@/component-library';
import { chatApi, type FriendReq, type MemberHit } from './chatApi';

// ---- 添加好友 ----

export const AddFriendModal: React.FC<{
  onClose: () => void;
  onNotice: (msg: string) => void;
}> = ({ onClose, onNotice }) => {
  const { t } = useI18n();
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
        [hit.id]: fr.status === 'accepted' ? t('memberChat.alreadyFriends', { defaultValue: '已成为好友' }) : t('memberChat.requestSent', { defaultValue: '已发送申请' }),
      }));
      onNotice(fr.status === 'accepted' ? t('memberChat.friendAdded', { defaultValue: '已与 {{name}} 成为好友', name: hit.username }) : t('memberChat.friendRequestSent', { defaultValue: '好友申请已发送' }));
    } catch (e) {
      const msg = (e as Error).message;
      // 幂等重放 / 已是好友时不打断用户
      setErr(msg);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('memberChat.addFriendTitle', { defaultValue: '添加好友' })}
      size="small"
      contentClassName="member-chat__modal-form"
    >
      <Search
        value={q}
        onChange={setQ}
        placeholder={t('memberChat.searchUsername', { defaultValue: '输入对方用户名搜索' })}
        loading={searching}
        autoFocus
      />
      {err && <div className="member-chat__modal-error">{err}</div>}
      <div className="member-chat__friend-hits">
        {!searching && q.trim() && hits.length === 0 && (
          <Empty
            title={t('memberChat.noUserFound', { defaultValue: '未找到匹配的用户' })}
          />
        )}
        {hits.map((h) => (
          <div key={h.id} className="member-chat__friend-hit">
            <span className="member-chat__friend-hit-name">
              {h.username}
              {h.nickname && h.nickname !== h.username && (
                <span className="member-chat__group">{h.nickname}</span>
              )}
            </span>
            <Button
              variant="primary"
              size="small"
              disabled={!!sentMap[h.id]}
              onClick={() => doSend(h)}
            >
              {sentMap[h.id] || t('memberChat.addFriendAction', { defaultValue: '加好友' })}
            </Button>
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
  const { t } = useI18n();
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
    <Modal
      isOpen
      onClose={onClose}
      title={`${t('memberChat.friendRequestsTitle', { defaultValue: '好友申请' })}（${requests.length}）`}
      size="small"
      contentClassName="member-chat__modal-form"
    >
      {requests.length === 0 && (
        <Empty title={t('memberChat.noRequests', { defaultValue: '暂无待处理的申请' })} />
      )}
      {requests.map((r) => (
        <div key={r.id} className="member-chat__friend-hit">
          <span className="member-chat__friend-hit-name">{r.requester_name}</span>
          <span className="member-chat__friend-hit-actions">
            <Button
              variant="primary"
              size="small"
              isLoading={busyId === r.id}
              onClick={() => respond(r.id, true)}
            >
              {t('memberChat.accept', { defaultValue: '接受' })}
            </Button>
            <Button
              variant="secondary"
              size="small"
              isLoading={busyId === r.id}
              onClick={() => respond(r.id, false)}
            >
              {t('memberChat.reject', { defaultValue: '拒绝' })}
            </Button>
          </span>
        </div>
      ))}
    </Modal>
  );
};
