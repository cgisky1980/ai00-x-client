/**
 * SongCard — 社区歌曲卡（迁移 030：发行即发帖的引用卡）
 *
 * 渲染 media 中的 song 引用项：封面（share cover 端点，useShareCover LRU 缓存）
 * + 歌名/歌手/时长 + 播放按钮。播放 = emit `acestep://player-command`
 * {action:'playShare', payload:{shareId}}，由常驻 overlay 的 PlayerEngine 消费
 * （乐窗/灵动岛同链路）；事件不可达（引擎未挂）时提示走音乐窗口。
 * 行卡变体（variant="row"）供「新歌」tab 使用，可带播放数与讨论入口。
 */
import React from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Play, MessageCircle } from 'lucide-react';
import { toastError } from '@/component-library';
import { useShareCover } from '@/tools/acestep/hooks/useShareCover';
import type { CommunityMediaItem } from './communityApi';
import { playShare } from './communityPlayer';

/** 秒 → mm:ss */
function fmtDuration(sec?: number): string {
  if (!sec || sec <= 0) return '';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const SongCard: React.FC<{
  item: CommunityMediaItem;
  /** 行卡变体（新歌 tab）：更大的可点区域 + 可选附加操作 */
  variant?: 'card' | 'row';
  /** 附加渲染（行卡：播放数/「去讨论」等） */
  extra?: React.ReactNode;
  /** 点击卡片主体（行卡：去讨论）；未提供时主体点击=播放 */
  onOpen?: () => void;
}> = ({ item, variant = 'card', extra, onOpen }) => {
  const { t } = useI18n('community');
  const shareId = item.share_id ?? '';
  const cover = useShareCover(shareId, item.url);

  const onPlay = async () => {
    if (!shareId) return;
    if ((await playShare(shareId)) === 'unavailable') {
      toastError(t('playUnavailable', { defaultValue: '播放引擎未就绪，请打开音乐窗口后重试' }));
    }
  };

  const openPost = () => {
    if (onOpen) onOpen();
    else void onPlay();
  };

  return (
    <div className={`community-song community-song--${variant}`}>
      <button
        type="button"
        className="community-song__body"
        onClick={openPost}
        aria-label={item.title ?? ''}
      >
        <span className="community-song__cover">
          {cover ? (
            <img src={cover} alt="" loading="lazy" draggable={false} />
          ) : (
            <span className="community-song__cover-fallback" aria-hidden>
              ♪
            </span>
          )}
          <span className="community-song__play" aria-hidden>
            <Play size={14} fill="currentColor" />
          </span>
        </span>
        <span className="community-song__meta">
          <span className="community-song__title">{item.title || t('songUntitled', { defaultValue: '未命名歌曲' })}</span>
          <span className="community-song__sub ds-data">
            {item.artist || t('songUnknownArtist', { defaultValue: '未知歌手' })}
            {item.duration ? ` · ${fmtDuration(item.duration)}` : ''}
          </span>
        </span>
      </button>
      <span className="community-song__actions">
        {extra}
        <button
          type="button"
          className="community-post__action"
          onClick={() => void onPlay()}
          aria-label={t('songPlay', { defaultValue: '播放' })}
        >
          <Play size={14} strokeWidth={1.8} />
        </button>
        {variant === 'card' && (
          <span className="community-song__discuss ds-data" aria-hidden>
            <MessageCircle size={12} />
          </span>
        )}
      </span>
    </div>
  );
};
