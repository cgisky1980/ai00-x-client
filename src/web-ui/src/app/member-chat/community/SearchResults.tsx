/**
 * SearchResults — 搜索结果流（P1.5）
 *
 * 顶栏返回 + 查询词；PostCard 流 + 空态 + 底部哨兵续拉。
 */
import React, { useEffect, useRef } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Empty, IconButton, Skeleton } from '@/component-library';
import { ArrowLeft } from 'lucide-react';
import { useCommunityStore } from './communityStore';
import { PostCard } from './PostCard';

export const SearchResults: React.FC = () => {
  const { t } = useI18n('community');
  const query = useCommunityStore((s) => s.searchQuery);
  const posts = useCommunityStore((s) => s.searchPosts);
  const loading = useCommunityStore((s) => s.searchLoading);
  const hasMore = useCommunityStore((s) => s.searchHasMore);
  const back = useCommunityStore((s) => s.back);
  const loadMoreSearch = useCommunityStore((s) => s.loadMoreSearch);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMoreSearch();
      },
      { rootMargin: '240px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMoreSearch]);

  return (
    <div className="community-search">
      <header className="community-detail__topbar">
        <IconButton
          variant="ghost"
          shape="square"
          tooltip={t('back', { defaultValue: '返回' })}
          aria-label={t('back', { defaultValue: '返回' })}
          onClick={back}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <span className="community-detail__title ds-data">{query}</span>
      </header>
      <div className="community-feed__list">
        {posts.map((p) => (
          <PostCard key={p.id} post={p} />
        ))}
        {loading && (
          <div aria-hidden>
            <Skeleton style={{ height: 88 }} />
          </div>
        )}
        {!loading && posts.length === 0 && (
          <Empty
            title={t('searchEmpty', { defaultValue: '没有找到相关动态' })}
            description={t('searchEmptyHint', { defaultValue: '换个关键词试试' })}
          />
        )}
        {hasMore && <div ref={sentinelRef} className="community-feed__sentinel" aria-hidden />}
      </div>
    </div>
  );
};
