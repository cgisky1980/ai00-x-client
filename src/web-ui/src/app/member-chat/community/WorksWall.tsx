/**
 * PinnedHero / PinnedEditorModal — 代表作（≤3）与它的编辑器
 *
 * 主页的「一条流」在 ProfileStream.tsx：动态与作品混排、同款卡。
 * 这里只管**代表作**（手动置顶 ≤3，未设置时回退播放 top3 歌曲），
 * 卡片渲染器复用 StreamCard —— 全站只有一种卡。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Modal, toastError, toastSuccess } from '@/component-library';
import { Check } from 'lucide-react';
import {
  communityApi,
  type CommunityPost,
  type MemberSongWork,
  type PinnedWork,
} from './communityApi';
import { mdPreview } from './md';
import { postToWork, songToWork, type WorkItem } from './works';
import { StreamCard } from './ProfileStream';

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
        {items.map((w) => (
          <StreamCard
            key={`pin-${w.type}-${w.id}`}
            work={w}
            onOpenPost={onOpenPost}
            onDiscuss={onDiscuss}
          />
        ))}
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
