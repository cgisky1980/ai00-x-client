/**
 * AudioSourcePicker — 通用「音频来源选择器」弹层。
 *
 * 四种来源统一返回一个本地绝对路径（AudioSource）：
 * - 上传文件（本机任意常见音频格式，后端自动归一化）
 * - 录音哼唱（Rust cpal 采集，录完可试听/重录）
 * - 收藏（在线收藏 + 社区喜欢，逐条解析本地文件）
 * - 我的作品（.a00m 解包取音频）
 *
 * 快捷创作的「参考音色」与改歌工作台的「源音频」共用本组件。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Mic, Heart, Library, Loader2, Square, RefreshCw, Play, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { Modal, Button, toastError } from '@/component-library';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useFavoritesStore } from '@/tools/music-source/favoritesStore';
import { songKey } from '@/tools/music-source/types';
import { useProfileStore } from '../store/profileStore';
import { shareService } from '../services/ShareService';
import { aceStepService } from '../services/AceStepService';
import type { SongEntry } from '../types';
import {
  displayNameOfPath,
  probeAudioDuration,
  resolveSource,
  type AudioSource,
  type AudioSourceOrigin,
  type PendingSource,
} from './resolveSourceAudio';
import './AudioSourcePicker.scss';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (source: AudioSource) => void;
  /** 标题（缺省用 i18n 默认标题）。 */
  title?: string;
}

type TabId = AudioSourceOrigin;

const TABS: Array<{ id: TabId; icon: React.ReactNode; labelKey: string }> = [
  { id: 'upload', icon: <Upload size={13} />, labelKey: 'create.picker.tabUpload' },
  { id: 'record', icon: <Mic size={13} />, labelKey: 'create.picker.tabRecord' },
  { id: 'favorite', icon: <Heart size={13} />, labelKey: 'create.picker.tabFavorite' },
  { id: 'library', icon: <Library size={13} />, labelKey: 'create.picker.tabLibrary' },
];

interface PickerRow {
  key: string;
  name: string;
  durationSeconds: number;
  pending: PendingSource;
}

