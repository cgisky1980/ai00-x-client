/**
 * ProfileStream — 主页的「一条流」：动态（瞬间/朋友圈）与作品混排在同一个网格里
 *
 * ── 为什么只有一种卡 ──────────────────────────────────────
 * 社区是开放的创作场：一个人今天写歌、明天写点字、后天做游戏。
 * 按内容类型分卡片，等于替人分类；所以**卡只有一种**，歌曲和动态走同一
 * 个渲染器，差异只体现在数据（封面/标题/数字），不体现在骨架。
 *
 * 这也是 Flarum 扩展中心那种卡片列表好看的原因：整页一张 hero 卡 +
 * 一片同款卡，舒适感来自骨架唯一，不来自元素多。
 *
 * 卡的结构（两套皮肤共用，只改描边语言/配色/装饰）：
 *   ┌─────────────────┐
 *   │   色块封面        │  有图用图，无图排版大字（压在柔和色块上）
 *   │  ┌───┐          │  漫画风时这里多一块倾斜的图标砖
 *   │  │ 字 │          │
 *   │  └───┘          │
 *   ├─────────────────┤
 *   │ 标题             │
 *   │ @user · 3:47     │  等宽 meta（机器感）
 *   │ 摘要…            │
 *   ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤  虚线分隔
 *   │ ▶ 3,204   3 天前 │  mono 数字
 *   └─────────────────┘
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Empty, toastError } from '@/component-library';
import { Download, Heart, MessageCircle, Play } from 'lucide-react';
import {
  resolveMediaUrl,
  type CommunityPost,
  type MemberSongWork,
} from './communityApi';
import { playShare } from './communityPlayer';
import { mdPreview } from './md';
import { coverLetter } from './coverArt';
import { useShareCover } from '@/tools/acestep/hooks/useShareCover';
import { formatRelTime } from './time';
import { postToWork, songToWork, WORK_TYPE_META, type WorkItem } from './works';

// ---------------------------------------------------------------------------
// StreamCard — 唯一的卡片渲染器（歌曲与动态共用）
// ---------------------------------------------------------------------------

export const StreamCard: React.FC<{
  work: WorkItem;
  onOpenPost: (p: CommunityPost) => void;
  onDiscuss?: (shareId: string) => void;
}> = ({ work, onOpenPost, onDiscuss }) => {
  const { t } = useI18n('community');
  const isSong = work.type === 'song';
  const song = isSong ? (work.raw as MemberSongWork) : null;
  const post = isSong ? null : (work.raw as CommunityPost);

  // 歌曲封面走 share 通道（服务端签名 URL），动态走媒体解析
  const songCover = useShareCover(song?.share_id ?? '', song?.cover_url ?? null);
  const [postCover, setPostCover] = useState('');
  const postPreview = useMemo(
    () => (post ? mdPreview(post.content) : null),
    [post],
  );
  useEffect(() => {
    if (!post) return;
    const raw =
      post.cover_url
      || post.media?.find((m) => m.type === 'image')?.thumb
      || postPreview?.firstImage
      || null;
    if (!raw) {
      setPostCover('');
      return;
    }
    let alive = true;
    void resolveMediaUrl(raw)
      .then((s) => {
        if (alive) setPostCover(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [post, postPreview]);

  const cover = isSong ? songCover : postCover;
  const title = work.title || postPreview?.title || postPreview?.body.slice(0, 24) || '';
  const excerpt = postPreview ? postPreview.body.slice(0, 90) : '';

  const onPlay = async () => {
    if (!song) return;
    if ((await playShare(song.share_id)) === 'unavailable') {
      toastError(t('playUnavailable', { defaultValue: '播放引擎未就绪，请打开音乐窗口后重试' }));
    }
  };

  const onActivate = () => {
    if (isSong) void onPlay();
    else if (post) onOpenPost(post);
  };

  const time = isSong ? song?.created_at : post?.created_at;

  return (
    <article
      className={`community-stream-card${isSong ? ' community-stream-card--song' : ' community-stream-card--post'}`}
    >
      {/* 卡顶色块封面：有图用图，无图排版大字压在柔和色块上 */}
      <button
        type="button"
        className="community-stream-card__cover"
        onClick={onActivate}
        aria-label={title || t('openWork', { defaultValue: '打开' })}
      >
        {cover ? (
          <img src={cover} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="community-stream-card__letter" aria-hidden>
            {isSong ? <Play size={22} fill="currentColor" /> : coverLetter(title || '文')}
          </span>
        )}
        {/* 倾斜图标砖：漫画风才显形，极简风隐藏 */}
        <span className="community-stream-card__tile" aria-hidden>
          {isSong ? <Play size={13} fill="currentColor" /> : <MessageCircle size={13} />}
        </span>
        {isSong && (work.metrics.plays ?? 0) > 0 && (
          <span className="community-stream-card__badge ds-data">
            <Play size={10} fill="currentColor" aria-hidden />
            {(work.metrics.plays ?? 0).toLocaleString()}
          </span>
        )}
      </button>

      <div className="community-stream-card__body">
        <h3 className="community-stream-card__title">{title}</h3>
        {/* 等宽 meta：机器感，和手绘体/衬线体互补（Flarum 卡片同款手法） */}
        <p className="community-stream-card__meta ds-data">
          <span className="community-stream-card__kind">
            {isSong
              ? t('kindSong', { defaultValue: '歌曲' })
              : t('kindPost', { defaultValue: '动态' })}
          </span>
          {work.subtitle && <span>{work.subtitle}</span>}
        </p>
        {excerpt && <p className="community-stream-card__excerpt">{excerpt}</p>}

        {/* 虚线分隔：把内容区与数据行切开（漫画风的节奏记号） */}
        <footer className="community-stream-card__foot">
          <span className="community-stream-card__stats ds-data">
            {isSong ? (
              <span title={t('plays', { defaultValue: '播放' })}>
                <Download size={11} strokeWidth={1.8} aria-hidden />
                {(work.metrics.plays ?? 0).toLocaleString()}
              </span>
            ) : (
              <>
                <span title={t('like', { defaultValue: '点赞' })}>
                  <Heart size={11} strokeWidth={1.8} aria-hidden />
                  {post?.like_count ?? 0}
                </span>
                <span title={t('comment', { defaultValue: '评论' })}>
                  <MessageCircle size={11} strokeWidth={1.8} aria-hidden />
                  {post?.comment_count ?? 0}
                </span>
              </>
            )}
          </span>
          <time className="community-stream-card__time ds-data">
            {time ? formatRelTime(time) : ''}
          </time>
          {isSong && onDiscuss && song ? (
            <button
              type="button"
              className="community-stream-card__go ds-data"
              onClick={(e) => {
                e.stopPropagation();
                onDiscuss(song.share_id);
              }}
            >
              {t('goDiscuss', { defaultValue: '讨论' })}
            </button>
          ) : (
            <button
              type="button"
              className="community-stream-card__go"
              onClick={onActivate}
              aria-label={t('openWork', { defaultValue: '打开' })}
            >
              {t('open', { defaultValue: '打开' })}
            </button>
          )}
        </footer>
      </div>
    </article>
  );
};

