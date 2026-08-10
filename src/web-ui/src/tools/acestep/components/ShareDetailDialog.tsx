/**
 * ShareDetailDialog — 分享详情对话框。
 *
 * 显示单个分享的完整元数据（标题/艺术家/专辑/流派/时长/预览时长/创建时间/
 * 播放数等），并提供"播放"主操作按钮。
 *
 * 打开时调用 `shareService.getStats(shareId)` 异步获取播放数 + 评论数
 * （后端 `comment_count` 当前为 null）。统计获取失败时静默回退到列表
 * 项中的 `playCount`，不阻塞对话框显示。
 *
 * **封面**：通过 `useShareCover` hook 加载本地缓存封面图。后端 `/cover`
 * 端点返回二进制，Tauri 命令 `share_get_cover` 下载到
 * `{songs_dir}/.cache/{share_id}/cover.bin` 后用 `convertFileSrc` 展示。
 * 无封面或加载中时显示 Music 图标占位符。
 *
 * 播放按钮触发 `onPlay(shareId)`，调用方应调用 `usePlayerStore.playShare`
 * 并关闭对话框。播放中状态由 `isPlaying` 标识（按钮变为 "Pause"，
 * 但实际暂停操作仍由 player bar 完成，这里只反映状态）。
 */

import React, { useEffect, useState } from 'react';
import { Play, Pause, Music, Clock, Headphones, Calendar, Disc, Tag, User, FileAudio, AlertCircle } from 'lucide-react';
import { Modal, Button } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import { shareService, type SharedSongListItem, type ShareStats } from '../services/ShareService';
import { formatTimeDisplay } from '../utils/lrcParser';
import { useShareCover } from '../hooks/useShareCover';
import { CommentSection } from './CommentSection';
import './ShareDetailDialog.scss';

/** 格式化 Unix 时间戳为 `YYYY-MM-DD HH:mm`。 */
function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export interface ShareDetailDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 分享列表项数据（来自广场） */
  item: SharedSongListItem | null;
  /** 当前是否正在播放此分享 */
  isPlaying: boolean;
  /** 是否正在下载/解密此分享（按钮显示 spinner） */
  isLoading: boolean;
  /** 点击播放按钮的回调 */
  onPlay: (shareId: string) => void;
  /** 关闭对话框的回调 */
  onClose: () => void;
}

