/**
 * FollowListModal — 关注/粉丝列表内容（外层 Modal 由 ProfileView 提供）
 *
 * 行：头像+昵称（+「已关注」标记）→ 点击跳对方主页。
 * 注意：成员已被对方取关/注销时服务端列表为准。
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Avatar, Empty, Skeleton } from '@/component-library';
import { communityApi, type CommunityMemberItem } from './communityApi';

export const FollowListModal: React.FC<{
  memberId: number;
  mode: 'followers' | 'following';
  onPick: (memberId: number) => void;
}> = ({ memberId, mode, onPick }) => {
  const { t } = useI18n();
  const [items, setItems] = useState<CommunityMemberItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (mode === 'followers') {
          const res = await communityApi.listFollowers(memberId, { limit: 100 });
          if (alive) setItems(res.followers);
        } else {
          const res = await communityApi.listFollowing(memberId, { limit: 100 });
          if (alive) setItems(res.following);
        }
      } catch {
        if (alive) setItems([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [memberId, mode]);

  if (items == null) {
    return (
      <div className="community-follow-list" aria-busy>
        <Skeleton style={{ height: 40 }} />
        <Skeleton style={{ height: 40 }} />
        <Skeleton style={{ height: 40 }} />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <Empty
        title={
          mode === 'followers'
            ? t('community.followersEmpty', { defaultValue: '还没有粉丝' })
            : t('community.followingEmpty', { defaultValue: '还没有关注任何人' })
        }
      />
    );
  }
  return (
    <div className="community-follow-list">
      {items.map((m) => (
        <button
          key={m.member_id}
          type="button"
          className="community-follow-list__row"
          onClick={() => onPick(m.member_id)}
        >
          <Avatar name={m.nickname || m.username} size="sm" src={m.avatar || undefined} />
          <span className="community-follow-list__name">{m.nickname || m.username}</span>
          {m.followed_by_viewer && (
            <span className="community-follow-list__tag ds-data">
              {t('community.followingState', { defaultValue: '已关注' })}
            </span>
          )}
        </button>
      ))}
    </div>
  );
};
