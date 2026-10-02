/**
 * ProfileView — 创作者主页「造物集」（批次 1 重塑）
 *
 * 定位：AI 创作者的门面——作品即门面，色彩来自作品。三支柱：
 * 1. 沉浸 header：代表作封面 canvas 取色晕染铺满（主题引擎 --pt-* 兜底），
 *    衬线大名 + 组合身份章（作品构成动态判定）+ Lv 灵印角标。
 * 2. 影响力数据条：作品/总播放/粉丝/关注，mono tabular。
 * 3. 作品 tab（默认）：代表作置顶 ≤3 混排 + 造物墙（渲染器注册表，见 WorksWall）。
 *
 * 主题引擎（P2A）继续生效：--pt-* 变量仍驱动配色/字体/纹理/圆角，取色层在其上做增强。
 * 页签：作品 / 动态（博客卡流）/ 徽章 /（本人）归档 / 收藏。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { tokenManager } from '@/infrastructure/auth/TokenManager';
import { Button, Empty, IconButton, Modal, Skeleton, toastSuccess } from '@/component-library';
import {
  ArrowLeft,
  ArrowUpRight,
  Disc3,
  Eye,
  Globe,
  Heart,
  MapPin,
  MessageCircle,
  PenLine,
  Pin,
  Share2,
  Settings2,
} from 'lucide-react';
import { useMemberChatStore } from '../store/memberChatStore';
import { useCommunityStore } from './communityStore';
import { MemberAvatar } from '../components/MemberAvatar';
import { FollowListModal } from './FollowListModal';
import { ProfileEditModal } from './ProfileEditModal';
import { ThemeShop } from './ThemeShop';
import {
  communityApi,
  resolveMediaUrl,
  type CommunityPost,
  type PinnedWork,
  type ProfileThemeDTO,
} from './communityApi';
import {
  resolveAppliedTheme,
  textureImage,
  textureSize,
  themeVars,
  type ProfileTheme,
} from './themes';
import { mdPreview } from './md';
import { gamificationApi, type MemberBadgeDTO } from './communityApi';
import { formatRelTime } from './time';
import { extractDominantColor } from './colorExtract';
import { PinnedEditorModal, PinnedHero, WorksWall } from './WorksWall';
import { useMemberSongs } from './works';

type ProfileTab = 'works' | 'posts' | 'archive' | 'bookmarks' | 'badges';

/** 无图卡片的程序化渐变封面（Notion/Linear 式 cover art） */
const CARD_ART: Array<[string, string]> = [
  ['#1f2f52', '#3b6fd4'],
  ['#2b1f52', '#7c5cd4'],
  ['#123f3a', '#1fa88a'],
  ['#52301f', '#d4893b'],
  ['#521f3d', '#d43b6f'],
  ['#1f3d52', '#3bc2d4'],
  ['#3d521f', '#a8c23b'],
  ['#3b2140', '#b052c7'],
];

/** DTO → 引擎主题（payload 缺省字段兜底） */
function toEngineTheme(dto: ProfileThemeDTO): ProfileTheme {
  return {
    slug: dto.slug,
    name: dto.name,
    layout: dto.layout,
    price_credits: dto.price_credits,
    owned: dto.owned,
    applied: dto.applied,
    payload: {
      bg: String(dto.payload.bg ?? '#242729'),
      surface: String(dto.payload.surface ?? '#2b2f33'),
      text: String(dto.payload.text ?? '#f0f2f4'),
      textMuted: String(dto.payload.textMuted ?? '#9aa3ab'),
      border: String(dto.payload.border ?? '#3a4046'),
      borderStyle: String(dto.payload.borderStyle ?? 'solid'),
      accent: String(dto.payload.accent ?? '#60a5fa'),
      accentText: String(dto.payload.accentText ?? '#0b1220'),
      bannerBg: String(dto.payload.bannerBg ?? '#1c2023'),
      bannerOverlay: Number(dto.payload.bannerOverlay ?? 0.35),
      fontDisplay: dto.payload.fontDisplay === 'sans' ? 'sans' : 'serif',
      radius: String(dto.payload.radius ?? 'base'),
      texture: String(dto.payload.texture ?? 'grain'),
      decoration: String(dto.payload.decoration ?? 'none'),
      monoData: dto.payload.monoData !== false,
    },
  };
}

