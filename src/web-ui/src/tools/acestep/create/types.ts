/**
 * Creation model for the rebuilt music create section.
 *
 * A Creation is the single user-facing entity: quick creations (style +
 * lyrics → full song) and track creations (multi-track timeline editor)
 * share this shape; `type` decides which editor renders. Every generated
 * audio lands in the creation's own `samples` group — samples never leak
 * across creations.
 */

import type { AceRequest, SongScore } from '../types';

/** Lyrics segment: bilingual-tag section with its lyric lines. */
export interface LyricsSegment {
  id: string;
  /** Canonical English structure tag id, e.g. "verse-1", "chorus". */
  kind: string;
  /** Optional combo descriptors (max 2, e.g. ["anthemic"] → [Chorus - anthemic]). */
  descriptors?: string[];
  /** Lyric lines (without structure tags). */
  lines: string[];
}

/** One generated audio inside a creation's sample group. */
export interface CreationSample {
  id: string;
  /** Mixed output wav path. */
  audioPath: string;
  durationSeconds: number;
  createdAt: number;
  /** True after 打包发行 (.a00m packaged into the songs dir). */
  inLibrary: boolean;
  /** Auto quality score (attached fire-and-forget after generation). */
  score?: SongScore;
  /** Enhanced LRC (word-level timestamps) generated before packaging. */
  lrc?: string;
  lrcPath?: string;
}

/** Track kinds for the track editor (canonical English name = lego `track`). */
export type TrackKind = 'base' | 'drums' | 'bass' | 'vocals' | 'harmony' | 'melody' | 'custom';

export interface CreationTrack {
  id: string;
  kind: TrackKind;
  /** Display name (localized kind label or custom name). */
  name: string;
  /** Style description for this track's generation. */
  prompt: string;
  /** Lyrics (vocals/harmony tracks only), English-tag serialized. */
  lyrics?: string;
  vocalLanguage?: string;
  /** Unmixed stem wav written by the backend (lego tasks). */
  stemPath?: string;
  /** Mix wav produced by this track's generation (conditions the next layer). */
  mixPath?: string;
  /** The mix this track was generated against (lego conditioning context). */
  baseAtGen?: string;
  gainDb: number;
  muted: boolean;
  solo: boolean;
  status: 'empty' | 'generating' | 'ready' | 'error';
  error?: string;
}

export interface QuickParams {
  /** Target duration in seconds (0 = engine auto). */
  durationSec: number;
  vocalLanguage: string;
  instrumental: boolean;
  /** 样品生成数量（1-4，串发逐首产出；默认 1）。 */
  generateCount?: number;
  /** 参考音色：本地音频文件路径（可选；引擎按其音色质感做条件生成）。 */
  refAudioPath?: string;
  /** 参考音色文件名（仅展示用）。 */
  refAudioName?: string;
}

/** Creation type: quick (style+lyrics), track (multi-track) or remix (song-to-song). */
export type CreationType = 'quick' | 'track' | 'remix';

/** 改歌工作流模式：翻唱重编 / 忠实重混 / 局部重绘。 */
export type RemixMode = 'cover' | 'nofsq' | 'repaint';

/** 改歌（remix）创作参数：源音频 + 任务模式。 */
export interface RemixParams {
  /** 源音频绝对路径（上传 / 录音 / 收藏 / 作品解析产物）。 */
  sourcePath: string;
  /** 源音频展示名。 */
  sourceName: string;
  /** 源音频时长（秒，0 = 未知）。 */
  sourceDurationSec: number;
  mode: RemixMode;
  /** audio_cover_strength：DiT 使用源上下文的步比例（0-1）。 */
  coverStrength: number;
  /** 重绘区间起点（秒；0 = 源起点）。 */
  repaintStart: number;
  /** 重绘区间终点（秒；-1 = 源结尾；超过源时长 = 向后延长）。 */
  repaintEnd: number;
}

export interface Creation {
  id: string;
  type: CreationType;
  title: string;
  createdAt: number;
  updatedAt: number;
  // ---- quick editor state ----
  /** Raw user style description (pre-optimization). */
  styleInput: string;
  /** Accepted AI-optimized English caption (submitted to the engine). */
  optimizedCaption?: string;
  /** Chinese gloss of the accepted caption (display only). */
  optimizedCaptionZh?: string;
  lyricsSegments: LyricsSegment[];
  params: QuickParams;
  /** AI model reference for this creation's agent calls (default: primary). */
  aiModel?: string;
  // ---- remix (改歌) editor state ----
  /** Present only when type === 'remix'. */
  remixParams?: RemixParams;
  // ---- track editor state ----
  tracks: CreationTrack[];
  // ---- outputs ----
  samples: CreationSample[];
  /** Busy flag for the creation-level generation (quick generate). */
  generating: boolean;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createCreation(type: CreationType, title: string, remixMode?: RemixMode): Creation {
  const creation: Creation = {
    id: newId('cr'),
    type,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    styleInput: '',
    lyricsSegments: [],
    params: { durationSec: 0, vocalLanguage: 'zh', instrumental: false },
    tracks: [],
    samples: [],
    generating: false,
  };
  if (type === 'remix') {
    creation.remixParams = {
      sourcePath: '',
      sourceName: '',
      sourceDurationSec: 0,
      mode: remixMode ?? 'cover',
      coverStrength: 1.0,
      repaintStart: 0,
      repaintEnd: -1,
    };
  }
  return creation;
}

/** Opaque wrapper persisted into AceStepSessionData.creationPlan. */
export interface CreateStateEnvelope {
  __createState: true;
  version: 1;
  creation: Creation;
  /** Full AceRequest of the last generation per sample id (for 换一版). */
  lastRequests: Record<string, AceRequest>;
}

export function isCreateStateEnvelope(value: unknown): value is CreateStateEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __createState?: unknown }).__createState === true
  );
}
