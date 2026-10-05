/**
 * ProfileView — 创作者主页「造物集」（批次 1 重塑）
 *
 * 定位：AI 创作者的门面——作品即门面，色彩来自作品。三支柱：
 * 1. 海报巨卡：头像砖 + 大名 + 签名 + Lv，数据条并排（皮肤只改描边/配色/装饰）。
 * 2. 影响力数据条：作品/总播放/粉丝/关注，mono tabular。
 * 3. 主页流（默认）：代表作置顶 ≤3 + **动态与作品混排的一条流**（同一种卡，见 ProfileStream）。
 *
 * 主题引擎（P2A）继续生效：--pt-* 变量仍驱动配色/字体/纹理/圆角，取色层在其上做增强。
 * 页签：主页 / 徽章 /（本人）归档 /（本人）收藏。
 *
 * 结构恒定，皮肤二选一（minimal 中华极简 / comic 漫画风，见 themes.ts）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { tokenManager } from '@/infrastructure/auth/TokenManager';
import { Button, Empty, IconButton, Modal, Skeleton, toastSuccess } from '@/component-library';
import {
  ArrowLeft,
  Globe,
  MapPin,
  MessageCircle,
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
  type PinnedWork,
  type ProfileThemeDTO,
} from './communityApi';
import {
  FALLBACK_STYLE,
  styleAttrs,
  resolveAppliedTheme,
  themeVars,
  type ProfileTheme,
} from './themes';
import { sealStyle } from './memberSeal';
import { gamificationApi, type MemberBadgeDTO } from './communityApi';
import { extractDominantColor } from './colorExtract';
import { FingerprintSection } from './FingerprintSection';
import { PinnedHero, PinnedEditorModal } from './WorksWall';
import { ProfileStream } from './ProfileStream';
import { useMemberSongs } from './works';

/** 主页页签。作品与动态合并进 `feed`（混排在同一条流、同一种卡里）。 */
type ProfileTab = 'feed' | 'badges' | 'archive' | 'bookmarks';

/** DTO → 引擎主题（payload 缺省字段兜底） */
function toEngineTheme(dto: ProfileThemeDTO): ProfileTheme {
  return {
    slug: dto.slug,
    name: dto.name,
    layout: dto.layout,
    price_credits: dto.price_credits,
    owned: dto.owned,
    applied: dto.applied,
    // 皮肤来自 payload.style（迁移 035）；迁移前的 payload 回落 minimal
    style:
      typeof (dto.payload as Record<string, unknown>)?.style === 'string'
        ? ((dto.payload as Record<string, unknown>).style as string)
        : FALLBACK_STYLE,
  };
}