/** 相对媒体 URL → 绝对（预览用） */
function useMediaSrc(url: string | null | undefined): string {
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (!url) {
      setSrc('');
      return;
    }
    let alive = true;
    void resolveMediaUrl(url)
      .then((s) => {
        if (alive) setSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);
  return src;
}

/**
 * ProfilePostCard — 动态 tab 博客卡流（bento 网格）。
 *
 * 同一个人的一片天：不放作者行/头像；有图用首图，无图生成程序化渐变封面；
 * 衬线标题 + 两行摘要 + 标签 chip + 数据行（赞/回复/浏览 + mono 日期）。
 */
const ProfilePostCard: React.FC<{
  post: CommunityPost;
  featured?: boolean;
  showPin?: boolean;
  onOpen: (p: CommunityPost) => void;
  onTag: (tag: string) => void;
}> = ({ post, featured = false, showPin, onOpen, onTag }) => {
  const { t } = useI18n('community');
  const preview = useMemo(() => mdPreview(post.content), [post.content]);
  const coverSrc = useMediaSrc(
    post.cover_url
      || post.media?.find((m) => m.type === 'image')?.thumb
      || preview.firstImage
      || null,
  );
  const excerpt = preview.body.slice(0, 120);
  const title = post.title ?? preview.title;
  const art = CARD_ART[post.id % CARD_ART.length];
  const artLetter = (title ?? preview.body).trim().charAt(0).toUpperCase();
  return (
    <article
      className={`community-blog-card${featured ? ' community-blog-card--featured' : ''}`}
      onClick={() => onOpen(post)}
    >
      {showPin && post.pinned_at && (
        <span className="community-blog-card__pin">
          <Pin size={11} aria-hidden />
          {t('pinned', { defaultValue: '置顶' })}
        </span>
      )}
      <span className="community-blog-card__media" aria-hidden>
        {coverSrc ? (
          <img src={coverSrc} alt="" loading="lazy" draggable={false} />
        ) : (
          <span
            className="community-blog-card__ph"
            style={{ backgroundImage: `linear-gradient(135deg, ${art[0]} 0%, ${art[1]} 100%)` }}
          >
            <span className="community-blog-card__ph-letter">{artLetter}</span>
          </span>
        )}
      </span>
      <div className="community-blog-card__body">
        {title && <h3 className="community-blog-card__title">{title}</h3>}
        {excerpt && (
          <p className="community-blog-card__excerpt">
            {excerpt}
            {excerpt.length >= 120 ? '…' : ''}
          </p>
        )}
        {post.tags && post.tags.length > 0 && (
          <div className="community-blog-card__tags">
            {post.tags.map((tg) => (
              <button
                key={tg}
                type="button"
                className="community-blog-card__tag"
                onClick={(e) => {
                  e.stopPropagation();
                  onTag(tg);
                }}
              >
                #{tg}
              </button>
            ))}
          </div>
        )}
        <footer className="community-blog-card__foot">
          <span className="community-blog-card__stats">
            <span
              className="community-blog-card__stat"
              title={t('like', { defaultValue: '点赞' })}
            >
              <Heart size={12} strokeWidth={1.8} aria-hidden />
              {post.like_count}
            </span>
            <span
              className="community-blog-card__stat"
              title={t('comment', { defaultValue: '评论' })}
            >
              <MessageCircle size={12} strokeWidth={1.8} aria-hidden />
              {post.comment_count}
            </span>
            <span
              className="community-blog-card__stat"
              title={t('views', { defaultValue: '{{n}} 次浏览', n: post.view_count ?? 0 })}
            >
              <Eye size={12} strokeWidth={1.8} aria-hidden />
              {post.view_count ?? 0}
            </span>
          </span>
          <time className="community-blog-card__time">{formatRelTime(post.created_at)}</time>
          <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden className="community-blog-card__go" />
        </footer>
      </div>
    </article>
  );
};

/** 组合身份章：按作品构成动态判定创作者人格（造物集三支柱之一） */
const IdentitySeals: React.FC<{ songCount: number; postCount: number }> = ({ songCount, postCount }) => {
  const { t } = useI18n('community');
  const seals: Array<{ key: string; label: string; icon: React.ReactNode }> = [];
  if (songCount > 0) seals.push({ key: 'musician', label: t('sealMusician', { defaultValue: '音乐人' }), icon: <Disc3 size={11} aria-hidden /> });
  if (postCount > 0) seals.push({ key: 'writer', label: t('sealWriter', { defaultValue: '写手' }), icon: <PenLine size={11} aria-hidden /> });
  if (seals.length === 0) {
    seals.push({ key: 'creator', label: t('sealCreator', { defaultValue: '创作者' }), icon: null });
  }
  return (
    <span className="community-profile2__seals">
      {seals.map((s) => (
        <span key={s.key} className="community-profile2__seal">
          {s.icon}
          {s.label}
        </span>
      ))}
    </span>
  );
};

export const ProfileView: React.FC = () => {
  const { t } = useI18n();
  const home = useCommunityStore((s) => s.home);
  const homePosts = useCommunityStore((s) => s.homePosts);
  const homeHasMore = useCommunityStore((s) => s.homeHasMore);
  const themesDTO = useCommunityStore((s) => s.themes);
  const archiveMonths = useCommunityStore((s) => s.archiveMonths);
  const bookmarks = useCommunityStore((s) => s.bookmarks);
  const bookmarksHasMore = useCommunityStore((s) => s.bookmarksHasMore);
  const back = useCommunityStore((s) => s.back);
  const loadHomePosts = useCommunityStore((s) => s.loadHomePosts);
  const loadBookmarks = useCommunityStore((s) => s.loadBookmarks);
  const loadMoreBookmarks = useCommunityStore((s) => s.loadMoreBookmarks);
  const setFeedTag = useCommunityStore((s) => s.setFeedTag);
  const openDetail = useCommunityStore((s) => s.openDetail);
  const openPostById = useCommunityStore((s) => s.openPostById);
  const toggleFollow = useCommunityStore((s) => s.toggleFollow);

  const myMemberId = useMemberChatStore((s) => s.session?.memberId ?? null);
  const createDm = useMemberChatStore((s) => s.createDm);
  const setRailTab = useMemberChatStore((s) => s.setRailTab);

  const [tab, setTab] = useState<ProfileTab>('works');
  const [archiveMonth, setArchiveMonth] = useState('');
  const [listEnd, setListEnd] = useState<HTMLDivElement | null>(null);
  const [followersOpen, setFollowersOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [shopOpen, setShopOpen] = useState(false);
  const [coverSrc, setCoverSrc] = useState('');
  /** 徽章墙（迁移 031；badges tab 拉取） */
  const [badges, setBadges] = useState<MemberBadgeDTO[] | null>(null);
  /** 造物集：代表作（home.pinned_works 解析）+ 编辑器开关 */
  const [pinned, setPinned] = useState<PinnedWork[]>([]);
  const [pinnedEditorOpen, setPinnedEditorOpen] = useState(false);
  /** 造物集：封面取色（沉浸 header 增强层，失败回退主题色） */
  const [stageGlow, setStageGlow] = useState<string | null>(null);

  const isSelf = home?.member_id === myMemberId;
  const displayName = home ? home.nickname || home.username : '';
  const applied: ProfileTheme = useMemo(
    () => resolveAppliedTheme((themesDTO ?? []).map(toEngineTheme)),
    [themesDTO],
  );

  const songs = useMemberSongs(home?.member_id ?? null);

  useEffect(() => {
    let alive = true;
    void (home?.cover
      ? resolveMediaUrl(home.cover)
      : Promise.resolve('')
    )
      .then((s) => {
        if (alive) setCoverSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [home?.cover]);

  // 造物集：代表作随 home payload 刷新
  useEffect(() => {
    setPinned(communityApi.parsePinnedWorks(home?.pinned_works));
  }, [home?.pinned_works]);

  // 造物集：封面取色（banner 优先，无 banner 取首张歌曲封面；失败回退主题色）
  useEffect(() => {
    let alive = true;
    const coverForColor = home?.cover || songs.songs.find((s) => s.cover_url)?.cover_url || null;
    void (coverForColor ? resolveMediaUrl(coverForColor).then((u) => extractDominantColor(u)) : Promise.resolve(null))
      .then((c) => {
        if (alive) setStageGlow(c);
      })
      .catch(() => {
        if (alive) setStageGlow(null);
      });
    return () => {
      alive = false;
    };
  }, [home?.cover, songs.songs]);

  useEffect(() => {
    if (tab === 'bookmarks' && isSelf) void loadBookmarks(true);
  }, [tab, isSelf, loadBookmarks]);

  useEffect(() => {
    if (tab !== 'badges' || home == null) return;
    let alive = true;
    setBadges(null);
    void gamificationApi
      .memberBadges(home.member_id)
      .then((r) => {
        if (alive) setBadges(r.badges);
      })
      .catch(() => {
        if (alive) setBadges([]);
      });
    return () => {
      alive = false;
    };
  }, [tab, home]);

  useEffect(() => {
    const el = listEnd;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          if (tab === 'posts') void loadHomePosts(false);
          if (tab === 'bookmarks') void loadMoreBookmarks();
        }
      },
      { rootMargin: '240px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [listEnd, tab, loadHomePosts, loadMoreBookmarks]);

  if (!home) {
    return (
      <div className="community-profile2" aria-busy>
        <Skeleton style={{ height: 220 }} />
        <Skeleton style={{ height: 44 }} />
      </div>
    );
  }

  const onFollow = async () => {
    const r = await toggleFollow(home.member_id);
    if (r?.became_friend) {
      toastSuccess(t('becameFriend', { defaultValue: '已互相关注，成为好友' }));
    }
  };

  const onMessage = async () => {
    await createDm(home.member_id, displayName);
    setRailTab('chats');
  };

  const onTag = (tag: string) => {
    setFeedTag(tag);
  };

  const onDiscuss = async (shareId: string) => {
    try {
      const { post_id } = await communityApi.postByShare(shareId);
      void openPostById(post_id);
    } catch {
      toastSuccess(t('songPostMissing', { defaultValue: '这首歌还没有社区讨论帖' }));
    }
  };

  /** 站外分享：公开主页落地页（H5 与 API 同源，/u/{username} 全 host 可达） */
  const onShare = async () => {
    try {
      const base = await tokenManager.getBaseUrl();
      const origin = new URL(base).origin;
      await navigator.clipboard.writeText(`${origin}/u/${home.username}`);
      toastSuccess(t('shareCopied', { defaultValue: '主页链接已复制，去站外分享吧' }));
    } catch {
      toastSuccess(t('shareFailed', { defaultValue: '复制失败，请稍后再试' }));
    }
  };

  const monthFiltered = archiveMonth
    ? homePosts.filter((p) => p.created_at.startsWith(archiveMonth))
    : homePosts;

  const counts = (
    <div className="community-profile2__stats">
      <span className="community-profile2__stat">
        <em className="ds-data">{home.post_count + (home.song_count ?? 0)}</em>
        <span className="ds-data">{t('statWorks', { defaultValue: '作品' })}</span>
      </span>
      <span className="community-profile2__stat">
        <em className="ds-data">{home.total_plays ?? 0}</em>
        <span className="ds-data">{t('statPlays', { defaultValue: '总播放' })}</span>
      </span>
      <button type="button" className="community-profile2__stat" onClick={() => setFollowersOpen(true)}>
        <em className="ds-data">{home.followers_count}</em>
        <span className="ds-data">{t('statFollowers', { defaultValue: '粉丝' })}</span>
      </button>
      <span className="community-profile2__stat">
        <em className="ds-data">{home.following_count}</em>
        <span className="ds-data">{t('statFollowing', { defaultValue: '关注' })}</span>
      </span>
    </div>
  );

  const metaRow = (
    <div className="community-profile2__meta">
      <span className="ds-data">@{home.username}</span>
      {home.location && (
        <span className="ds-data">
          <MapPin size={11} aria-hidden /> {home.location}
        </span>
      )}
      {home.website && (
        <a className="ds-data" href={home.website} target="_blank" rel="noreferrer">
          <Globe size={11} aria-hidden /> {home.website.replace(/^https?:\/\//, '')}
        </a>
      )}
    </div>
  );

  const actions = (
    <div className="community-profile2__actions">
      {isSelf ? (
        <>
          <Button variant="secondary" size="small" onClick={() => setEditOpen(true)}>
            <Settings2 size={14} aria-hidden />
            {t('editHome', { defaultValue: '编辑主页' })}
          </Button>
          <Button variant="secondary" size="small" onClick={() => void onShare()}>
            <Share2 size={14} aria-hidden />
            {t('share', { defaultValue: '分享' })}
          </Button>
        </>
      ) : (
        <>
          <Button
            variant={home.viewer_follows ? 'secondary' : 'primary'}
            size="small"
            onClick={() => void onFollow()}
          >
            {home.viewer_follows
              ? home.follows_viewer
                ? t('mutualFollow', { defaultValue: '互相关注' })
                : t('following', { defaultValue: '已关注' })
              : t('follow', { defaultValue: '关注' })}
          </Button>
          {home.is_friend && (
            <Button variant="secondary" size="small" onClick={() => void onMessage()}>
              <MessageCircle size={14} aria-hidden />
              {t('message', { defaultValue: '发消息' })}
            </Button>
          )}
          <Button variant="ghost" size="small" onClick={() => void onShare()}>
            <Share2 size={14} aria-hidden />
            {t('share', { defaultValue: '分享' })}
          </Button>
        </>
      )}
    </div>
  );

  const stageHeader = (
    <header className="community-profile2__stage">
      <div className="community-profile2__stage-glow" aria-hidden>
        <span
          className="community-profile2__stage-wash community-profile2__stage-wash--a"
          style={stageGlow ? { backgroundColor: stageGlow } : undefined}
        />
        <span
          className="community-profile2__stage-wash community-profile2__stage-wash--b"
          style={stageGlow ? { backgroundColor: stageGlow, opacity: 0.5 } : undefined}
        />
        {coverSrc && <img className="community-profile2__stage-cover" src={coverSrc} alt="" draggable={false} />}
        <span className="community-profile2__stage-veil" aria-hidden />
      </div>
      <div className="community-profile2__stage-body">
        <div className="community-profile2__stage-id">
          <MemberAvatar
            name={displayName}
            size="xl"
            data={home.avatar}
            animated
            className="community-profile2__avatar"
          />
          <div className="community-profile2__stage-name">
            <h1 className="community-profile2__name">{displayName}</h1>
            <IdentitySeals songCount={home.song_count ?? 0} postCount={home.post_count} />
            {typeof home.author_level === 'number' && home.author_level > 0 && (
              <span className="community-profile2__lv ds-data" title={t('levelTitle', { defaultValue: 'Lv.{{n}}', n: home.author_level })}>
                Lv.{home.author_level}
              </span>
            )}
          </div>
        </div>
        {home.bio && <p className="community-profile2__bio">{home.bio}</p>}
        {metaRow}
        {counts}
        {actions}
      </div>
    </header>
  );

  return (
    <div
      className={`community-profile2 community-profile2--stage${
        applied.payload.decoration !== 'none' ? ` community-profile2--deco-${applied.payload.decoration}` : ''
      }`}
      data-profile-root
      style={{
        ...themeVars(applied),
        backgroundImage: textureImage(applied.payload),
        backgroundSize: textureSize(applied.payload),
      }}
    >
      <header className="community-profile2__topbar">
        <IconButton
          variant="ghost"
          shape="square"
          tooltip={t('back', { defaultValue: '返回' })}
          aria-label={t('back', { defaultValue: '返回' })}
          onClick={back}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <span className="community-profile2__title ds-data">{applied.name}</span>
      </header>

      {stageHeader}

      <nav className="community-profile2__tabs" role="tablist">
        {(
          [
            ['works', t('tabWorks', { defaultValue: '作品' }), true],
            ['posts', t('tabPosts', { defaultValue: '动态' }), true],
            ['archive', t('tabArchive', { defaultValue: '归档' }), isSelf],
            ['bookmarks', t('tabBookmarks', { defaultValue: '收藏' }), isSelf],
            ['badges', t('tabBadges', { defaultValue: '徽章' }), true],
          ] as const
        )
          .filter(([, , visible]) => visible)
          .map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`community-profile2__tab ${tab === key ? 'is-active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
      </nav>

      {tab === 'works' && (
        <div className="community-profile2__works">
          <PinnedHero
            pinned={pinned}
            songs={songs.songs}
            posts={homePosts}
            isSelf={!!isSelf}
            onOpenPost={openDetail}
            onDiscuss={(sid) => void onDiscuss(sid)}
            onManage={() => setPinnedEditorOpen(true)}
          />
          <WorksWall
            songs={songs.songs}
            songsLoading={songs.loading}
            songsHasMore={songs.hasMore}
            onLoadMoreSongs={songs.loadMore}
            posts={homePosts}
            onOpenPost={openDetail}
            onDiscuss={(sid) => void onDiscuss(sid)}
          />
        </div>
      )}

      {tab === 'posts' && (
        <div className="community-profile2__list">
          {monthFiltered.map((p, i) => (
            <ProfilePostCard key={p.id} post={p} featured={i === 0} showPin onOpen={openDetail} onTag={onTag} />
          ))}
          {homeHasMore && (
            <div className="community-profile2__wide">
              <Button variant="ghost" size="small" onClick={() => void loadHomePosts(false)}>
                {t('loadMore', { defaultValue: '加载更多' })}
              </Button>
            </div>
          )}
          {monthFiltered.length === 0 && (
            <div className="community-profile2__wide">
              <Empty
                title={t('profileEmptyTitle', { defaultValue: '还没有动态' })}
                description={isSelf ? t('profileEmptyHint', { defaultValue: '去广场发布第一条动态吧' }) : undefined}
              />
            </div>
          )}
          <div ref={setListEnd} aria-hidden />
        </div>
      )}

      {tab === 'badges' && (
        <div className="community-profile2__badges">
          {(badges ?? []).map((b) => (
            <div key={b.slug} className={`community-badge community-badge--${b.tier}`} title={b.description}>
              <span className="community-badge__icon" aria-hidden>
                {b.icon || '🏅'}
              </span>
              <span className="community-badge__name">{b.name}</span>
              <span className="community-badge__desc ds-data">{b.description}</span>
            </div>
          ))}
          {badges != null && badges.length === 0 && (
            <Empty
              title={t('badgesEmpty', { defaultValue: '还没有徽章' })}
              description={t('badgesEmptyHint', { defaultValue: '发帖、评论、签到都能解锁徽章' })}
            />
          )}
          {badges == null && <Skeleton style={{ height: 80 }} />}
        </div>
      )}

      {tab === 'archive' && isSelf && (
        <div className="community-profile2__archive">
          {(archiveMonths ?? []).map(({ month, post_count }) => (
            <button
              key={month}
              type="button"
              className={`community-profile2__month ${archiveMonth === month ? 'is-active' : ''}`}
              onClick={() => {
                setArchiveMonth(archiveMonth === month ? '' : month);
                setTab('posts');
              }}
            >
              <span className="ds-data">{month}</span>
              <span className="ds-data">{post_count}</span>
            </button>
          ))}
          {(archiveMonths ?? []).length === 0 && <Empty title={t('archiveEmpty', { defaultValue: '暂无归档' })} />}
        </div>
      )}

      {tab === 'bookmarks' && isSelf && (
        <div className="community-profile2__list">
          {bookmarks.map((p) => (
            <ProfilePostCard key={`bm-${p.id}`} post={p} onOpen={openDetail} onTag={onTag} />
          ))}
          {bookmarksHasMore && <div ref={setListEnd} aria-hidden />}
          {bookmarks.length === 0 && (
            <div className="community-profile2__wide">
              <Empty title={t('bookmarksEmpty', { defaultValue: '还没有收藏' })} />
            </div>
          )}
        </div>
      )}

      {followersOpen && (
        <Modal
          isOpen={followersOpen}
          onClose={() => setFollowersOpen(false)}
          title={t('followersTitle', { defaultValue: '粉丝' })}
          size="small"
        >
          <FollowListModal
            memberId={home.member_id}
            mode="followers"
            onPick={() => setFollowersOpen(false)}
          />
        </Modal>
      )}

      {pinnedEditorOpen && (
        <PinnedEditorModal
          open={pinnedEditorOpen}
          memberId={home.member_id}
          songs={songs.songs}
          posts={homePosts}
          initial={pinned}
          onClose={() => setPinnedEditorOpen(false)}
          onSaved={(works) => setPinned(works)}
        />
      )}

      {editOpen && (
        <ProfileEditModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={undefined}
          onShop={() => {
            setEditOpen(false);
            setShopOpen(true);
          }}
        />
      )}

      <ThemeShop open={shopOpen} onClose={() => setShopOpen(false)} />
    </div>
  );
};