const AudioSourcePicker: React.FC<Props> = ({ open, onClose, onPick, title }) => {
  const { t } = useI18n('acestep');
  const favorites = useFavoritesStore((s) => s.favorites);
  const likedIds = useProfileStore((s) => s.profile.likedIds);

  const [tab, setTab] = useState<TabId>('upload');
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [failedKeys, setFailedKeys] = useState<Record<string, string>>({});

  // ---- record tab state ----
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordResult, setRecordResult] = useState<{ path: string; durationSeconds: number } | null>(
    null,
  );
  const recordTimerRef = useRef<number | null>(null);
  const recordingRef = useRef(false);

  // ---- favorite tab state ----
  const [favRows, setFavRows] = useState<PickerRow[]>([]);
  const [shareMetasLoading, setShareMetasLoading] = useState(false);

  // ---- library tab state ----
  const [libRows, setLibRows] = useState<PickerRow[]>([]);
  const [libLoading, setLibLoading] = useState(false);

  /** 关闭时若还在录音，停止并丢弃（释放麦克风）。 */
  const stopRecordingDiscard = useCallback(async (): Promise<void> => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    try {
      await invoke('acestep_stop_recording');
    } catch {
      // already auto-stopped or never started
    }
    setRecording(false);
    setRecordSeconds(0);
  }, []);

  useEffect(
    () => () => {
      void stopRecordingDiscard();
    },
    [stopRecordingDiscard],
  );

  useEffect(() => {
    if (!open) {
      void stopRecordingDiscard();
      setTab('upload');
      setResolvingKey(null);
      setFailedKeys({});
      setRecordResult(null);
    }
  }, [open, stopRecordingDiscard]);

  /** 收藏页数据：在线收藏 + 社区喜欢（拉 meta 供展示名/时长，失败容忍）。 */
  useEffect(() => {
    if (!open || tab !== 'favorite') return;
    const rows: PickerRow[] = favorites.map((song) => ({
      key: `fav:${songKey(song)}`,
      name: song.singers ? `${song.singers} - ${song.name}` : song.name,
      durationSeconds: 0,
      pending: {
        key: `fav:${songKey(song)}`,
        name: song.name,
        origin: 'favorite',
        song,
      },
    }));
    setFavRows(rows);
    let cancelled = false;
    if (likedIds.length > 0) {
      setShareMetasLoading(true);
      Promise.all(
        likedIds.map(async (id): Promise<PickerRow> => {
          try {
            const meta = await shareService.getMeta(id);
            return {
              key: `share:${id}`,
              name: meta.artistName ? `${meta.artistName} - ${meta.title}` : meta.title,
              durationSeconds: meta.durationSeconds,
              pending: {
                key: `share:${id}`,
                name: meta.title,
                origin: 'favorite',
                durationSeconds: meta.durationSeconds,
                shareId: id,
              },
            };
          } catch {
            return {
              key: `share:${id}`,
              name: t('create.picker.shareFallback', { id: id.slice(0, 8) }),
              durationSeconds: 0,
              pending: {
                key: `share:${id}`,
                name: id,
                origin: 'favorite',
                shareId: id,
              },
            };
          }
        }),
      )
        .then((shareRows) => {
          if (!cancelled) setFavRows((prev) => [...prev, ...shareRows]);
        })
        .finally(() => {
          if (!cancelled) setShareMetasLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, tab, favorites, likedIds, t]);

  /** 作品页数据：曲库列表。 */
  useEffect(() => {
    if (!open || tab !== 'library') return;
    let cancelled = false;
    setLibLoading(true);
    aceStepService
      .listSongs()
      .then((entries: SongEntry[]) => {
        if (cancelled) return;
        setLibRows(
          entries.map((entry) => ({
            key: `lib:${entry.path}`,
            name: entry.meta?.title || entry.filename.replace(/\.a00m$/i, ''),
            durationSeconds: entry.meta?.durationSeconds ?? 0,
            pending: {
              key: `lib:${entry.path}`,
              name: entry.meta?.title || entry.filename,
              origin: 'library',
              durationSeconds: entry.meta?.durationSeconds ?? 0,
              entry,
            } satisfies PendingSource,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setLibRows([]);
      })
      .finally(() => {
        if (!cancelled) setLibLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab]);

  /** 统一解析 → 补时长 → 回调。 */
  const pick = async (pending: PendingSource, name?: string): Promise<void> => {
    if (resolvingKey) return;
    setResolvingKey(pending.key);
    try {
      const source = await resolveSource(pending);
      let duration = source.durationSeconds;
      if (!duration && pending.origin !== 'record') {
        duration = await probeAudioDuration(source.path);
      }
      onPick({
        path: source.path,
        name: name ?? pending.name,
        origin: pending.origin,
        durationSeconds: Math.round(duration * 10) / 10,
      });
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      setFailedKeys((prev) => ({ ...prev, [pending.key]: code }));
      toastError(t('create.picker.resolveFailed'));
    } finally {
      setResolvingKey(null);
    }
  };

  const handleUpload = async (): Promise<void> => {
    const { open: openFileDialog } = await import('@tauri-apps/plugin-dialog');
    const picked = await openFileDialog({
      multiple: false,
      title: t('create.picker.uploadTitle'),
      filters: [
        {
          name: t('create.picker.audioFilterName'),
          extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'webm'],
        },
      ],
    });
    if (typeof picked !== 'string') return;
    await pick(
      {
        key: `upload:${picked}`,
        name: displayNameOfPath(picked),
        origin: 'upload',
        localPath: picked,
      },
      displayNameOfPath(picked),
    );
  };

  const handleStartRecord = async (): Promise<void> => {
    if (recordingRef.current) return;
    try {
      await invoke('acestep_start_recording', { maxDurationSec: 120 });
      recordingRef.current = true;
      setRecordResult(null);
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleStopRecord = useCallback(async (): Promise<void> => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    try {
      const result = await invoke<{ path: string; durationSeconds: number }>(
        'acestep_stop_recording',
      );
      setRecording(false);
      setRecordResult(result);
    } catch (e) {
      setRecording(false);
      setRecordSeconds(0);
      toastError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const confirmRecord = async (): Promise<void> => {
    if (!recordResult) return;
    onPick({
      path: recordResult.path,
      name: `${t('create.picker.humPrefix')} ${formatClock(recordResult.durationSeconds)}`,
      origin: 'record',
      durationSeconds: recordResult.durationSeconds,
    });
  };

  // 录音满 120s 自动停（与后端看门狗双保险）
  useEffect(() => {
    if (recording && recordSeconds >= 120) void handleStopRecord();
  }, [recording, recordSeconds, handleStopRecord]);

  const rows: PickerRow[] = tab === 'favorite' ? favRows : libRows;

  return (
    <Modal
      isOpen={open}
      onClose={() => {
        void stopRecordingDiscard();
        onClose();
      }}
      title={title ?? t('create.picker.title')}
      size="medium"
    >
      <div className="ai00-x-audio-picker">
        <div className="ai00-x-audio-picker__tabs" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={`ai00-x-audio-picker__tab${tab === entry.id ? ' is-active' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.icon}
              {t(entry.labelKey)}
            </button>
          ))}
        </div>

        <div className="ai00-x-audio-picker__body">
          {tab === 'upload' && (
            <div className="ai00-x-audio-picker__upload">
              <p className="ai00-x-audio-picker__hint">{t('create.picker.uploadHint')}</p>
              <Button onClick={() => void handleUpload()}>
                <Upload size={14} />
                {t('create.picker.uploadButton')}
              </Button>
            </div>
          )}

          {tab === 'record' && (
            <div className="ai00-x-audio-picker__record">
              <p className="ai00-x-audio-picker__hint">{t('create.picker.recordHint')}</p>
              {!recordResult && (
                <div className="ai00-x-audio-picker__record-main">
                  <button
                    type="button"
                    className={`ai00-x-audio-picker__record-btn${recording ? ' is-recording' : ''}`}
                    onClick={() => void (recording ? handleStopRecord() : handleStartRecord())}
                  >
                    {recording ? <Square size={20} /> : <Mic size={22} />}
                  </button>
                  <span className="ai00-x-audio-picker__record-time">
                    {recording && <span className="ai00-x-audio-picker__record-pulse" />}
                    {formatClock(recordSeconds)}
                  </span>
                  <span className="ai00-x-audio-picker__record-state">
                    {recording
                      ? t('create.picker.recordingStop')
                      : t('create.picker.recordStart')}
                  </span>
                </div>
              )}
              {recordResult && (
                <div className="ai00-x-audio-picker__record-done">
                  <audio
                    className="ai00-x-audio-picker__preview"
                    controls
                    src={convertFileSrc(recordResult.path)}
                  />
                  <div className="ai00-x-audio-picker__record-actions">
                    <Button size="small" onClick={() => void confirmRecord()}>
                      {t('create.picker.useRecording')}
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() => {
                        setRecordResult(null);
                        setRecordSeconds(0);
                      }}
                    >
                      <RefreshCw size={12} />
                      {t('create.picker.rerecord')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {(tab === 'favorite' || tab === 'library') && (
            <div className="ai00-x-audio-picker__list">
              {tab === 'favorite' && shareMetasLoading && (
                <div className="ai00-x-audio-picker__list-loading">
                  <Loader2 size={14} className="ai00-x-create__spin" />
                  {t('create.picker.loadingFavorites')}
                </div>
              )}
              {tab === 'library' && libLoading && (
                <div className="ai00-x-audio-picker__list-loading">
                  <Loader2 size={14} className="ai00-x-create__spin" />
                  {t('create.picker.loadingLibrary')}
                </div>
              )}
              {!libLoading && !shareMetasLoading && rows.length === 0 && (
                <p className="ai00-x-audio-picker__empty">
                  {tab === 'favorite'
                    ? t('create.picker.favoritesEmpty')
                    : t('create.picker.libraryEmpty')}
                </p>
              )}
              {rows.map((row) => {
                const failed = failedKeys[row.key];
                const busy = resolvingKey === row.key;
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={`ai00-x-audio-picker__item${failed ? ' is-failed' : ''}`}
                    disabled={Boolean(failed) || resolvingKey !== null}
                    onClick={() => void pick(row.pending, row.name)}
                  >
                    <span className="ai00-x-audio-picker__item-icon">
                      {busy ? (
                        <Loader2 size={14} className="ai00-x-create__spin" />
                      ) : failed ? (
                        <AlertTriangle size={14} />
                      ) : tab === 'favorite' ? (
                        <Heart size={14} />
                      ) : (
                        <Play size={14} />
                      )}
                    </span>
                    <span className="ai00-x-audio-picker__item-name">{row.name}</span>
                    <span className="ai00-x-audio-picker__item-meta">
                      {failed
                        ? t('create.picker.needsRefresh')
                        : row.durationSeconds > 0
                          ? formatClock(row.durationSeconds)
                          : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default AudioSourcePicker;