export const ShareDetailDialog: React.FC<ShareDetailDialogProps> = ({
  open: isOpen,
  item,
  isPlaying,
  isLoading,
  onPlay,
  onClose,
}) => {
  const { t } = useI18n('acestep');
  const [stats, setStats] = useState<ShareStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  // 加载封面图（coverUrl = 服务端相对封面路径）
  const coverUrl = useShareCover(
    item?.shareId ?? '',
    item?.coverUrl,
  );

  // 每次打开对话框或切换 item 时重新获取统计
  useEffect(() => {
    if (!isOpen || !item) {
      setStats(null);
      setStatsError(null);
      return;
    }
    let cancelled = false;
    setStatsLoading(true);
    setStatsError(null);
    shareService
      .getStats(item.shareId)
      .then((s) => {
        if (!cancelled) {
          setStats(s);
          setStatsLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setStatsError(e instanceof Error ? e.message : String(e));
          setStatsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, item]);

  if (!item) return null;

  const createdAtMs = Date.parse(item.createdAt) || 0;
  // 优先使用 stats.playCount（最新），否则回退到 item.playCount（可能过期）。
  // 用 Number.isFinite 兜底，避免 API 返回 null/undefined/字符串时渲染为 "NaN"。
  const rawPlayCount = stats?.playCount ?? item.playCount;
  const playCount = Number.isFinite(rawPlayCount) ? rawPlayCount : 0;
  const rawCommentCount = stats?.commentCount;
  const commentCount = Number.isFinite(rawCommentCount) ? rawCommentCount : null;

  const handlePlayClick = () => {
    onPlay(item.shareId);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('share.detail.title', { defaultValue: 'Share Details' })}
      size="medium"
      closeOnOverlayClick={!isLoading}
    >
      <div className="share-detail-dialog__body">
        {/* Cover — 通过 useShareCover 加载本地缓存封面图 */}
        <div className="share-detail-dialog__cover">
          {coverUrl ? (
            <img
              className="share-detail-dialog__cover-img"
              src={coverUrl}
              alt={item.title}
            />
          ) : (
            <div className="share-detail-dialog__cover-placeholder" aria-hidden>
              <Music size={48} />
            </div>
          )}
        </div>

        {/* Title + artist (large) */}
        <div className="share-detail-dialog__header">
          <div className="share-detail-dialog__header-title" title={item.title}>
            {item.title}
          </div>
          <div className="share-detail-dialog__header-artist" title={item.authorName}>
            <User size={12} />
            {item.authorName || t('player.unknownArtist', { defaultValue: 'Unknown artist' })}
          </div>
        </div>

        {/* Stats banner */}
        <div className="share-detail-dialog__stats">
          <div className="share-detail-dialog__stat">
            <Headphones size={14} />
            <span className="share-detail-dialog__stat-label">
              {t('share.detail.playCount', { defaultValue: 'Plays' })}
            </span>
            <span className="share-detail-dialog__stat-value">
              {statsLoading ? '…' : playCount}
            </span>
          </div>
          <div className="share-detail-dialog__stat">
            <FileAudio size={14} />
            <span className="share-detail-dialog__stat-label">
              {t('share.detail.comments', { defaultValue: 'Comments' })}
            </span>
            <span className="share-detail-dialog__stat-value">
              {statsLoading ? '…' : commentCount ?? '—'}
            </span>
          </div>
        </div>
        {statsError && (
          <div className="share-detail-dialog__stats-error" role="note">
            <AlertCircle size={12} />
            <span>{statsError}</span>
          </div>
        )}

        {/* Metadata grid */}
        <dl className="share-detail-dialog__meta">
          {item.artistName && (
            <div className="share-detail-dialog__meta-row">
              <dt>
                <User size={11} />
                {t('share.detail.artist', { defaultValue: 'Artist' })}
              </dt>
              <dd title={item.artistName}>{item.artistName}</dd>
            </div>
          )}
          {item.album && (
            <div className="share-detail-dialog__meta-row">
              <dt>
                <Disc size={11} />
                {t('share.detail.album', { defaultValue: 'Album' })}
              </dt>
              <dd title={item.album}>{item.album}</dd>
            </div>
          )}
          {item.genre && (
            <div className="share-detail-dialog__meta-row">
              <dt>
                <Tag size={11} />
                {t('share.detail.genre', { defaultValue: 'Genre' })}
              </dt>
              <dd>{item.genre}</dd>
            </div>
          )}
          {item.durationSeconds > 0 && (
            <div className="share-detail-dialog__meta-row">
              <dt>
                <Clock size={11} />
                {t('share.detail.duration', { defaultValue: 'Duration' })}
              </dt>
              <dd>{formatTimeDisplay(item.durationSeconds)}</dd>
            </div>
          )}
          {item.previewDurationSecs > 0 && (
            <div className="share-detail-dialog__meta-row">
              <dt>
                <Clock size={11} />
                {t('share.detail.previewDuration', { defaultValue: 'Preview' })}
              </dt>
              <dd>
                {t('share.detail.previewDurationValue', {
                  seconds: item.previewDurationSecs,
                  defaultValue: '{{seconds}}s',
                })}
              </dd>
            </div>
          )}
          {createdAtMs > 0 && (
            <div className="share-detail-dialog__meta-row">
              <dt>
                <Calendar size={11} />
                {t('share.detail.created', { defaultValue: 'Created' })}
              </dt>
              <dd>{formatDateTime(createdAtMs)}</dd>
            </div>
          )}
        </dl>

        {/* Share ID (mono, small, for debug / reference) */}
        <div className="share-detail-dialog__share-id" title={item.shareId}>
          <span className="share-detail-dialog__share-id-label">ID:</span>
          <code>{item.shareId}</code>
        </div>

        {/* 评论区（Phase E.3）—— 加载评论列表 + 当前 member_id，
            自动管理添加/编辑/删除/回复操作 */}
        <CommentSection shareId={item.shareId} />

        {/* Actions */}
        <div className="share-detail-dialog__actions">
          <Button variant="ghost" onClick={onClose} disabled={isLoading}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            onClick={handlePlayClick}
            disabled={isLoading}
          >
            {isLoading ? (
              <span className="share-detail-dialog__btn-spinner" />
            ) : isPlaying ? (
              <Pause size={14} />
            ) : (
              <Play size={14} />
            )}
            {isLoading
              ? t('share.detail.loading', { defaultValue: 'Loading...' })
              : isPlaying
                ? t('player.pause', { defaultValue: 'Pause' })
                : t('share.detail.playShare', { defaultValue: 'Play Share' })}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default ShareDetailDialog;