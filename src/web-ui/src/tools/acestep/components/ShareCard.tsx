/**
 * ShareCard — 分享广场中的单张卡片。
 *
 * 复用 LibraryView archive-card 的视觉模式（封面占位 + 标题 + 艺术家 +
 * 元信息 + 播放按钮），但数据来源是 `SharedSongListItem`（来自 Ai00-Salvo
 * 服务器）而非本地 `SongEntry`。
 *
 * 点击卡片任意位置触发 `onOpenDetail`；点击播放按钮触发 `onPlayShare`
 * （调用方应调用 `usePlayerStore.playShare`）。播放中状态由调用方传入
 * `isPlaying` 标识（高亮边框 + 显示暂停图标）。
 *
 * **封面**：通过 `useShareCover` hook 加载本地缓存的封面图 URL。
 * 后端 `/cover` 端点返回二进制，Tauri 命令 `share_get_cover` 下载到
 * `{songs_dir}/.cache/{share_id}/cover.bin` 后用 `convertFileSrc` 展示。
 * 无封面或加载中时显示 Music 图标占位符。
 */

import React from 'react';
import { Play, Pause, Music, Clock, Headphones, Calendar } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { formatTimeDisplay } from '../utils/lrcParser';
import { useShareCover } from '../hooks/useShareCover';
import type { SharedSongListItem } from '../services/ShareService';
import './ShareCard.scss';

/** 格式化 Unix 时间戳为 `YYYY-MM-DD`。 */
function formatDate(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export interface ShareCardProps {
  /** 分享元数据 */
  item: SharedSongListItem;
  /** 当前是否正在播放此分享（用于高亮 + 显示暂停图标） */
  isPlaying: boolean;
  /** 是否正在下载/解密此分享（用于显示 spinner） */
  isLoading: boolean;
  /** 点击播放按钮的回调 */
  onPlay: (shareId: string) => void;
  /** 点击卡片其他区域的回调（打开详情对话框） */
  onOpenDetail: (shareId: string) => void;
}

export const ShareCard: React.FC<ShareCardProps> = ({
  item,
  isPlaying,
  isLoading,
  onPlay,
  onOpenDetail,
}) => {
  const { t } = useI18n('acestep');
  const createdAtMs = Date.parse(item.createdAt) || 0;
  // 加载封面图（coverUrl = 服务端相对封面路径）
  const coverUrl = useShareCover(item.shareId, item.coverUrl);

  const handlePlayClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onPlay(item.shareId);
  };

  const handleCardClick = () => {
    onOpenDetail(item.shareId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter / Space 触发详情，但不阻止播放按钮自身的键盘事件
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenDetail(item.shareId);
    }
  };

  return (
    <div
      className={`ai00-x-share-card${isPlaying ? ' is-playing' : ''}`}
      onClick={handleCardClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={t('share.gallery.openDetail', { defaultValue: 'Open share details' })}
    >
      <div className="ai00-x-share-card__cover">
        {coverUrl ? (
          <img
            className="ai00-x-share-card__cover-img"
            src={coverUrl}
            alt={item.title}
            loading="lazy"
          />
        ) : (
          <div className="ai00-x-share-card__cover-placeholder" aria-hidden>
            <Music size={22} />
          </div>
        )}
        <button
          type="button"
          className="ai00-x-share-card__play"
          onClick={handlePlayClick}
          disabled={isLoading}
          aria-label={
            isPlaying
              ? t('player.pause', { defaultValue: 'Pause' })
              : t('player.play', { defaultValue: 'Play' })
          }
          title={
            isPlaying
              ? t('player.pause', { defaultValue: 'Pause' })
              : t('player.play', { defaultValue: 'Play' })
          }
        >
          {isLoading ? (
            <span className="ai00-x-share-card__spinner" />
          ) : isPlaying ? (
            <Pause size={18} />
          ) : (
            <Play size={18} />
          )}
        </button>
      </div>

      <div className="ai00-x-share-card__info">
        <div className="ai00-x-share-card__title" title={item.title}>
          {item.title}
        </div>
        <div className="ai00-x-share-card__artist" title={item.artistName ?? ''}>
          {item.artistName || t('player.unknownArtist', { defaultValue: 'Unknown artist' })}
        </div>
        <div className="ai00-x-share-card__meta">
          {item.durationSeconds > 0 && (
            <span className="ai00-x-share-card__duration" title={t('share.gallery.duration', { defaultValue: 'Duration' })}>
              <Clock size={10} />
              {formatTimeDisplay(item.durationSeconds)}
            </span>
          )}
          {item.playCount > 0 && (
            <span className="ai00-x-share-card__plays" title={t('share.gallery.playCount', { defaultValue: 'Plays' })}>
              <Headphones size={10} />
              {item.playCount}
            </span>
          )}
          {createdAtMs > 0 && (
            <span className="ai00-x-share-card__date" title={t('share.gallery.created', { defaultValue: 'Created' })}>
              <Calendar size={10} />
              {formatDate(createdAtMs)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default ShareCard;
