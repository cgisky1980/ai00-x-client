/**
 * SearchResults — 搜索结果流（P1.5；迁移 032 加用户 tab）
 *
 * 顶栏返回 + 查询词；tab 切换「动态/用户」：
 * - 动态：PostCard 流 + 空态 + 底部哨兵续拉（服务端 FTS5/LIKE，标题+正文）；
 * - 用户：chatApi.searchMembers（username/nickname 前缀匹配），点击进主页。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Empty, IconButton, Skeleton } from '@/component-library';
import { ArrowLeft, User } from 'lucide-react';
import { useCommunityStore } from './communityStore';
import { chatApi, type MemberHit } from '../chatApi';
import { PostCard } from './PostCard';
import { MemberAvatar } from '../components/MemberAvatar';

export const SearchResults: React.FC = () => {
  const { t } = useI18n('community');
  const query = useCommunityStore((s) => s.searchQuery);
  const posts = useCommunityStore((s) => s.searchPosts);
  const loading = useCommunityStore((s) => s.searchLoading);
  const hasMore = useCommunityStore((s) => s.searchHasMore);
  const back = useCommunityStore((s) => s.back);
  const loadMoreSearch = useCommunityStore((s) => s.loadMoreSearch);
  const openProfile = useCommunityStore((s) => s.openProfile);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const [tab, setTab] = useState<'posts' | 'members'>('posts');
  const [members, setMembers] = useState<MemberHit[] | null>(null);

  useEffect(() => {
    if (tab !== 'members' || !query) return;
    let alive = true;
    setMembers(null);
    void chatApi
      .searchMembers(query, 20)
      .then((r) => {
        if (alive) setMembers(r.hits);
      })
      .catch(() => {
        if (alive) setMembers([]);
      });
    return () => {
      alive = false;
    };
  }, [tab, query]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && tab === 'posts') void loadMoreSearch();
      },
      { rootMargin: '240px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMoreSearch, tab]);

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

      <nav className="community-search__tabs" role="tablist">
        {(
          [
            ['posts', t('searchTabPosts', { defaultValue: '动态' })],
            ['members', t('searchTabMembers', { defaultValue: '用户' })],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`community-tabs__item ${tab === key ? 'is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'posts' && (
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
      )}

      {tab === 'members' && (
        <div className="community-feed__list">
          {(members ?? []).map((m) => (
            <button
              key={m.id}
              type="button"
              className="community-search__member"
              onClick={() => openProfile(m.id)}
            >
              <MemberAvatar name={m.nickname || m.username} size="base" />
              <span className="community-search__member-name">
                {m.nickname || m.username}
              </span>
              <span className="community-search__member-handle ds-data">@{m.username}</span>
              <User size={14} className="community-search__member-go" aria-hidden />
            </button>
          ))}
          {members != null && members.length === 0 && (
            <Empty
              title={t('searchMemberEmpty', { defaultValue: '没有找到相关用户' })}
              description={t('searchMemberHint', { defaultValue: '试试完整用户名' })}
            />
          )}
          {members == null && (
            <div aria-hidden>
              <Skeleton style={{ height: 56 }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
