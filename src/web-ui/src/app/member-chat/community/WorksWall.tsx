/**
 * WorksWall — 造物集渲染组件（渲染器注册表的组件侧）
 *
 * 渲染器注册表：歌曲卡/文字卡已点亮，卡带/图像预埋——新 AI 创作类型上线 =
 * 在 works.ts 注册 chips 元数据 + 在此注册渲染器 + 接一条数据源，主页永不重设计。
 * 数据模型/转换器/加载 hook 见 works.ts。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Empty, Modal, toastError, toastSuccess } from '@/component-library';
import { Check, Disc3, Play } from 'lucide-react';
import {
  communityApi,
  resolveMediaUrl,
  type CommunityPost,
  type MemberSongWork,
  type PinnedWork,
} from './communityApi';
import { playShare } from './communityPlayer';
import { mdPreview } from './md';
import { useShareCover } from '@/tools/acestep/hooks/useShareCover';
import { WORK_TYPE_META, postToWork, songToWork, type WorkItem } from './works';

// ---------------------------------------------------------------------------
// 歌曲墙卡（渲染器：方形封面 + 悬浮播放 + 播放数）
// ---------------------------------------------------------------------------

const SongWorkCard: React.FC<{ work: WorkItem; onDiscuss?: (shareId: string) => void }> = ({
  work,
  onDiscuss,
}) => {
  const { t } = useI18n('community');
  const song = work.raw as MemberSongWork;
  const cover = useShareCover(song.share_id, song.cover_url);

  const onPlay = async () => {
    if ((await playShare(song.share_id)) === 'unavailable') {
      toastError(t('playUnavailable', { defaultValue: '播放引擎未就绪，请打开音乐窗口后重试' }));
    }
  };

  return (
    <article className="community-work community-work--song">
      <button type="button" className="community-work__media" onClick={() => void onPlay()} aria-label={work.title}>
        {cover ? (
          <img src={cover} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="community-work__media-fallback" aria-hidden>
            <Disc3 size={28} strokeWidth={1.4} />
          </span>
        )}
        <span className="community-work__play" aria-hidden>
          <Play size={16} fill="currentColor" />
        </span>
        {(work.metrics.plays ?? 0) > 0 && (
          <span className="community-work__plays ds-data">{work.metrics.plays}</span>
        )}
      </button>
      <div className="community-work__body">
        <span className="community-work__title">{work.title}</span>
        {work.subtitle && <span className="community-work__sub ds-data">{work.subtitle}</span>}
        {onDiscuss && (
          <button type="button" className="community-work__discuss ds-data" onClick={() => onDiscuss(song.share_id)}>
            {t('goDiscuss', { defaultValue: '去讨论' })}
          </button>
        )}
      </div>
    </article>
  );
};

// ---------------------------------------------------------------------------
// 文字墙卡（渲染器：首图压顶 + 衬线标题 + 数据行）
// ---------------------------------------------------------------------------

const PostWorkCard: React.FC<{ work: WorkItem; onOpen: (p: CommunityPost) => void }> = ({
  work,
  onOpen,
}) => {
  const post = work.raw as CommunityPost;
  const [coverSrc, setCoverSrc] = useState('');
  useEffect(() => {
    let alive = true;
    void (work.cover ? resolveMediaUrl(work.cover) : Promise.resolve(''))
      .then((s) => {
        if (alive) setCoverSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [work.cover]);
  return (
    <article className="community-work community-work--post" onClick={() => onOpen(post)}>
      <span className="community-work__media" aria-hidden>
        {coverSrc ? (
          <img src={coverSrc} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="community-work__media-fallback community-work__media-fallback--text">
            {work.title?.charAt(0) || '文'}
          </span>
        )}
      </span>
      <div className="community-work__body">
        {work.title && <span className="community-work__title">{work.title}</span>}
        {work.subtitle && <span className="community-work__sub">{work.subtitle}</span>}
        <span className="community-work__stats ds-data">
          <em>♥ {work.metrics.likes ?? 0}</em>
          <em>💬 {work.metrics.comments ?? 0}</em>
        </span>
      </div>
    </article>
  );
};

// ---------------------------------------------------------------------------
// 作品墙（chips + 网格 + 加载更多）
// ---------------------------------------------------------------------------

export const WorksWall: React.FC<{
  songs: MemberSongWork[];
  songsLoading: boolean;
  songsHasMore: boolean;
  onLoadMoreSongs: () => void;
  posts: CommunityPost[];
  onOpenPost: (p: CommunityPost) => void;
  onDiscuss: (shareId: string) => void;
}> = ({ songs, songsLoading, songsHasMore, onLoadMoreSongs, posts, onOpenPost, onDiscuss }) => {
  const { t } = useI18n('community');
  const [chip, setChip] = useState<string>('all');

  const items = useMemo<WorkItem[]>(() => {
    const songWorks = songs.map(songToWork);
    const postWorks = posts.filter((p) => !p.repost_of).map(postToWork);
    if (chip === 'song') return songWorks;
    if (chip === 'post') return postWorks;
    // 全部：按创建时间混排（造物集 = 一条创作时间线）
    const all = [...songWorks, ...postWorks];
    const ts = (w: WorkItem) =>
      w.type === 'song' ? (w.raw as MemberSongWork).created_at : (w.raw as CommunityPost).created_at;
    return all.sort((a, b) => (ts(a) < ts(b) ? 1 : -1));
  }, [chip, songs, posts]);

  return (
    <div className="community-workswall">
      <div className="community-workswall__chips" role="tablist" aria-label={t('worksFilter', { defaultValue: '作品类型' })}>
        {WORK_TYPE_META.filter((m) => m.enabled || m.type === 'cartridge').map((m) => (
          <button
            key={m.type}
            type="button"
            role="tab"
            aria-selected={chip === m.type}
            disabled={!m.enabled}
            title={m.enabled ? undefined : t('workTypeComing', { defaultValue: '即将上线' })}
            className={`community-workswall__chip ${chip === m.type ? 'is-active' : ''} ${!m.enabled ? 'is-disabled' : ''}`}
            onClick={() => setChip(m.type)}
          >
            {m.icon}
            {m.label}
          </button>
        ))}
      </div>

      {items.length === 0 && !songsLoading ? (
        <Empty
          title={t('worksEmpty', { defaultValue: '还没有作品' })}
          description={t('worksEmptyHint', { defaultValue: '发布的歌曲与动态都会出现在这里' })}
        />
      ) : (
        <div className="community-workswall__grid">
          {items.map((w) =>
            w.type === 'song' ? (
              <SongWorkCard key={`s-${w.id}`} work={w} onDiscuss={onDiscuss} />
            ) : (
              <PostWorkCard key={`p-${w.id}`} work={w} onOpen={onOpenPost} />
            ),
          )}
        </div>
      )}

      {chip !== 'post' && songsHasMore && (
        <div className="community-workswall__more">
          <Button variant="ghost" size="small" disabled={songsLoading} onClick={onLoadMoreSongs}>
            {songsLoading ? t('loading', { defaultValue: '加载中…' }) : t('loadMore', { defaultValue: '加载更多' })}
          </Button>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 代表作（pinned ≤3 混排；未设置回退播放 top3 歌曲）
// ---------------------------------------------------------------------------

export const PinnedHero: React.FC<{
  pinned: PinnedWork[];
  songs: MemberSongWork[];
  posts: CommunityPost[];
  isSelf: boolean;
  onOpenPost: (p: CommunityPost) => void;
  onDiscuss: (shareId: string) => void;
  onManage?: () => void;
}> = ({ pinned, songs, posts, isSelf, onOpenPost, onDiscuss, onManage }) => {
  const { t } = useI18n('community');

  const items = useMemo<WorkItem[]>(() => {
    const resolve = (pw: PinnedWork): WorkItem | null => {
      if (pw.type === 'song') {
        const s = songs.find((x) => x.share_id === pw.id);
        return s ? songToWork(s) : null;
      }
      const p = posts.find((x) => String(x.id) === pw.id);
      return p ? postToWork(p) : null;
    };
    const resolved = pinned.map(resolve).filter((w): w is WorkItem => w != null);
    if (resolved.length > 0) return resolved.slice(0, 3);
    // 未设置：自动代表作 = 播放 top3 歌曲
    return [...songs]
      .sort((a, b) => b.play_count - a.play_count)
      .slice(0, 3)
      .map(songToWork);
  }, [pinned, songs, posts]);

  if (items.length === 0) return null;

  return (
    <section className="community-pinned" aria-label={t('pinnedWorks', { defaultValue: '代表作' })}>
      <header className="community-pinned__head">
        <h2 className="community-pinned__title">{t('pinnedWorks', { defaultValue: '代表作' })}</h2>
        <span className="community-pinned__seal" aria-hidden>
          ✦
        </span>
        {isSelf && onManage && (
          <button type="button" className="community-pinned__manage ds-data" onClick={onManage}>
            {t('pinnedManage', { defaultValue: '编辑代表作' })}
          </button>
        )}
      </header>
      <div className="community-pinned__row">
        {items.map((w) =>
          w.type === 'song' ? (
            <div key={`pin-s-${w.id}`} className="community-pinned__item">
              <SongWorkCard work={w} onDiscuss={onDiscuss} />
            </div>
          ) : (
            <div key={`pin-p-${w.id}`} className="community-pinned__item" onClick={() => onOpenPost(w.raw as CommunityPost)}>
              <PostWorkCard work={w} onOpen={onOpenPost} />
            </div>
          ),
        )}
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// 代表作编辑器（本人：从歌曲与动态中勾选，≤3）
// ---------------------------------------------------------------------------

export const PinnedEditorModal: React.FC<{
  open: boolean;
  memberId: number;
  songs: MemberSongWork[];
  posts: CommunityPost[];
  initial: PinnedWork[];
  onClose: () => void;
  onSaved: (works: PinnedWork[]) => void;
}> = ({ open, memberId, songs, posts, initial, onClose, onSaved }) => {
  const { t } = useI18n('community');
  const [selected, setSelected] = useState<PinnedWork[]>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setSelected(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const toggle = (pw: PinnedWork) => {
    setSelected((prev) => {
      const exists = prev.some((x) => x.type === pw.type && x.id === pw.id);
      if (exists) return prev.filter((x) => !(x.type === pw.type && x.id === pw.id));
      if (prev.length >= 3) {
        toastError(t('pinnedMax', { defaultValue: '最多置顶 3 个代表作' }));
        return prev;
      }
      return [...prev, pw];
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await communityApi.updatePinnedWorks(memberId, selected);
      toastSuccess(t('pinnedSaved', { defaultValue: '代表作已更新' }));
      onSaved(selected);
      onClose();
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const isChecked = (pw: PinnedWork) => selected.some((x) => x.type === pw.type && x.id === pw.id);

  return (
    <Modal isOpen={open} onClose={onClose} title={t('pinnedManage', { defaultValue: '编辑代表作' })} size="medium">
      <div className="community-pinned-editor">
        {songs.length > 0 && (
          <>
            <h3 className="community-pinned-editor__section">{t('pinnedPickSongs', { defaultValue: '歌曲' })}</h3>
            <div className="community-pinned-editor__list">
              {songs.map((s) => (
                <button
                  key={s.share_id}
                  type="button"
                  className={`community-pinned-editor__row ${isChecked({ type: 'song', id: s.share_id }) ? 'is-active' : ''}`}
                  onClick={() => toggle({ type: 'song', id: s.share_id })}
                >
                  <span className="community-pinned-editor__check" aria-hidden>
                    <Check size={13} />
                  </span>
                  <span className="community-pinned-editor__name">{s.title}</span>
                  <span className="ds-data">▶ {s.play_count}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {posts.length > 0 && (
          <>
            <h3 className="community-pinned-editor__section">{t('pinnedPickPosts', { defaultValue: '动态' })}</h3>
            <div className="community-pinned-editor__list">
              {posts.slice(0, 20).map((p) => {
                const preview = mdPreview(p.content);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`community-pinned-editor__row ${isChecked({ type: 'post', id: String(p.id) }) ? 'is-active' : ''}`}
                    onClick={() => toggle({ type: 'post', id: String(p.id) })}
                  >
                    <span className="community-pinned-editor__check" aria-hidden>
                      <Check size={13} />
                    </span>
                    <span className="community-pinned-editor__name">
                      {p.title ?? preview.title ?? preview.body.slice(0, 24)}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        <footer className="community-pinned-editor__foot">
          <span className="ds-data">{t('pinnedCount', { defaultValue: '已选 {{n}}/3', n: selected.length })}</span>
          <Button size="small" onClick={() => void save()} disabled={saving}>
            {t('save', { defaultValue: '保存' })}
          </Button>
        </footer>
      </div>
    </Modal>
  );
};
