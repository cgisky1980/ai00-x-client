/**
 * FeedView — 广场流（四 tab：最新/热门/关注/新歌 + 话题过滤 + 搜索）
 *
 * 顶栏：自绘文字 tab（沿用 member-chat 风格）+ 搜索框 + 通知入口（badge）+ 发布按钮；
 * 话题行：热门 tag 横滑条（P1.3，点击过滤 feed，激活态可再点取消）；
 * 列表：PostCard 流 + 首屏 Skeleton + 空态 Empty + 底部哨兵 IntersectionObserver
 * 触发 loadMore 游标分页；新歌 tab 走独立 SongsPanel（/share/recent，迁移 030）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Empty, IconButton, Skeleton, toastError, toastSuccess } from '@/component-library';
import { Bell, CheckCircle2, ChevronDown, Gift, Hash, Megaphone, PenLine, Play, Search, X } from 'lucide-react';
import { useCommunityStore, type FeedTab } from './communityStore';
import { useMemberChatStore } from '../store/memberChatStore';
import { MemberAvatar } from '../components/MemberAvatar';
import { PostCard } from './PostCard';
import { PostComposer } from './PostComposer';
import {
  communityApi,
  gamificationApi,
  type DailyQuest,
  type SharedSongItem,
  type XpLevelProfile,
} from './communityApi';
import { SongCard } from './SongCard';
import { playShare } from './communityPlayer';

const TABS: { key: FeedTab; labelKey: string; label: string }[] = [
  { key: 'latest', labelKey: 'community.tabLatest', label: '最新' },
  { key: 'hot', labelKey: 'community.tabHot', label: '热门' },
  { key: 'following', labelKey: 'community.tabFollowing', label: '关注' },
  { key: 'songs', labelKey: 'community.tabSongs', label: '新歌' },
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
  const openTag = useCommunityStore((s) => s.openTag);
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
          onClick={() => openTag(tag)}
        >
          <Hash size={11} aria-hidden />
          {tag}
          <span className="ds-data">{post_count}</span>
        </button>
      ))}
    </div>
  );
};

/** 新歌 tab：歌曲广场（迁移 030；latest/hot 子切换 + 行卡播放 + 去讨论跳社区帖） */
const SongsPanel: React.FC = () => {
  const { t } = useI18n('community');
  const [sort, setSort] = useState<'latest' | 'hot'>('latest');
  const [songs, setSongs] = useState<SharedSongItem[] | null>(null);
  const openPostById = useCommunityStore((s) => s.openPostById);

  useEffect(() => {
    let alive = true;
    setSongs(null);
    void communityApi
      .listSongs(sort, 50)
      .then((r) => {
        if (alive) setSongs(r.songs);
      })
      .catch(() => {
        if (alive) setSongs([]);
      });
    return () => {
      alive = false;
    };
  }, [sort]);

  const goDiscuss = async (shareId: string) => {
    try {
      const { post_id } = await communityApi.postByShare(shareId);
      void openPostById(post_id);
    } catch {
      toastError(t('songPostMissing', { defaultValue: '这首歌还没有社区讨论帖' }));
    }
  };

  return (
    <div className="community-songs">
      <div className="community-songs__subtabs" role="tablist" aria-label={t('songsSort', { defaultValue: '歌曲排序' })}>
        {(
          [
            ['latest', t('songsLatest', { defaultValue: '最新发行' })],
            ['hot', t('songsHot', { defaultValue: '最热播放' })],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={sort === key}
            className={`community-songs__subtab ${sort === key ? 'is-active' : ''}`}
            onClick={() => setSort(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="community-songs__list">
        {(songs ?? []).map((s) => (
          <SongCard
            key={s.shareId}
            variant="row"
            item={{
              type: 'song',
              url: s.coverUrl ?? '',
              share_id: s.shareId,
              title: s.title,
              artist: s.artistName ?? '',
              duration: s.durationSeconds,
            }}
            onOpen={() => void playShare(s.shareId)}
            extra={
              <>
                <span className="community-song__plays ds-data">
                  <Play size={12} aria-hidden />
                  {s.playCount}
                </span>
                <button
                  type="button"
                  className="community-post__action"
                  onClick={() => void goDiscuss(s.shareId)}
                >
                  <span className="ds-data">{t('goDiscuss', { defaultValue: '去讨论' })}</span>
                </button>
              </>
            }
          />
        ))}
        {songs != null && songs.length === 0 && (
          <Empty
            title={t('songsEmptyTitle', { defaultValue: '还没有人发歌' })}
            description={t('songsEmptyHint', { defaultValue: '在音乐窗口创作并发行你的第一首歌吧' })}
          />
        )}
        {songs == null && (
          <div className="community-feed__skeleton" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="community-feed__skeleton-card">
                <Skeleton style={{ width: 48, height: 48, borderRadius: 'var(--radius-base)' }} />
                <div className="community-feed__skeleton-lines">
                  <Skeleton style={{ width: '40%', height: 14 }} />
                  <Skeleton style={{ width: '60%', height: 12 }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/** 官方公告卡（迁移 032；公开端点 + 本会话关闭） */
const AnnounceCard: React.FC = () => {
  const { t } = useI18n('community');
  const [closed, setClosed] = useState(false);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    void communityApi
      .announcement()
      .then(setNotice)
      .catch(() => setNotice(null));
  }, []);

  if (closed || !notice) return null;
  return (
    <div className="community-announce">
      <Megaphone size={15} className="community-announce__icon" aria-hidden />
      <div className="community-announce__meta">
        <span className="community-announce__title">{notice.title || t('announceTitle', { defaultValue: '公告' })}</span>
        {notice.body && <span className="community-announce__body">{notice.body}</span>}
      </div>
      <button
        type="button"
        className="community-announce__close"
        onClick={() => setClosed(true)}
        aria-label={t('common:cancel', { defaultValue: '关闭' })}
      >
        <X size={12} />
      </button>
    </div>
  );
};

/** 每日任务横条（迁移 031）：收起态一行摘要，展开任务清单与领取 */
const QuestsBar: React.FC = () => {
  const { t } = useI18n('community');
  const [open, setOpen] = useState(false);
  const [quests, setQuests] = useState<DailyQuest[] | null>(null);
  const [xp, setXp] = useState<XpLevelProfile | null>(null);

  useEffect(() => {
    void gamificationApi
      .xpProfile()
      .then(setXp)
      .catch(() => setXp(null));
  }, []);

  const refresh = React.useCallback(() => {
    void gamificationApi
      .questsToday()
      .then((r) => setQuests(r.quests))
      .catch(() => setQuests([]));
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const claim = async (key: string) => {
    try {
      await gamificationApi.claimQuest(key);
      toastSuccess(t('questClaimed', { defaultValue: '奖励已领取' }));
      refresh();
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  const done = (quests ?? []).filter((q) => q.claimable || q.claimed).length;
  const total = quests?.length ?? 0;

  return (
    <div className="community-quests">
      <button type="button" className="community-quests__toggle" onClick={() => setOpen((v) => !v)}>
        {xp != null && (
          <span className="community-quests__lv" title={`${xp.into}/${xp.need} XP`}>
            Lv.{xp.level}
            <span className="community-quests__lv-bar" aria-hidden>
              <span
                className="community-quests__lv-fill"
                style={{ width: `${Math.min(100, Math.round((xp.into / Math.max(1, xp.need)) * 100))}%` }}
              />
            </span>
          </span>
        )}
        <Gift size={13} aria-hidden />
        <span>{t('dailyQuests', { defaultValue: '每日任务' })}</span>
        {quests != null && (
          <span className="ds-data">
            {done}/{total}
          </span>
        )}
        <ChevronDown size={13} className={open ? 'is-flip' : ''} aria-hidden />
      </button>
      {open && (
        <div className="community-quests__list">
          {(quests ?? []).map((q) => (
            <div key={q.key} className="community-quests__item">
              <div className="community-quests__meta">
                <span className="community-quests__name">{q.name}</span>
                <span className="community-quests__desc ds-data">
                  {q.description} · +{q.reward_credits} 积分 +{q.reward_xp} XP
                </span>
              </div>
              <div className="community-quests__side">
                <span className="ds-data">
                  {Math.min(q.progress, q.goal)}/{q.goal}
                </span>
                {q.claimed ? (
                  <CheckCircle2 size={16} className="community-quests__done" aria-hidden />
                ) : (
                  <Button
                    variant="primary"
                    size="small"
                    disabled={!q.claimable}
                    onClick={() => void claim(q.key)}
                  >
                    {t('questClaim', { defaultValue: '领取' })}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {quests != null && quests.length === 0 && (
            <div className="community-quests__empty ds-data">
              {t('questsEmpty', { defaultValue: '任务加载失败，稍后再试' })}
            </div>
          )}
        </div>
      )}
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

      {feedTab === 'songs' ? (
        <SongsPanel />
      ) : (
        <>
          <AnnounceCard />
          <QuestsBar />
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
        </>
      )}

      <PostComposer open={composing} onClose={() => setComposing(false)} />
    </div>
  );
};
