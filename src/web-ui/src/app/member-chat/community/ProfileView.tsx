/**
 * ProfileView — 个人主页（P2B 博客化重写 + P2A 主题引擎）
 *
 * 主题：服务端 profile_themes（迁移 027）为 SSOT，store.themes 缓存；
 *       ThemeResolver 把 payload 挂为容器级 --pt-* 变量，主页样式只消费这些变量。
 * 布局三骨架：hero（banner+头像压边）/ minimal（纯排版）/ editorial（杂志规则线）。
 * 页签：动态（网格卡流）/ 归档（按月，仅自己）/ 收藏（仅自己）。
 * 流卡片：bento 响应式网格，首卡 featured 头版横幅；卡片 = 首图压顶 +
 * 衬线标题 + 两行摘要 + mono 日期 + 标签，无作者行（同人流），点击进详情。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Empty, IconButton, Modal, Skeleton, toastSuccess } from '@/component-library';
import { ArrowLeft, ArrowUpRight, Eye, Globe, Heart, MapPin, MessageCircle, Pin, Settings2 } from 'lucide-react';
import { useMemberChatStore } from '../store/memberChatStore';
import { useCommunityStore } from './communityStore';
import { MemberAvatar } from '../components/MemberAvatar';
import { FollowListModal } from './FollowListModal';
import { ProfileEditModal } from './ProfileEditModal';
import { ThemeShop } from './ThemeShop';
import {
  resolveMediaUrl,
  type CommunityPost,
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
import { formatRelTime } from './time';

type ProfileTab = 'posts' | 'archive' | 'bookmarks';

/**
 * 无图卡片的程序化渐变封面（Notion/Linear 式 cover art）：
 * 深浅双色 duotone，按帖子 id 稳定取色，避免外链图床依赖。
 */
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
 * ProfilePostCard — 主页流卡片（bento 网格用）。
 *
 * 同一个人的一片天：不放作者行/头像；有图用首图，无图生成程序化渐变封面；
 * 衬线标题 + 两行摘要 + 标签 chip + 数据行（赞/回复/浏览 + mono 日期）。
 * hover 卡片上浮、标题与箭头染主题 accent。featured 首卡横幅排版。
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
  const toggleFollow = useCommunityStore((s) => s.toggleFollow);

  const myMemberId = useMemberChatStore((s) => s.session?.memberId ?? null);
  const createDm = useMemberChatStore((s) => s.createDm);
  const setRailTab = useMemberChatStore((s) => s.setRailTab);

  const [tab, setTab] = useState<ProfileTab>('posts');
  const [archiveMonth, setArchiveMonth] = useState('');
  const [listEnd, setListEnd] = useState<HTMLDivElement | null>(null);
  const [followersOpen, setFollowersOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [shopOpen, setShopOpen] = useState(false);
  const [coverSrc, setCoverSrc] = useState('');

  const isSelf = home?.member_id === myMemberId;
  const displayName = home ? home.nickname || home.username : '';
  const applied: ProfileTheme = useMemo(
    () => resolveAppliedTheme((themesDTO ?? []).map(toEngineTheme)),
    [themesDTO],
  );

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

  useEffect(() => {
    if (tab === 'bookmarks' && isSelf) void loadBookmarks(true);
  }, [tab, isSelf, loadBookmarks]);

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
        <Skeleton style={{ height: 160 }} />
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

  const monthFiltered = archiveMonth
    ? homePosts.filter((p) => p.created_at.startsWith(archiveMonth))
    : homePosts;

  const counts = (
    <div className="community-profile2__counts">
      <span className="ds-data">{t('postsCount', { defaultValue: '动态 {{n}}', n: home.post_count })}</span>
      <button type="button" className="ds-data" onClick={() => setFollowersOpen(true)}>
        {t('followersCount', { defaultValue: '粉丝 {{n}}', n: home.followers_count })}
      </button>
      <span className="ds-data">{t('followingCount', { defaultValue: '关注 {{n}}', n: home.following_count })}</span>
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
        <Button variant="secondary" size="small" onClick={() => setEditOpen(true)}>
          <Settings2 size={14} aria-hidden />
          {t('editHome', { defaultValue: '编辑主页' })}
        </Button>
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
        </>
      )}
    </div>
  );

  let header: React.ReactNode;
  if (applied.layout === 'hero') {
    header = (
      <header className="community-profile2__hero">
        <div className="community-profile2__banner">
          {coverSrc && <img src={coverSrc} alt="" draggable={false} />}
          <span
            className="community-profile2__banner-overlay"
            style={{ opacity: applied.payload.bannerOverlay }}
          />
        </div>
        <div className="community-profile2__hero-body">
          <MemberAvatar
            name={displayName}
            size="xl"
            data={home.avatar}
            animated
            className="community-profile2__avatar"
          />
          <h1 className="community-profile2__name">{displayName}</h1>
          {metaRow}
          {home.bio && <p className="community-profile2__bio">{home.bio}</p>}
          {counts}
          {actions}
        </div>
      </header>
    );
  } else if (applied.layout === 'minimal') {
    header = (
      <header className="community-profile2__minimal">
        <div className="community-profile2__minimal-top">
          <MemberAvatar
            name={displayName}
            size="lg"
            data={home.avatar}
            animated
            className="community-profile2__avatar-sm"
          />
          <h1 className="community-profile2__name">{displayName}</h1>
          {actions}
        </div>
        {home.bio && <p className="community-profile2__bio">{home.bio}</p>}
        {metaRow}
        <div className="community-profile2__rule" />
        {counts}
      </header>
    );
  } else {
    header = (
      <header className="community-profile2__editorial">
        <div className="community-profile2__kicker ds-data">PROFILE / 個人</div>
        <h1 className="community-profile2__name community-profile2__name--display">{displayName}</h1>
        <div className="community-profile2__byline">
          {home.bio ? `${displayName} — ${home.bio}` : displayName}
        </div>
        <div className="community-profile2__meta-row">
          {metaRow}
          {counts}
          {actions}
        </div>
      </header>
    );
  }

  return (
    <div
      className={`community-profile2 community-profile2--${applied.layout}${
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

      {header}

      <nav className="community-profile2__tabs" role="tablist">
        {(
          [
            ['posts', t('tabPosts', { defaultValue: '动态' }), true],
            ['archive', t('tabArchive', { defaultValue: '归档' }), isSelf],
            ['bookmarks', t('tabBookmarks', { defaultValue: '收藏' }), isSelf],
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
