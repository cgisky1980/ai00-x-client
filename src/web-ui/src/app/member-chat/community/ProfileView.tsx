/**
 * ProfileView — 个人主页（我的/他人通用）
 *
 * 资料卡（头像/昵称/@username/bio/位置/网站 + 动态/关注/粉丝计数）+
 * 操作区（自己=编辑主页；他人=关注 toggle + 互关好友「发消息」）+ 动态墙。
 * 互关即好友：互关徽标展示，取关前 confirm 提示将解除好友。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import {
  Avatar,
  Button,
  confirmDialog,
  Empty,
  IconButton,
  Modal,
  Skeleton,
  Tag,
  toastError,
  toastSuccess,
} from '@/component-library';
import { ArrowLeft, MessageCircle, Pencil } from 'lucide-react';
import { useMemberChatStore } from '../store/memberChatStore';
import { useCommunityStore } from './communityStore';
import { PostCard } from './PostCard';
import { ProfileEditModal } from './ProfileEditModal';
import { FollowListModal } from './FollowListModal';

export const ProfileView: React.FC = () => {
  const { t } = useI18n();
  const home = useCommunityStore((s) => s.home);
  const homePosts = useCommunityStore((s) => s.homePosts);
  const homeHasMore = useCommunityStore((s) => s.homeHasMore);
  const loadHomePosts = useCommunityStore((s) => s.loadHomePosts);
  const toggleFollow = useCommunityStore((s) => s.toggleFollow);
  const back = useCommunityStore((s) => s.back);
  const openProfile = useCommunityStore((s) => s.openProfile);

  const myMemberId = useMemberChatStore((s) => s.session?.memberId ?? null);
  const createDm = useMemberChatStore((s) => s.createDm);
  const setRailTab = useMemberChatStore((s) => s.setRailTab);

  const [editing, setEditing] = useState(false);
  const [listMode, setListMode] = useState<'followers' | 'following' | null>(null);
  const [busy, setBusy] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadHomePosts(false);
      },
      { rootMargin: '240px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadHomePosts, homeHasMore]);

  if (!home) {
    return (
      <div className="community-profile community-profile--loading" aria-busy>
        <Skeleton style={{ height: 120 }} />
        <Skeleton style={{ height: 200 }} />
      </div>
    );
  }

  const isSelf = home.member_id === myMemberId;
  const displayName = home.nickname || home.username;

  /** 关注/取关：取关互关好友需 confirm（将解除好友） */
  const onToggleFollow = async () => {
    if (home.viewer_follows && home.is_friend) {
      const ok = await confirmDialog({
        title: t('community.unfollowTitle', { defaultValue: '取消关注' }),
        message: t('community.unfollowFriendHint', {
          defaultValue: '@' + home.username + ' 是你的好友，取关后将解除好友关系。确定吗？',
        }),
        confirmDanger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    const r = await toggleFollow(home.member_id);
    setBusy(false);
    if (r?.became_friend) {
      toastSuccess(t('community.becameFriend', { defaultValue: '已互相关注，成为好友，可以私聊了' }));
    }
  };

  /** 互关好友 → 发起私聊并跳回消息 tab */
  const onSendMessage = async () => {
    try {
      await createDm(home.member_id, displayName);
      setRailTab('chats');
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="community-profile"
      data-profile-theme={home.profile_theme || 'xuanzhi'}
    >
      <header className="community-profile__topbar">
        <IconButton
          variant="ghost"
          shape="square"
          tooltip={t('community.back', { defaultValue: '返回' })}
          aria-label={t('community.back', { defaultValue: '返回' })}
          onClick={back}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <span className="community-profile__title">
          {t('community.profileTitle', { defaultValue: '个人主页' })}
        </span>
      </header>

      <div className="community-profile__scroll">
        <section className="community-profile__card">
          <div className="community-profile__id">
            <Avatar name={displayName} size="xl" src={home.avatar || undefined} />
            <div className="community-profile__id-text">
              <span className="community-profile__name">
                {displayName}
                {home.is_friend && (
                  <Tag color="gray" size="small">
                    {t('community.friendBadge', { defaultValue: '好友' })}
                  </Tag>
                )}
              </span>
              <span className="community-profile__username ds-data">@{home.username}</span>
            </div>
            <span className="community-profile__ops">
              {isSelf ? (
                <Button variant="secondary" size="small" onClick={() => setEditing(true)}>
                  <Pencil size={13} aria-hidden />
                  {t('community.editProfile', { defaultValue: '编辑主页' })}
                </Button>
              ) : (
                <>
                  <Button
                    variant={home.viewer_follows ? 'secondary' : 'primary'}
                    size="small"
                    isLoading={busy}
                    onClick={() => void onToggleFollow()}
                  >
                    {home.viewer_follows
                      ? t('community.unfollow', { defaultValue: '已关注' })
                      : home.follows_viewer
                        ? t('community.followBack', { defaultValue: '回关' })
                        : t('community.follow', { defaultValue: '关注' })}
                  </Button>
                  {home.is_friend && (
                    <Button variant="secondary" size="small" onClick={() => void onSendMessage()}>
                      <MessageCircle size={13} aria-hidden />
                      {t('community.sendMessage', { defaultValue: '发消息' })}
                    </Button>
                  )}
                </>
              )}
            </span>
          </div>

          {home.bio && <p className="community-profile__bio">{home.bio}</p>}
          {(home.location || home.website) && (
            <p className="community-profile__meta ds-data">
              {[home.location, home.website].filter(Boolean).join(' · ')}
            </p>
          )}

          <nav className="community-profile__counts" aria-label={t('community.counts', { defaultValue: '计数' })}>
            <span className="community-profile__count">
              <b className="ds-data">{home.post_count}</b>
              {t('community.countPosts', { defaultValue: '动态' })}
            </span>
            <button type="button" className="community-profile__count community-profile__count--link" onClick={() => setListMode('following')}>
              <b className="ds-data">{home.following_count}</b>
              {t('community.countFollowing', { defaultValue: '关注' })}
            </button>
            <button type="button" className="community-profile__count community-profile__count--link" onClick={() => setListMode('followers')}>
              <b className="ds-data">{home.followers_count}</b>
              {t('community.countFollowers', { defaultValue: '粉丝' })}
            </button>
          </nav>
        </section>

        <section className="community-profile__wall">
          {homePosts.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
          {homeHasMore && <div ref={sentinelRef} aria-hidden />}
          {!homeHasMore && homePosts.length === 0 && (
            <Empty
              title={t('community.profileNoPosts', { defaultValue: '还没有动态' })}
              description={
                isSelf
                  ? t('community.profileNoPostsSelf', { defaultValue: '去广场发布第一条动态吧' })
                  : undefined
              }
            />
          )}
        </section>
      </div>

      <ProfileEditModal
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={() => {
          void useCommunityStore.getState().reloadHome();
          toastSuccess(t('community.profileSaved', { defaultValue: '主页已更新' }));
        }}
      />
      <Modal
        isOpen={listMode != null}
        onClose={() => setListMode(null)}
        title={
          listMode === 'following'
            ? t('community.followingList', { defaultValue: '关注列表' })
            : t('community.followersList', { defaultValue: '粉丝列表' })
        }
        size="small"
        contentClassName="community-follow-modal"
      >
        {listMode && (
          <FollowListModal
            memberId={home.member_id}
            mode={listMode}
            onPick={(id) => {
              if (id !== home.member_id) openProfile(id);
              setListMode(null);
            }}
          />
        )}
      </Modal>
    </div>
  );
};
