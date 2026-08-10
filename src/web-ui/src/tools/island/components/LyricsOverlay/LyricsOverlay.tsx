/**
 * LyricsOverlay — 主窗口独立透明歌词浮层（桌面歌词风格），可放大为迷你播放器。
 *
 * 通过 Tauri Event `acestep://lyrics-state` / `acestep://player-state` 从
 * AceStep 窗口接收歌词/播放器状态，自己解析 LRC 并根据 currentTime（减去
 * 用户可调的歌词同步补偿）二分查找当前行/词。
 *
 * 两种模式：
 * - lyrics（默认）：透明无边框，3 行歌词逐词 karaoke；hover 显示半透明
 *   背景框 + 工具条（播放控制 / 同步微调 / 放大为播放器 / 关闭）
 * - player：竖版方形迷你播放器（封面 / 滚动歌词 / 进度条 / 完整控制栏），
 *   头部可收起回歌词模式
 *
 * - 可拖拽改变位置；ESC 关闭（发 command 回 AceStep）
 * - 3s 未收到状态心跳时自动隐藏
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  X,
  Plus,
  Minus,
  Maximize2,
  Minimize2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Heart,
  MessageCircle,
  Music,
  Volume2,
  VolumeX,
  ListOrdered,
  Repeat,
  Repeat1,
  Shuffle,
} from 'lucide-react';
import {
  parseEnhancedLrc,
  findCurrentLineIndex,
  findCurrentWordIndex,
} from '../../../acestep/utils/lrcParser';
import { useBgmPlayerStore } from '../../store/bgmPlayer';
import './LyricsOverlay.scss';

// ---- Event schema (mirrored from PlayerBridge.ts) ----
interface AceStepLyricsState {
  lrcText: string | null;
  currentTime: number;
  title: string | null;
  showLyrics: boolean;
}

// ---- Player state schema (mirrored from PlayerBridge.ts) ----
interface AceStepPlayerState {
  currentSong: {
    title: string;
    artist: string;
    durationSeconds: number;
  } | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  playMode: 'sequential' | 'repeat-one' | 'repeat-all' | 'shuffle';
  playlistLength: number;
  playlistIndex: number;
  p2pStatus: 'connecting' | 'downloading' | 'seeding' | 'error' | null;
  p2pPeerCount: number;
  source: 'local' | 'share';
  showLyrics: boolean;
  coverPath: string | null;
}

const EVENT_LYRICS_STATE = 'acestep://lyrics-state';
const EVENT_PLAYER_STATE = 'acestep://player-state';
const EVENT_PLAYER_COMMAND = 'acestep://player-command';

/** Heartbeat timeout — hide overlay if no state received for this long. */
const STALE_TIMEOUT_MS = 3000;

/**
 * Default lyric sync offset (seconds).
 *
 * `currentTime` from the backend is the decoder position; the audible
 * position lags behind by the total output buffer latency (ring buffer
 * ~1.5s + cpal buffer ~1.0s). This default compensates for that lag so
 * lyrics align out-of-the-box; users can fine-tune via +/- buttons.
 */
const DEFAULT_LYRICS_OFFSET_S = 2.5;
/** Per-click adjustment step (seconds). */
const OFFSET_STEP_S = 0.1;
/** localStorage key for persisting the user's offset. */
const OFFSET_STORAGE_KEY = 'lyrics-overlay:offset-s';
/** Clamp range for the offset (seconds). */
const OFFSET_MIN_S = 0;
const OFFSET_MAX_S = 10;

/** Load persisted offset, falling back to the default. */
function loadOffset(): number {
  try {
    const raw = localStorage.getItem(OFFSET_STORAGE_KEY);
    if (raw === null) return DEFAULT_LYRICS_OFFSET_S;
    const v = Number.parseFloat(raw);
    if (Number.isNaN(v)) return DEFAULT_LYRICS_OFFSET_S;
    return Math.min(OFFSET_MAX_S, Math.max(OFFSET_MIN_S, v));
  } catch {
    return DEFAULT_LYRICS_OFFSET_S;
  }
}