// ---------------------------------------------------------------------------
// ProfileStream — 混排网格（按创建时间倒序；类型筛选只是过滤，不换骨架）
// ---------------------------------------------------------------------------

export const ProfileStream: React.FC<{
  songs: MemberSongWork[];
  songsLoading: boolean;
  songsHasMore: boolean;
  onLoadMoreSongs: () => void;
  posts: CommunityPost[];
  emptyHint?: string;
  onOpenPost: (p: CommunityPost) => void;
  onDiscuss: (shareId: string) => void;
}> = ({
  songs,
  songsLoading,
  songsHasMore,
  onLoadMoreSongs,
  posts,
  emptyHint,
  onOpenPost,
  onDiscuss,
}) => {
  const { t } = useI18n('community');
  const [chip, setChip] = useState<string>('all');


  const items = useMemo<WorkItem[]>(() => {
    const songWorks = songs.map(songToWork);
    const postWorks = posts.filter((p) => !p.repost_of).map(postToWork);
    const picked = chip === 'song' ? songWorks : chip === 'post' ? postWorks : [...songWorks, ...postWorks];
    const ts = (w: WorkItem) =>
      w.type === 'song'
        ? (w.raw as MemberSongWork).created_at
        : (w.raw as CommunityPost).created_at;
    return picked.sort((a, b) => (ts(a) < ts(b) ? 1 : -1));
  }, [chip, songs, posts]);

  return (
    <div className="community-stream">
      <div
        className="community-stream__filters"
        role="tablist"
        aria-label={t('worksFilter', { defaultValue: '内容类型' })}
      >
        {WORK_TYPE_META.filter((m) => m.enabled).map((m) => (
          <button
            key={m.type}
            type="button"
            role="tab"
            aria-selected={chip === m.type}
            className={`community-stream__filter ${chip === m.type ? 'is-active' : ''}`}
            onClick={() => setChip(m.type)}
          >
            {m.icon}
            {m.label}
          </button>
        ))}
      </div>

      {items.length === 0 && !songsLoading ? (
        <Empty
          title={t('worksEmpty', { defaultValue: '还没有内容' })}
          description={emptyHint ?? t('worksEmptyHint', { defaultValue: '发布的歌曲与动态都会出现在这里' })}
        />
      ) : (
        <div className="community-stream__grid">
          {items.map((w) => (
            <StreamCard
              key={`${w.type}-${w.id}`}
              work={w}
              onOpenPost={onOpenPost}
              onDiscuss={onDiscuss}
            />
          ))}
        </div>
      )}

      {chip !== 'post' && songsHasMore && (
        <div className="community-stream__more">
          <Button variant="ghost" size="small" disabled={songsLoading} onClick={onLoadMoreSongs}>
            {songsLoading
              ? t('loading', { defaultValue: '加载中…' })
              : t('loadMore', { defaultValue: '加载更多' })}
          </Button>
        </div>
      )}
    </div>
  );
};