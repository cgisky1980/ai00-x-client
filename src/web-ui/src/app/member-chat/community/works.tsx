/**
 * works — 造物集数据模型与注册表（纯逻辑，与渲染组件分离）
 *
 * 「造物」统一模型 WorkItem + 类型注册表：新 AI 创作类型上线 =
 * ① WORK_TYPE_META 注册一个 chips 元数据 + ② WorksWall.tsx 注册一个渲染器 +
 * ③ 一条数据源接进 ProfileView 的装配处。主页永不重设计。
 */
import React from 'react';
import { Disc3, FileText, Gamepad2 } from 'lucide-react';
import { communityApi, type CommunityPost, type MemberSongWork } from './communityApi';
import { mdPreview } from './md';

/** 造物统一模型 */
export interface WorkItem {
  type: 'song' | 'post';
  /** song = shareId；post = 帖子数字 id 的字符串 */
  id: string;
  title: string;
  subtitle?: string;
  cover?: string | null;
  metrics: {
    plays?: number;
    likes?: number;
    comments?: number;
    views?: number;
  };
  /** 渲染器私有载荷（song = MemberSongWork；post = CommunityPost） */
  raw: MemberSongWork | CommunityPost;
}

/** 类型注册表元数据（chips；未上线类型置灰预埋） */
export interface WorkRendererMeta {
  type: string;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
}

export const WORK_TYPE_META: WorkRendererMeta[] = [
  { type: 'all', label: '全部', icon: null, enabled: true },
  { type: 'song', label: '歌曲', icon: <Disc3 size={12} aria-hidden />, enabled: true },
  { type: 'post', label: '文字', icon: <FileText size={12} aria-hidden />, enabled: true },
  { type: 'cartridge', label: '卡带', icon: <Gamepad2 size={12} aria-hidden />, enabled: false },
];

/**
 * mosaic 候选作品挑选（banner=mosaic 轴专用）
 *
 * 首屏拼贴要的是"最有代表性的一眼"，所以只取带封面的：
 * 优先播放量高的歌曲 → 其余按时间。宁缺毋滥——没有封面的作品
 * 拼进拼贴只会留下空格子，不如留白。
 */
export function mosaicPicks(
  songs: MemberSongWork[],
  posts: CommunityPost[],
  limit = 4,
): WorkItem[] {
  const songWorks = songs.filter((s) => s.cover_url).map(songToWork);
  const postWorks = posts
    .filter((p) => !p.repost_of && (p.cover_url || p.media?.some((m) => m.type === 'image')))
    .map(postToWork);
  // 歌曲在前：社区的门面是"作品即门面"，且歌曲封面天然是方图，适合拼贴
  const byPlays = [...songWorks].sort((a, b) => {
    const pa = (a.raw as MemberSongWork).play_count ?? 0;
    const pb = (b.raw as MemberSongWork).play_count ?? 0;
    return pb - pa;
  });
  return [...byPlays, ...postWorks].slice(0, limit);
}

/** 秒 → mm:ss */
export function fmtDuration(sec?: number): string {
  if (!sec || sec <= 0) return '';
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 服务端歌曲出参 → 造物（cover 相对路径由卡片内部 useShareCover 解析） */
export function songToWork(s: MemberSongWork): WorkItem {
  return {
    type: 'song',
    id: s.share_id,
    title: s.title,
    subtitle: [s.artist_name, fmtDuration(s.duration_seconds)].filter(Boolean).join(' · '),
    cover: s.cover_url ?? null,
    metrics: { plays: s.play_count },
    raw: s,
  };
}

export function postToWork(p: CommunityPost): WorkItem {
  const preview = mdPreview(p.content);
  return {
    type: 'post',
    id: String(p.id),
    title: p.title ?? preview.title ?? '',
    subtitle: preview.body.slice(0, 80),
    cover:
      p.cover_url ?? p.media?.find((m) => m.type === 'image')?.thumb ?? preview.firstImage ?? null,
    metrics: { likes: p.like_count, comments: p.comment_count, views: p.view_count ?? 0 },
    raw: p,
  };
}

/** 某会员的歌曲作品加载（page 分页；ProfileView 装配数据源用） */
export function useMemberSongs(memberId: number | null): {
  songs: MemberSongWork[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
} {
  const [songs, setSongs] = React.useState<MemberSongWork[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const fetchPage = React.useCallback(
    async (target: number, replace: boolean) => {
      if (memberId == null || loading) return;
      setLoading(true);
      try {
        const items = await communityApi.memberSongs(memberId, target);
        setSongs((prev) => (replace ? items : [...prev, ...items]));
        setHasMore(items.length >= 24);
        setPage(target);
      } catch {
        if (replace) setSongs([]);
      } finally {
        setLoading(false);
      }
    },
    [memberId, loading],
  );

  React.useEffect(() => {
    setSongs([]);
    setPage(1);
    setHasMore(false);
    if (memberId != null) void fetchPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  return {
    songs,
    loading,
    hasMore,
    loadMore: () => void fetchPage(page + 1, false),
    reload: () => void fetchPage(1, true),
  };
}