// 刻意**没有**"音乐人/写手/创作者"这类身份标签。
// 社区是开放的创作场：一个人今天写歌、明天画图、后天做游戏，
// 按已发布内容反推身份既不准确也是一种归类。所以头部只呈现本人写下的
// 资料（名字/bio/位置/外链），作品区用统一卡片并列呈现，不替人下定义。

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
  const openDetail = useCommunityStore((s) => s.openDetail);
  const openPostById = useCommunityStore((s) => s.openPostById);
  const toggleFollow = useCommunityStore((s) => s.toggleFollow);

  const myMemberId = useMemberChatStore((s) => s.session?.memberId ?? null);
  const createDm = useMemberChatStore((s) => s.createDm);
  const setRailTab = useMemberChatStore((s) => s.setRailTab);

  const [tab, setTab] = useState<ProfileTab>('feed');
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
  const songs = useMemberSongs(home?.member_id ?? null);

  const applied: ProfileTheme = useMemo(
    () => resolveAppliedTheme((themesDTO ?? []).map(toEngineTheme)),
    [themesDTO],
  );

  /** 封面图取到后给海报叠一层作品主色晕染（--pt-glow）；
      皮肤配色本身全在 CSS 的 [data-style] 块里，这里不参与配色决策。 */

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
          if (tab === 'feed') void loadHomePosts(false);
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

  /**
   * 海报巨卡 —— 主页的门面。
   *
   * 结构恒定（两套皮肤共用）：左「头像砖 + 名字 + 签名」，右「大数字数据条」。
   * 皮肤只改这张卡的描边语言/底色/装饰（见 community.scss 的 [data-style]）。
   */
  const poster = (
    <header className="community-profile2__poster">
      <div className="community-profile2__poster-glow" aria-hidden>
        <span
          className="community-profile2__poster-wash community-profile2__poster-wash--a"
          style={stageGlow ? { backgroundColor: stageGlow } : undefined}
        />
        <span
          className="community-profile2__poster-wash community-profile2__poster-wash--b"
          style={stageGlow ? { backgroundColor: stageGlow, opacity: 0.5 } : undefined}
        />
        {coverSrc && <img className="community-profile2__poster-cover" src={coverSrc} alt="" draggable={false} />}
        <span className="community-profile2__poster-veil" aria-hidden />
      </div>
      <div className="community-profile2__poster-body">
        <div className="community-profile2__poster-idrow">
          <span className="community-profile2__avatar-tile">
            <MemberAvatar
              name={displayName}
              size="xl"
              data={home.avatar}
              animated
              className="community-profile2__avatar"
            />
          </span>
          <div className="community-profile2__poster-idtext">
            <div className="community-profile2__poster-name">
              <h1 className="community-profile2__name">{displayName}</h1>
              {typeof home.author_level === 'number' && home.author_level > 0 && (
                <span
                  className="community-profile2__lv ds-data"
                  title={t('levelTitle', { defaultValue: 'Lv.{{n}}', n: home.author_level })}
                >
                  Lv.{home.author_level}
                </span>
              )}
            </div>
            {/* 刻意没有"音乐人/写手/创作者"身份标签：社区是开放的创作场，
                按已发布内容反推身份既不准确也是一种归类。
                头部只呈现本人写下的资料，下面用同一种卡并列呈现所有内容。 */}
            {home.bio && <p className="community-profile2__bio">{home.bio}</p>}
            {metaRow}
          </div>
        </div>
        {counts}
        {actions}
      </div>
      {/* 成员纹章：确定性 SVG，作页脚落款（固定墨阶 + 一点朱砂，不随主题变） */}
      <span
        className="community-profile2__seal-mark"
        style={sealStyle(`${home.username}#${home.member_id}`, 'var(--pt-text)', 'var(--color-brand-seal)', 26)}
        role="presentation"
      />
    </header>
  );

  return (
    <div
      className="community-profile2"
      data-profile-root
      {...styleAttrs(applied.style)}
      // 颜色与纹理全在 CSS 的 [data-style] 块里，这里只挂作品取色的晕染变量
      style={themeVars(stageGlow ? { '--pt-glow': stageGlow } : undefined)}
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
        {/* 顶栏标题是**页面身份**，不是皮肤名。
            之前这里渲染 applied.name（"宣纸"），又套 ds-data 的等宽字，
            读起来像一行调试输出 —— 而且海报里已经用大字写了本人名字，
            顶栏再报一次皮肤名既重复又答非所问。皮肤名归商店管。 */}
        <span className="community-profile2__title">{t('profileTitle', { defaultValue: '个人主页' })}</span>
      </header>

      {poster}

      {/* 页签只留「主页 / 徽章 /（本人）归档 /（本人）收藏」。
          作品与动态**不再分栏**——它们混排在主页同一条流里（同一种卡），
          分成两个 tab 只会让人以为这是两类不同的东西。 */}
      <nav className="community-profile2__tabs" role="tablist">
        {(
          [
            ['feed', t('tabFeed', { defaultValue: '主页' }), true],
            ['badges', t('tabBadges', { defaultValue: '徽章' }), true],
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

      {tab === 'feed' && (
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
          <ProfileStream
            songs={songs.songs}
            songsLoading={songs.loading}
            songsHasMore={songs.hasMore}
            onLoadMoreSongs={songs.loadMore}
            posts={monthFiltered}
            emptyHint={
              archiveMonth
                ? t('archiveEmpty', { defaultValue: '该月暂无内容' })
                : isSelf
                  ? t('profileEmptyHint', { defaultValue: '去广场发布第一条动态吧' })
                  : undefined
            }
            onOpenPost={openDetail}
            onDiscuss={(sid) => void onDiscuss(sid)}
          />
          {homeHasMore && (
            <div className="community-profile2__wide">
              <Button variant="ghost" size="small" onClick={() => void loadHomePosts(false)}>
                {t('loadMore', { defaultValue: '加载更多动态' })}
              </Button>
            </div>
          )}
          <FingerprintSection memberId={home.member_id} />
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
                setTab('feed');
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
          <ProfileStream
            songs={[]}
            songsLoading={false}
            songsHasMore={false}
            onLoadMoreSongs={() => {}}
            posts={bookmarks}
            emptyHint={t('bookmarksEmpty', { defaultValue: '还没有收藏' })}
            onOpenPost={openDetail}
            onDiscuss={(sid) => void onDiscuss(sid)}
          />
          {bookmarksHasMore && <div ref={setListEnd} aria-hidden />}
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
