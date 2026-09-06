/**
 * FeedView — 广场流（三 tab：最新/热门/关注）
 *
 * 顶栏：自绘文字 tab（沿用 member-chat 风格）+ 通知入口（badge）+ 发布按钮；
 * 列表：PostCard 流 + 首屏 Skeleton + 空态 Empty + 底部哨兵 IntersectionObserver
 * 触发 loadMore 游标分页。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Empty, IconButton, Skeleton } from '@/component-library';
import { Bell, PenLine } from 'lucide-react';
import { useCommunityStore, type FeedTab } from './communityStore';
import { PostCard } from './PostCard';
import { PostComposer } from './PostComposer';

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

export const FeedView: React.FC = () => {
  const { t } = useI18n();
  const feedTab = useCommunityStore((s) => s.feedTab);
  const posts = useCommunityStore((s) => s.posts);
  const loading = useCommunityStore((s) => s.loading);
  const hasMore = useCommunityStore((s) => s.hasMore);
  const unreadNotices = useCommunityStore((s) => s.unreadNotices);
  const setFeedTab = useCommunityStore((s) => s.setFeedTab);
  const loadMore = useCommunityStore((s) => s.loadMore);
  const openNotifications = useCommunityStore((s) => s.openNotifications);

  const [composing, setComposing] = useState(false);
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
        <nav className="community-tabs" role="tablist" aria-label={t('community.feedTabs', { defaultValue: '动态流' })}>
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
          <IconButton
            variant="ghost"
            shape="square"
            tooltip={t('community.noticeTitle', { defaultValue: '通知' })}
            aria-label={t('community.noticeTitle', { defaultValue: '通知' })}
            onClick={openNotifications}
          >
            <Bell size={18} strokeWidth={1.8} />
            {unreadNotices > 0 && <span className="community-feed__dot" aria-hidden />}
          </IconButton>
          <Button variant="primary" size="small" onClick={() => setComposing(true)}>
            <PenLine size={14} aria-hidden />
            {t('community.compose', { defaultValue: '发布' })}
          </Button>
        </span>
      </header>

      <div className="community-feed__list">
        {posts.map((p) => (
          <PostCard key={p.id} post={p} />
        ))}
        {loading && <FeedSkeleton />}
        {!loading && posts.length === 0 && (
          <Empty
            title={t('community.feedEmptyTitle', { defaultValue: '还没有动态' })}
            description={
              feedTab === 'following'
                ? t('community.feedEmptyFollowing', { defaultValue: '关注一些人，他们的动态会出现在这里' })
                : t('community.feedEmptyHint', { defaultValue: '发布第一条动态，开始你的主页' })
            }
          />
        )}
        {hasMore && <div ref={sentinelRef} className="community-feed__sentinel" aria-hidden />}
      </div>

      <PostComposer open={composing} onClose={() => setComposing(false)} />
    </div>
  );
};
