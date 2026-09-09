/**
 * FeedView — 广场流（三 tab：最新/热门/关注 + 话题过滤 + 搜索）
 *
 * 顶栏：自绘文字 tab（沿用 member-chat 风格）+ 搜索框 + 通知入口（badge）+ 发布按钮；
 * 话题行：热门 tag 横滑条（P1.3，点击过滤 feed，激活态可再点取消）；
 * 列表：PostCard 流 + 首屏 Skeleton + 空态 Empty + 底部哨兵 IntersectionObserver
 * 触发 loadMore 游标分页。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Empty, IconButton, Skeleton } from '@/component-library';
import { Bell, Hash, PenLine, Search, X } from 'lucide-react';
import { useCommunityStore, type FeedTab } from './communityStore';
import { useMemberChatStore } from '../store/memberChatStore';
import { MemberAvatar } from '../components/MemberAvatar';
import { PostCard } from './PostCard';
import { PostComposer } from './PostComposer';
import { communityApi } from './communityApi';

const TABS: { key: FeedTab; labelKey: string; label: string }[] = [
  { key: 'latest', labelKey: 'community.tabLatest', label: '最新' },
  { key: 'hot', labelKey: 'community.tabHot', label: '热门' },
  { key: 'following', labelKey: 'community.tabFollowing', label: '关注' },
];

const FeedSkeleton: React.FC = () => (
  <div className="community-feed__skeleton" aria-hidden>
    {[0, 1, 2].map((i) => (
      <div key={i} className="community-feed__skeleton-card">
        <Skeleton style={{ width: 40, height: 40, borderRadius: 'var(--radius-full)' }} />
        <div className="community-feed__skeleton-lines">
          <Skeleton style={{ width: '32%', height: 14 }} />
          <Skeleton style={{ width: '92%', height: 12 }} />
          <Skeleton style={{ width: '68%', height: 12 }} />
        </div>
      </div>
    ))}
  </div>
);

/** 热门话题横滑条（P1.3） */
const HotTagsBar: React.FC = () => {
  const { t } = useI18n('community');
  const feedTag = useCommunityStore((s) => s.feedTag);
  const setFeedTag = useCommunityStore((s) => s.setFeedTag);
  const [tags, setTags] = useState<Array<{ tag: string; post_count: number }> | null>(null);

  useEffect(() => {
    let alive = true;
    void communityApi
      .hotTags(10)
      .then((r) => {
        if (alive) setTags(r.tags);
      })
      .catch(() => {
        if (alive) setTags([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!tags || tags.length === 0) return null;
  return (
    <div className="community-feed__tags" role="tablist" aria-label={t('hotTags', { defaultValue: '热门话题' })}>
      {tags.map(({ tag, post_count }) => (
        <button
          key={tag}
          type="button"
          className={`community-feed__tag ${feedTag === tag ? 'is-active' : ''}`}
          onClick={() => setFeedTag(feedTag === tag ? '' : tag)}
        >
          <Hash size={11} aria-hidden />
          {tag}
          <span className="ds-data">{post_count}</span>
        </button>
      ))}
    </div>
  );
};

export const FeedView: React.FC = () => {
  const { t } = useI18n('community');
  const feedTab = useCommunityStore((s) => s.feedTab);
  const feedTag = useCommunityStore((s) => s.feedTag);
  const posts = useCommunityStore((s) => s.posts);
  const loading = useCommunityStore((s) => s.loading);
  const hasMore = useCommunityStore((s) => s.hasMore);
  const unreadNotices = useCommunityStore((s) => s.unreadNotices);
  const setFeedTab = useCommunityStore((s) => s.setFeedTab);
  const setFeedTag = useCommunityStore((s) => s.setFeedTag);
  const search = useCommunityStore((s) => s.search);
  const loadMore = useCommunityStore((s) => s.loadMore);
  const openNotifications = useCommunityStore((s) => s.openNotifications);
  const openProfile = useCommunityStore((s) => s.openProfile);
  const myMemberId = useMemberChatStore((s) => s.session?.memberId ?? null);
  const myName = useMemberChatStore(
    (s) => s.myProfile?.nickname || s.myProfile?.username || s.session?.username || '?',
  );
  const myAvatar = useMemberChatStore((s) => s.myProfile?.avatarData ?? null);

  const [composing, setComposing] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // 底部哨兵 → 加载下一页
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: '240px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  return (
    <div className="community-feed">
      <header className="community-feed__topbar">
        <nav className="community-tabs" role="tablist" aria-label={t('feedTabs', { defaultValue: '动态流' })}>
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={feedTab === tab.key}
              className={`community-tabs__item ${feedTab === tab.key ? 'is-active' : ''}`}
              onClick={() => setFeedTab(tab.key)}
            >
              {t(tab.labelKey, { defaultValue: tab.label })}
            </button>
          ))}
        </nav>
        <span className="community-feed__topbar-actions">
          <form
            className="community-feed__search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              search(searchDraft);
            }}
          >
            <Search size={13} aria-hidden />
            <input
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder={t('searchPlaceholder', { defaultValue: '搜索动态…' })}
              aria-label={t('searchPlaceholder', { defaultValue: '搜索动态…' })}
              maxLength={100}
            />
          </form>
          <button
            type="button"
            className="community-feed__me"
            onClick={() => {
              if (myMemberId != null) openProfile(myMemberId);
            }}
            title={t('myProfile', { defaultValue: '我的主页' })}
            aria-label={t('myProfile', { defaultValue: '我的主页' })}
          >
            <MemberAvatar name={myName} size="sm" data={myAvatar} />
          </button>
          <IconButton
            variant="ghost"
            shape="square"
            tooltip={t('noticeTitle', { defaultValue: '通知' })}
            aria-label={t('noticeTitle', { defaultValue: '通知' })}
            onClick={openNotifications}
          >
            <Bell size={18} strokeWidth={1.8} />
            {unreadNotices > 0 && <span className="community-feed__dot" aria-hidden />}
          </IconButton>
          <Button variant="primary" size="small" onClick={() => setComposing(true)}>
            <PenLine size={14} aria-hidden />
            {t('compose', { defaultValue: '发布' })}
          </Button>
        </span>
      </header>

      <HotTagsBar />

      {feedTag && (
        <div className="community-feed__tagbar">
          <span>
            <Hash size={12} aria-hidden />
            {t('tagFilter', { defaultValue: '话题：{{tag}}', tag: feedTag })}
          </span>
          <button
            type="button"
            className="community-feed__tagbar-clear"
            aria-label={t('common:cancel', { defaultValue: '取消' })}
            onClick={() => setFeedTag('')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="community-feed__list">
        {posts.map((p) => (
          <PostCard key={p.id} post={p} />
        ))}
        {loading && <FeedSkeleton />}
        {!loading && posts.length === 0 && (
          <Empty
            title={t('feedEmptyTitle', { defaultValue: '还没有动态' })}
            description={
              feedTag
                ? t('tagEmpty', { defaultValue: '这个话题下还没有动态' })
                : feedTab === 'following'
                  ? t('feedEmptyFollowing', { defaultValue: '关注一些人，他们的动态会出现在这里' })
                  : t('feedEmptyHint', { defaultValue: '发布第一条动态，开始你的主页' })
            }
          />
        )}
        {hasMore && <div ref={sentinelRef} className="community-feed__sentinel" aria-hidden />}
      </div>

      <PostComposer open={composing} onClose={() => setComposing(false)} />
    </div>
  );
};
