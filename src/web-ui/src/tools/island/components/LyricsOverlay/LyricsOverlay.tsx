/**
 * LyricsOverlay — 主窗口独立透明歌词浮层（桌面歌词风格）。
 *
 * 通过 Tauri Event `acestep://lyrics-state` / `acestep://player-state` 从
 * AceStep 窗口接收歌词/播放器状态，自己解析 LRC 并根据 currentTime（减去
 * 用户可调的歌词同步补偿）二分查找当前行/词。
 *
 * - 尺寸随鼠标滚轮等比缩放（窗口 + 字体联动，持久化）；可拖拽改变位置；
 *   ESC 关闭（发 command 回 AceStep）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import { X, Plus, Minus, Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import {
  parseEnhancedLrc,
  findCurrentLineIndex,
  findCurrentWordIndex,
} from '../../../acestep/utils/lrcParser';
import { useBgmPlayerStore } from '../../store/bgmPlayer';
import { LyricParticles } from '../../../music-window/LyricParticles';
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

/** Heartbeat timeout — drop player state (cover/play flag) if not refreshed. */
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

// ---- Overlay scale (mouse wheel; scales box size + fonts together) ----
const OVERLAY_BASE_SIZE = { width: 600, height: 120 };
const SCALE_STORAGE_KEY = 'lyrics-overlay:scale';
/** Legacy key from the removed resize-handle era — purge on load. */
const LEGACY_SIZE_STORAGE_KEY = 'lyrics-overlay:size';
const DEFAULT_SCALE = 1;
const SCALE_MIN = 0.6;
const SCALE_MAX = 2.5;
/** Per wheel-notch step. */
const SCALE_STEP = 0.1;

/** Load persisted scale, falling back to the default. */
function loadScale(): number {
  try {
    localStorage.removeItem(LEGACY_SIZE_STORAGE_KEY);
    const raw = localStorage.getItem(SCALE_STORAGE_KEY);
    if (raw === null) return DEFAULT_SCALE;
    const v = Number.parseFloat(raw);
    if (Number.isNaN(v)) return DEFAULT_SCALE;
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, v));
  } catch {
    return DEFAULT_SCALE;
  }
}

/** Persist scale to localStorage (best-effort). */
function saveScale(v: number): void {
  try {
    localStorage.setItem(SCALE_STORAGE_KEY, String(v));
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

export const LyricsOverlay: React.FC = () => {
  const [lyricsState, setLyricsState] = useState<AceStepLyricsState | null>(null);
  const [playerState, setPlayerState] = useState<AceStepPlayerState | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [lyricsOffset, setLyricsOffset] = useState<number>(loadOffset);
  const [overlayScale, setOverlayScale] = useState<number>(loadScale);
  const playerStaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<DragState>({ dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  // ---- BGM source arbitration ----
  // LyricsOverlay only makes sense when AceStep is the active BGM source.
  // When the user switches to VRM radio (or no source), hide the overlay
  // so its control buttons (prev/play/next) don't conflict with the
  // MusicWindow footer which would be controlling the radio instead.
  const bgmActiveSource = useBgmPlayerStore((s) => s.activeSource);

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

  // ---- Subscribe to player state (isPlaying / cover) ----
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

  // ---- Visibility decision ----
  // Only requires showLyrics to be true; when no LRC text is available, a
  // "暂无歌词" placeholder is rendered instead. Additionally, hide when
  // AceStep is not the active BGM source (e.g. VRM radio is playing) so the
  // overlay's control buttons don't conflict with the MusicWindow footer
  // which controls the radio.
  const showOverlay = lyricsState?.showLyrics === true && bgmActiveSource === 'acestep';

  // ---- ESC to close ----
  useEffect(() => {
    if (!lyricsState?.showLyrics) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lyricsState?.showLyrics, handleClose]);

  // ---- Mouse wheel over the overlay: scale box + fonts (persisted) ----
  // Native non-passive listener so preventDefault stops page-level scroll
  // chaining; re-attached whenever visibility flips (root renders only
  // while the overlay is shown).
  useEffect(() => {
    if (!showOverlay) return;
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
      setOverlayScale((prev) => {
        const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, prev + step));
        if (next !== prev) saveScale(next);
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [showOverlay]);

  // ---- Dragging (move position) ----
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Don't start drag from interactive controls.
      if (
        (e.target as HTMLElement).closest(
          '.lyrics-overlay__titlebar, .lyrics-overlay__sync',
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

  // ---- Derived line/word for karaoke ----
  const currentLine = parsed && currentLineIndex >= 0 ? parsed.lines[currentLineIndex] : null;
  const currentWordIndex = currentLine
    ? findCurrentWordIndex(currentLine.words, currentTime)
    : -1;

  if (!showOverlay) return null;

  const style = {
    width: Math.round(OVERLAY_BASE_SIZE.width * overlayScale),
    height: Math.round(OVERLAY_BASE_SIZE.height * overlayScale),
    '--overlay-scale': overlayScale,
    ...(position
      ? { left: position.x, top: position.y, bottom: 'auto', right: 'auto', transform: 'none' }
      : {}),
  } as React.CSSProperties;

  const isPlaying = playerState?.isPlaying ?? false;

  const hasLyrics = parsed !== null && parsed.lines.length > 0 && currentLineIndex >= 0;
  const prevLine =
    hasLyrics && currentLineIndex > 0 ? parsed!.lines[currentLineIndex - 1] : null;
  const nextLine =
    hasLyrics && currentLineIndex < parsed!.lines.length - 1
      ? parsed!.lines[currentLineIndex + 1]
      : null;

  return (
    <>
    <div
      ref={rootRef}
      className={`lyrics-overlay no-penetrate${hovered ? ' lyrics-overlay--hovered' : ''}`}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="marquee"
      aria-label={lyricsState?.title ?? 'Lyrics'}
    >
      {/* 律动粒子层（星尘）：真实频谱驱动，永远在文字后面 */}
      <LyricParticles active={isPlaying} className="lyrics-overlay__particles" />
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
            <div
              key={currentLineIndex}
              className="lyrics-overlay__line lyrics-overlay__line--current"
            >
              <span className="lyrics-overlay__line-inner">
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
              </span>
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
      </div>
    </>
  );
};

export default LyricsOverlay;