/** Persist offset to localStorage (best-effort). */
function saveOffset(v: number): void {
  try {
    localStorage.setItem(OFFSET_STORAGE_KEY, String(v));
  } catch {
    // Ignore storage failures (e.g. private mode).
  }
}

/** Format seconds as m:ss. */
function formatTime(secs: number): string {
  if (!secs || !Number.isFinite(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---- Overlay size (resize) ----
interface OverlaySize { width: number; height: number; }
interface SizeStore { lyrics: OverlaySize; player: OverlaySize; }

const DEFAULT_LYRICS_SIZE: OverlaySize = { width: 600, height: 120 };
const DEFAULT_PLAYER_SIZE: OverlaySize = { width: 400, height: 520 };
const MIN_LYRICS_SIZE: OverlaySize = { width: 300, height: 80 };
const MAX_LYRICS_SIZE: OverlaySize = { width: 1200, height: 300 };
const MIN_PLAYER_SIZE: OverlaySize = { width: 280, height: 360 };
const MAX_PLAYER_SIZE: OverlaySize = { width: 800, height: 800 };
const SIZE_STORAGE_KEY = 'lyrics-overlay:size';

function loadSize(): SizeStore {
  try {
    const raw = localStorage.getItem(SIZE_STORAGE_KEY);
    if (!raw) return { lyrics: DEFAULT_LYRICS_SIZE, player: DEFAULT_PLAYER_SIZE };
    const v = JSON.parse(raw) as Partial<SizeStore>;
    return {
      lyrics: { ...DEFAULT_LYRICS_SIZE, ...v.lyrics },
      player: { ...DEFAULT_PLAYER_SIZE, ...v.player },
    };
  } catch {
    return { lyrics: DEFAULT_LYRICS_SIZE, player: DEFAULT_PLAYER_SIZE };
  }
}

function saveSize(store: SizeStore): void {
  try {
    localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore storage failures.
  }
}

interface DragState {
  dragging: boolean;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

interface ResizeState {
  resizing: boolean;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
}

export const LyricsOverlay: React.FC = () => {
  const [lyricsState, setLyricsState] = useState<AceStepLyricsState | null>(null);
  const [playerState, setPlayerState] = useState<AceStepPlayerState | null>(null);
  const [mode, setMode] = useState<'lyrics' | 'player'>('lyrics');
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [lyricsOffset, setLyricsOffset] = useState<number>(loadOffset);
  const [sizeStore, setSizeStore] = useState<SizeStore>(loadSize);
  const playerStaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<DragState>({ dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const resizeRef = useRef<ResizeState>({ resizing: false, startX: 0, startY: 0, startW: 0, startH: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const currentLineRef = useRef<HTMLDivElement>(null);

  // ---- BGM source arbitration ----
  // LyricsOverlay only makes sense when AceStep is the active BGM source.
  // When the user switches to VRM radio (or no source), hide the overlay
  // so its control buttons (prev/play/next) don't conflict with the
  // MusicPopup footer which would be controlling the radio instead.
  const bgmActiveSource = useBgmPlayerStore((s) => s.activeSource);

  // ---- Current mode's size + constraints ----
  const currentSize = mode === 'player' ? sizeStore.player : sizeStore.lyrics;
  const minSize = mode === 'player' ? MIN_PLAYER_SIZE : MIN_LYRICS_SIZE;
  const maxSize = mode === 'player' ? MAX_PLAYER_SIZE : MAX_LYRICS_SIZE;
  const defaultSize = mode === 'player' ? DEFAULT_PLAYER_SIZE : DEFAULT_LYRICS_SIZE;
  const overlayScale = currentSize.width / defaultSize.width;

  // ---- Subscribe to lyrics state from AceStep window ----
  // No stale timer: showLyrics is a user-controlled flag (toggled via the
  // dynamic island button) and should persist even when currentTime stops
  // updating (e.g. between songs, during loading). The AceStep window
  // explicitly sends showLyrics:false when the user toggles it off.
  useEffect(() => {
    const unlisten = listen<AceStepLyricsState>(EVENT_LYRICS_STATE, (event) => {
      setLyricsState(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // ---- Subscribe to player state (isPlaying / duration / volume / cover) ----
  useEffect(() => {
    const unlisten = listen<AceStepPlayerState>(EVENT_PLAYER_STATE, (event) => {
      setPlayerState(event.payload);
      if (playerStaleTimerRef.current) clearTimeout(playerStaleTimerRef.current);
      playerStaleTimerRef.current = setTimeout(() => setPlayerState(null), STALE_TIMEOUT_MS);
    });
    return () => {
      unlisten.then((fn) => fn());
      if (playerStaleTimerRef.current) clearTimeout(playerStaleTimerRef.current);
    };
  }, []);

  // ---- Send a command back to the AceStep window ----
  const sendCommand = useCallback((action: string, payload?: Record<string, unknown>) => {
    emit(EVENT_PLAYER_COMMAND, { action, payload }).catch((e) =>
      console.warn('[LyricsOverlay] emit player-command failed:', e),
    );
  }, []);

  // ---- Parse LRC ----
  const parsed = useMemo(
    () => (lyricsState?.lrcText ? parseEnhancedLrc(lyricsState.lrcText) : null),
    [lyricsState?.lrcText],
  );

  // Apply the user-adjustable offset to obtain the effective lyric time.
  // `lyricsState.currentTime` is the raw decoder position; subtracting the
  // output buffer latency (offset) yields the estimated audible position.
  const rawTime = lyricsState?.currentTime ?? 0;
  const currentTime = Math.max(0, rawTime - lyricsOffset);
  const currentLineIndex = useMemo(
    () => (parsed ? findCurrentLineIndex(parsed.lines, currentTime) : -1),
    [parsed, currentTime],
  );

  // ---- Lyric sync fine-tune callbacks ----
  const adjustOffset = useCallback((delta: number) => {
    setLyricsOffset((prev) => {
      const next = Math.min(OFFSET_MAX_S, Math.max(OFFSET_MIN_S, prev + delta));
      saveOffset(next);
      return next;
    });
  }, []);
  const incOffset = useCallback(() => adjustOffset(OFFSET_STEP_S), [adjustOffset]);
  const decOffset = useCallback(() => adjustOffset(-OFFSET_STEP_S), [adjustOffset]);

  // ---- Close: send toggleLyrics command back to AceStep ----
  const handleClose = useCallback(() => {
    emit(EVENT_PLAYER_COMMAND, { action: 'toggleLyrics' }).catch((e) =>
      console.warn('[LyricsOverlay] emit toggleLyrics failed:', e),
    );
  }, []);

  // ---- ESC to close ----
  useEffect(() => {
    if (!lyricsState?.showLyrics) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lyricsState?.showLyrics, handleClose]);

  // ---- Dragging (move position) ----
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Don't start drag from interactive controls or the resize handle.
      if (
        (e.target as HTMLElement).closest(
          '.lyrics-overlay__titlebar, ' +
            '.lyrics-overlay__player-header-actions, .lyrics-overlay__player-controls, ' +
            '.lyrics-overlay__player-progress, .lyrics-overlay__player-lyrics, ' +
            '.lyrics-overlay__resize',
        )
      )
        return;
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragRef.current = {
        dragging: true,
        startX: e.clientX,
        startY: e.clientY,
        originX: position?.x ?? rect.left,
        originY: position?.y ?? rect.top,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [position],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPosition({
      x: dragRef.current.originX + dx,
      y: dragRef.current.originY + dy,
    });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.dragging) return;
    dragRef.current.dragging = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // ---- Resizing (drag bottom-right corner) ----
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      resizeRef.current = {
        resizing: true,
        startX: e.clientX,
        startY: e.clientY,
        startW: currentSize.width,
        startH: currentSize.height,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [currentSize],
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!resizeRef.current.resizing) return;
      const dx = e.clientX - resizeRef.current.startX;
      const dy = e.clientY - resizeRef.current.startY;
      const w = Math.min(maxSize.width, Math.max(minSize.width, resizeRef.current.startW + dx));
      const h = Math.min(maxSize.height, Math.max(minSize.height, resizeRef.current.startH + dy));
      setSizeStore((prev) => {
        const next = { ...prev, [mode]: { width: w, height: h } };
        saveSize(next);
        return next;
      });
    },
    [mode, minSize, maxSize],
  );

  const onResizePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current.resizing) return;
    resizeRef.current.resizing = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // ---- Derived line/word for karaoke ----
  const currentLine = parsed && currentLineIndex >= 0 ? parsed.lines[currentLineIndex] : null;
  const currentWordIndex = currentLine
    ? findCurrentWordIndex(currentLine.words, currentTime)
    : -1;

  // ---- Auto-scroll lyrics list in player mode ----
  useEffect(() => {
    if (mode !== 'player') return;
    currentLineRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentLineIndex, mode]);

  // ---- Player mode derived state ----
  const song = playerState?.currentSong ?? null;
  const isPlaying = playerState?.isPlaying ?? false;
  const duration = playerState?.duration ?? 0;
  const playerTime = playerState?.currentTime ?? 0;
  const volume = playerState?.volume ?? 0.8;
  const progress = duration > 0 ? Math.min(100, (playerTime / duration) * 100) : 0;

  const playModeIcon = useMemo(() => {
    switch (playerState?.playMode) {
      case 'repeat-all':
        return <Repeat size={14} />;
      case 'repeat-one':
        return <Repeat1 size={14} />;
      case 'shuffle':
        return <Shuffle size={14} />;
      default:
        return <ListOrdered size={14} />;
    }
  }, [playerState?.playMode]);

  // ---- Progress bar click-to-seek (player mode) ----
  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (duration <= 0) return;
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      sendCommand('seek', { time: ratio * duration });
    },
    [duration, sendCommand],
  );

  // ---- Visibility decision ----
  // Both modes only require showLyrics to be true; when no LRC text is
  // available, a "暂无歌词" placeholder is rendered instead.
  // Additionally, hide when AceStep is not the active BGM source (e.g.
  // VRM radio is playing) so the overlay's control buttons don't conflict
  // with the MusicPopup footer which controls the radio.
  const showLyrics = lyricsState?.showLyrics === true && bgmActiveSource === 'acestep';

  if (!showLyrics) return null;

  const style: React.CSSProperties = {
    width: currentSize.width,
    height: currentSize.height,
    '--overlay-scale': overlayScale,
    ...(position
      ? { left: position.x, top: position.y, bottom: 'auto', right: 'auto', transform: 'none' }
      : {}),
  } as React.CSSProperties;

  const rootClass = `lyrics-overlay no-penetrate${
    mode === 'player' ? ' lyrics-overlay--player' : ''
  }${hovered && mode === 'lyrics' ? ' lyrics-overlay--hovered' : ''}`;

  // ---- Sync fine-tune control (shared by both modes) ----
  const syncControl = (
    <div className="lyrics-overlay__sync" role="group" aria-label="Lyric sync fine-tune">
      <button
        type="button"
        className="lyrics-overlay__sync-btn"
        onClick={decOffset}
        disabled={lyricsOffset <= OFFSET_MIN_S}
        aria-label="Lyrics earlier (decrease offset)"
        title="歌词提前"
      >
        <Minus size={12} />
      </button>
      <span className="lyrics-overlay__sync-value" title="歌词同步补偿（秒）">
        {lyricsOffset.toFixed(1)}s
      </span>
      <button
        type="button"
        className="lyrics-overlay__sync-btn"
        onClick={incOffset}
        disabled={lyricsOffset >= OFFSET_MAX_S}
        aria-label="Lyrics later (increase offset)"
        title="歌词延后"
      >
        <Plus size={12} />
      </button>
    </div>
  );

  // ---- Resize handle (shared by both modes) ----
  const resizeHandle = (
    <div
      className="lyrics-overlay__resize"
      onPointerDown={onResizePointerDown}
      onPointerMove={onResizePointerMove}
      onPointerUp={onResizePointerUp}
      aria-hidden="true"
    />
  );

  // ========================================================================
  // Player mode — vertical mini player (cover / scrolling lyrics / controls)
  // ========================================================================
  if (mode === 'player') {
    return (
      <div
        ref={rootRef}
        className={rootClass}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        role="dialog"
        aria-label={song?.title ?? lyricsState?.title ?? 'Player'}
      >
        {/* Header: cover + meta + actions */}
        <div className="lyrics-overlay__player-header">
          <div className="lyrics-overlay__player-cover">
            {playerState?.coverPath ? (
              <img src={convertFileSrc(playerState.coverPath)} alt="" draggable={false} />
            ) : (
              <Music size={26} />
            )}
          </div>
          <div className="lyrics-overlay__player-meta">
            <span className="lyrics-overlay__player-title" title={song?.title ?? ''}>
              {song?.title ?? lyricsState?.title ?? ''}
            </span>
            <span className="lyrics-overlay__player-artist" title={song?.artist ?? ''}>
              {song?.artist ?? ''}
            </span>
          </div>
          <div className="lyrics-overlay__player-header-actions">
            <button
              type="button"
              className="lyrics-overlay__player-icon-btn"
              onClick={() => setMode('lyrics')}
              aria-label="Collapse to lyrics"
              title="收起为歌词"
            >
              <Minimize2 size={14} />
            </button>
            <button
              type="button"
              className="lyrics-overlay__player-icon-btn"
              onClick={handleClose}
              aria-label="Close lyrics"
              title="关闭"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Scrolling lyrics area */}
        <div className="lyrics-overlay__player-lyrics">
          {parsed && parsed.lines.length > 0 ? (
            parsed.lines.map((line, i) => {
              const isCurrent = i === currentLineIndex;
              const isAdjacent = Math.abs(i - currentLineIndex) === 1;
              return (
                <div
                  key={i}
                  ref={isCurrent ? currentLineRef : undefined}
                  className={`lyrics-overlay__player-lyric-line${
                    isCurrent ? ' is-current' : ''
                  }${isAdjacent ? ' is-adjacent' : ''}`}
                >
                  {isCurrent && line.words.length > 1
                    ? line.words.map((word, wi) => (
                        <span
                          key={wi}
                          className={`lyrics-overlay__word${
                            wi <= currentWordIndex ? ' lyrics-overlay__word--sung' : ''
                          }`}
                        >
                          {word.text}
                        </span>
                      ))
                    : line.rawText}
                </div>
              );
            })
          ) : (
            <div className="lyrics-overlay__player-lyrics-empty">暂无歌词</div>
          )}
        </div>

        {/* Progress bar + times */}
        <div className="lyrics-overlay__player-progress">
          <span className="lyrics-overlay__player-time">{formatTime(playerTime)}</span>
          <div
            className="lyrics-overlay__player-progress-track"
            onClick={handleProgressClick}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(playerTime)}
          >
            <div
              className="lyrics-overlay__player-progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="lyrics-overlay__player-time">{formatTime(duration)}</span>
        </div>

        {/* Control bar */}
        <div className="lyrics-overlay__player-controls">
          <button
            type="button"
            className="lyrics-overlay__player-btn"
            disabled
            aria-label="Favorite (coming soon)"
            title="收藏（即将推出）"
          >
            <Heart size={15} />
          </button>
          <button
            type="button"
            className="lyrics-overlay__player-btn"
            disabled
            aria-label="Comments (coming soon)"
            title="评论（即将推出）"
          >
            <MessageCircle size={15} />
          </button>
          <div className="lyrics-overlay__player-main-controls">
            <button
              type="button"
              className="lyrics-overlay__player-btn"
              onClick={() => sendCommand('prev')}
              aria-label="Previous"
              title="上一首"
            >
              <SkipBack size={16} />
            </button>
            <button
              type="button"
              className="lyrics-overlay__player-btn lyrics-overlay__player-btn--glow"
              onClick={() => sendCommand('togglePlay')}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              title={isPlaying ? '暂停' : '播放'}
            >
              {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            </button>
            <button
              type="button"
              className="lyrics-overlay__player-btn"
              onClick={() => sendCommand('next')}
              aria-label="Next"
              title="下一首"
            >
              <SkipForward size={16} />
            </button>
          </div>
          <button
            type="button"
            className="lyrics-overlay__player-btn"
            onClick={() => sendCommand('togglePlayMode')}
            aria-label="Play mode"
            title="播放模式"
          >
            {playModeIcon}
          </button>
          <div className="lyrics-overlay__player-volume">
            <button
              type="button"
              className="lyrics-overlay__player-btn"
              onClick={() => sendCommand('setVolume', { volume: volume > 0 ? 0 : 0.8 })}
              aria-label={volume > 0 ? 'Mute' : 'Unmute'}
              title={volume > 0 ? '静音' : '取消静音'}
            >
              {volume > 0 ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>
            <input
              type="range"
              className="lyrics-overlay__player-volume-slider"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => sendCommand('setVolume', { volume: Number.parseFloat(e.target.value) })}
              onClick={(e) => e.stopPropagation()}
              aria-label="Volume"
            />
          </div>
          {syncControl}
        </div>
        {resizeHandle}
      </div>
    );
  }

  // ========================================================================
  // Lyrics mode — transparent desktop lyrics with hover toolbar
  // ========================================================================
  const hasLyrics = parsed !== null && parsed.lines.length > 0 && currentLineIndex >= 0;
  const prevLine =
    hasLyrics && currentLineIndex > 0 ? parsed!.lines[currentLineIndex - 1] : null;
  const nextLine =
    hasLyrics && currentLineIndex < parsed!.lines.length - 1
      ? parsed!.lines[currentLineIndex + 1]
      : null;

  return (
    <div
      ref={rootRef}
      className={rootClass}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="marquee"
      aria-label={lyricsState?.title ?? 'Lyrics'}
    >
      {hovered && (
        <div className="lyrics-overlay__titlebar">
          <button
            type="button"
            className="lyrics-overlay__titlebar-btn"
            onClick={() => sendCommand('prev')}
            aria-label="Previous"
            title="上一首"
          >
            <SkipBack size={13} />
          </button>
          <button
            type="button"
            className="lyrics-overlay__titlebar-btn"
            onClick={() => sendCommand('togglePlay')}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            title={isPlaying ? '暂停' : '播放'}
          >
            {isPlaying ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <button
            type="button"
            className="lyrics-overlay__titlebar-btn"
            onClick={() => sendCommand('next')}
            aria-label="Next"
            title="下一首"
          >
            <SkipForward size={13} />
          </button>
          <div className="lyrics-overlay__titlebar-spacer" />
          {syncControl}
          <button
            type="button"
            className="lyrics-overlay__titlebar-btn"
            onClick={() => setMode('player')}
            aria-label="Expand to player"
            title="展开为播放器"
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            className="lyrics-overlay__titlebar-btn"
            onClick={handleClose}
            aria-label="Close lyrics"
            title="关闭"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="lyrics-overlay__row">
        {playerState?.coverPath && (
          <div className="lyrics-overlay__cover">
            <img src={convertFileSrc(playerState.coverPath)} alt="" draggable={false} />
          </div>
        )}

        <div className="lyrics-overlay__lines">
          {hasLyrics && prevLine && (
            <div className="lyrics-overlay__line lyrics-overlay__line--adjacent">
              {prevLine.rawText}
            </div>
          )}

          {hasLyrics && currentLine ? (
            <div className="lyrics-overlay__line lyrics-overlay__line--current">
              {currentLine.words.length > 1
                ? currentLine.words.map((word, i) => (
                    <span
                      key={i}
                      className={`lyrics-overlay__word${
                        i <= currentWordIndex ? ' lyrics-overlay__word--sung' : ''
                      }`}
                    >
                      {word.text}
                    </span>
                  ))
                : currentLine.rawText}
            </div>
          ) : (
            <div className="lyrics-overlay__line lyrics-overlay__line--current lyrics-overlay__line--empty">
              暂无歌词
            </div>
          )}

          {hasLyrics && nextLine && (
            <div className="lyrics-overlay__line lyrics-overlay__line--adjacent">
              {nextLine.rawText}
            </div>
          )}
        </div>
      </div>

      {hovered && resizeHandle}
    </div>
  );
};

export default LyricsOverlay;
