/**
 * Task → visible fields mapping for Custom-Gen view.
 *
 * extract/complete are intentionally excluded (acestep.cpp behavior
 * unverified). Each task shows the base content fields plus its
 * task-specific fields; DiT/LM/advanced/output groups are always visible.
 */

import type { AceRequest } from '../types';

export type TaskId = 'text2music' | 'cover' | 'cover-nofsq' | 'repaint' | 'lego';

export interface TaskConfig {
  id: TaskId;
  /** Content-group fields visible for this task (DiT/LM/advanced/output always visible). */
  visibleContentFields: Set<keyof AceRequest>;
  srcRequired: boolean;
}

const BASE_CONTENT: (keyof AceRequest)[] = [
  'caption',
  'lyrics',
  'duration',
  'bpm',
  'keyscale',
  'timesignature',
  'vocal_language',
];

export const TASK_CONFIGS: Record<TaskId, TaskConfig> = {
  text2music: {
    id: 'text2music',
    visibleContentFields: new Set(BASE_CONTENT),
    srcRequired: false,
  },
  cover: {
    id: 'cover',
    visibleContentFields: new Set([...BASE_CONTENT, 'audio_cover_strength', 'cover_noise_strength']),
    srcRequired: true,
  },
  'cover-nofsq': {
    id: 'cover-nofsq',
    visibleContentFields: new Set([...BASE_CONTENT, 'audio_cover_strength', 'cover_noise_strength']),
    srcRequired: true,
  },
  repaint: {
    id: 'repaint',
    visibleContentFields: new Set([...BASE_CONTENT, 'repainting_start', 'repainting_end']),
    srcRequired: true,
  },
  lego: {
    id: 'lego',
    visibleContentFields: new Set([...BASE_CONTENT, 'track']),
    srcRequired: true,
  },
};

export const TASK_ORDER: TaskId[] = ['text2music', 'cover', 'cover-nofsq', 'repaint', 'lego'];
