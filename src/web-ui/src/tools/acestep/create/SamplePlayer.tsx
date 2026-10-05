/**
 * SamplePlayer — 样例自定义播放器（替换原生 <audio controls>）。
 *
 * 收起态：播放/暂停圆钮 + 细进度条（可点跳转）+ mm:ss 时间（mono）。
 * 播放态：position:absolute 覆盖整个样例卡（父卡 __sample 为定位锚），
 * 展示卡拉OK歌词——sample.lrc 为逐字增强 LRC（alignLyrics 产物），
 * 当前行 accent 高亮 + 逐字扫色；无 lrc 时用 fallbackLyrics 按时长均分
 * 近似同步；纯音乐/均无 → 仅控件与进度。
 *
 * 互斥：onActivate 通知父级换 activeSampleId；active=false 时自动暂停。
 * 动画帧驱动 currentTime（timeupdate ~4Hz 对逐字扫色太卡）。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, X } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import {
  parseEnhancedLrc,
  findCurrentLineIndex,
  findCurrentWordIndex,
  formatTimeDisplay,
  type ParsedLrc,
} from '../utils/lrcParser';
import './SamplePlayer.scss';

interface SamplePlayerProps {
  /** Absolute local wav path (Tauri asset protocol). */
  filePath: string;
  /** Sample duration reported by the backend (pre-metadata fallback). */
  durationSeconds: number;
  /** Enhanced LRC from alignLyrics (word-level timestamps); optional. */
  lrc?: string;
  /** Plain lyric lines; used to fake even-sync karaoke when no lrc. */
  fallbackLyrics?: string;
  /** False when another sample is playing → pause this instance. */
  active: boolean;
  /** Notify the parent that this sample starts playing. */
  onActivate: () => void;
}

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

const SamplePlayer: React.FC<SamplePlayerProps> = ({
  filePath,
  durationSeconds,
  lrc,
  fallbackLyrics,
  active,
  onActivate,
}) => {
  const { t } = useI18n('acestep');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lyricsRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationSeconds);
  const [loadFailed, setLoadFailed] = useState(false);

  const src = useMemo(() => convertFileSrc(filePath), [filePath]);
  const inTauri = isTauriEnv();

  // 卡拉OK数据：lrc 逐字解析优先；无 lrc 用纯文本行按时长均分（近似同步）。
  const parsed: ParsedLrc | null = useMemo(() => {
    if (lrc?.trim()) return parseEnhancedLrc(lrc);
    const lines = (fallbackLyrics ?? '').split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0 || duration <= 0) return null;
    const usable = Math.max(duration - 2, 1);
    return {
      lines: lines.map((text, i) => ({
        time: 1 + (usable * i) / lines.length,
        words: [],
        rawText: text,
      })),
    };
  }, [lrc, fallbackLyrics, duration]);

  const activeLineIdx = parsed ? findCurrentLineIndex(parsed.lines, currentTime) : -1;
  const activeLine = activeLineIdx >= 0 ? parsed!.lines[activeLineIdx] : null;
  const activeWordIdx = activeLine ? findCurrentWordIndex(activeLine.words, currentTime) : -1;

  // rAF 驱动逐字扫色（暂停时停帧；timeupdate 兜底已够暂停态刷新）
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) setCurrentTime(a.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // 其他样例开始播放 → 本实例暂停
  useEffect(() => {
    if (!active && audioRef.current && !audioRef.current.paused) audioRef.current.pause();
  }, [active]);

  // 当前行自动滚动居中
  useEffect(() => {
    if (!expanded || activeLineIdx < 0) return;
    lyricsRef.current
      ?.querySelector(`[data-line-idx="${activeLineIdx}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [expanded, activeLineIdx]);

  if (!inTauri) {
    return (
      <div className="acestep-audio__notice">
        {t('stepBuilder.audioLoadFailed')} (browser dev — file: {filePath})
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div className="acestep-audio__notice acestep-audio__notice--error">
        {t('stepBuilder.audioLoadFailed')}
      </div>
    );
  }

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      onActivate();
      setExpanded(true);
      void a.play();
    } else {
      a.pause();
    }
  };

  const collapse = () => {
    audioRef.current?.pause();
    setExpanded(false);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const d = a.duration || duration;
    if (d > 0) {
      a.currentTime = ratio * d;
      setCurrentTime(a.currentTime);
    }
  };

  const dur = audioRef.current?.duration || duration;
  const pct = dur > 0 ? Math.min(100, (currentTime / dur) * 100) : 0;

  return (
    <div className="acestep-sample-player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onError={() => setLoadFailed(true)}
      />

      {/* 收起态：紧凑单行条 */}
      <div className="acestep-sample-player__bar">
        <button
          type="button"
          className="acestep-sample-player__toggle"
          title={playing ? t('create.playerPause') : t('create.playerPlay')}
          onClick={toggle}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <div className="acestep-sample-player__track" onClick={seek}>
          <div className="acestep-sample-player__fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="acestep-sample-player__time">
          {formatTimeDisplay(currentTime)} / {formatTimeDisplay(dur)}
        </span>
      </div>

      {/* 播放态：覆盖整个样例卡（定位锚 = 父卡 __sample） */}
      {expanded && (
        <div className="acestep-sample-player__overlay">
          {parsed ? (
            <div ref={lyricsRef} className="acestep-sample-player__lyrics">
              {parsed.lines.map((line, i) => (
                <p
                  key={`${line.time}-${i}`}
                  data-line-idx={i}
                  className={`acestep-sample-player__line${
                    i === activeLineIdx ? ' is-active' : i < activeLineIdx ? ' is-sung' : ''
                  }`}
                >
                  {i === activeLineIdx && line.words.length > 0
                    ? line.words.map((w, wi) => (
                        <span key={wi} className={wi <= activeWordIdx ? 'is-sung' : undefined}>
                          {w.text}
                        </span>
                      ))
                    : line.rawText}
                </p>
              ))}
            </div>
          ) : (
            <p className="acestep-sample-player__nolyrics">{t('create.playerNoLyrics')}</p>
          )}
          <div className="acestep-sample-player__controls">
            <button
              type="button"
              className="acestep-sample-player__toggle acestep-sample-player__toggle--lg"
              title={playing ? t('create.playerPause') : t('create.playerPlay')}
              onClick={toggle}
            >
              {playing ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <div className="acestep-sample-player__track" onClick={seek}>
              <div className="acestep-sample-player__fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="acestep-sample-player__time">
              {formatTimeDisplay(currentTime)} / {formatTimeDisplay(dur)}
            </span>
            <button
              type="button"
              className="acestep-sample-player__collapse"
              title={t('create.playerCollapse')}
              onClick={collapse}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SamplePlayer;
