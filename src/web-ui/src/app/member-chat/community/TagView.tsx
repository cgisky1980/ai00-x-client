/**
 * TagView — 话题聚合页（迁移 032）
 *
 * 话题头卡（#tag + 讨论数）+ 该话题下的帖子流（复用 PostCard）+ 底部哨兵续拉。
 * 数据走 feedSquare?tag=（服务端 list_community_posts_by_tag，before 游标）。
 * 点标签chip可再点取消回到全部（feedTag 清空后仍留在本页看全量流）。
 */
import React, { useEffect, useRef } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Empty, IconButton, Skeleton } from '@/component-library';
import { ArrowLeft, Hash, X } from 'lucide-react';
import { useCommunityStore } from './communityStore';
import { PostCard } from './PostCard';

export const TagView: React.FC = () => {
  const { t } = useI18n('community');
  const feedTag = useCommunityStore((s) => s.feedTag);
  const posts = useCommunityStore((s) => s.tagPosts);
  const loading = useCommunityStore((s) => s.tagLoading);
  const hasMore = useCommunityStore((s) => s.tagHasMore);
  const back = useCommunityStore((s) => s.back);
  const setFeedTag = useCommunityStore((s) => s.setFeedTag);
  const loadTagPosts = useCommunityStore((s) => s.loadTagPosts);
  const loadMoreTag = useCommunityStore((s) => s.loadMoreTag);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadTagPosts(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMoreTag();
      },
      { rootMargin: '240px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMoreTag]);

  return (
    <div className="community-tagview">
      <header className="community-tagview__head">
        <IconButton
          variant="ghost"
          shape="square"
          tooltip={t('back', { defaultValue: '返回' })}
          aria-label={t('back', { defaultValue: '返回' })}
          onClick={back}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <span className="community-tagview__tag">
          <Hash size={16} aria-hidden />
          {feedTag || t('tagAll', { defaultValue: '全部' })}
        </span>
        {feedTag && (
          <Button variant="ghost" size="small" onClick={() => setFeedTag('')}>
            <X size={12} aria-hidden />
            {t('tagClearFilter', { defaultValue: '看全站' })}
          </Button>
        )}
      </header>

      <div className="community-tagview__list">
        {posts.map((p) => (
          <PostCard key={p.id} post={p} />
        ))}
        {loading && <Skeleton style={{ height: 120 }} />}
        {!loading && posts.length === 0 && (
          <Empty
            title={t('tagEmptyTitle', { defaultValue: '这个话题下还没有动态' })}
            description={t('tagEmptyHint', { defaultValue: '发布带该话题的第一条动态吧' })}
          />
        )}
        {hasMore && <div ref={sentinelRef} aria-hidden />}
      </div>
    </div>
  );
};
