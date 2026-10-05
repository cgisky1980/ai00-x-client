/**
 * createStore — state for the rebuilt music create section.
 *
 * Owns: creations (quick + track), per-creation sample groups, tracks,
 * engine/preset state and generation flows. Creations persist through the
 * existing `acestep_session_*` commands: the whole Creation is stored as an
 * opaque envelope in `creationPlan`, and `mode` maps quick→text2music,
 * track→lego so the session list doubles as the creation list.
 *
 * Generation request shapes (lm_mode 'format', 50 steps, guidance 7.0)
 * follow the proven lego flow from the retired acestepStore.
 */

import { create } from 'zustand';
import { createLogger } from '@/shared/utils/logger';
import { aceStepService } from '../services/AceStepService';
import { api } from '@/infrastructure/api';
import type {
  AceRequest,
  AceStepCatalogEntry,
  AceStepDownloadProgress,
  AceStepProgressEvent,
  AceStepStatus,
  AceStepSessionData,
  PackageSongResult,
} from '../types';
import { createDefaultAceRequest } from '../types';
import {
  audioEngine,
} from './audioEngine';
import { estimateDurationSec } from './lyricTemplates';
import { DEFAULT_AGENT_MODEL, listAgentModels } from './musicAgent';
import { serializeLyrics, parseLyricsText } from './tagCatalog';
import {
  createCreation,
  isCreateStateEnvelope,
  newId,
  type Creation,
  type CreationSample,
  type CreationTrack,
  type CreationType,
  type QuickParams,
  type RemixMode,
  type RemixParams,
  type TrackKind,
} from './types';

const log = createLogger('CreateStore');

/** Base-family DiT sampling profile (quantized GGUF, 50 steps + CFG). */
const BASE_STEPS = 50;
const BASE_SHIFT = 1.0;
const BASE_GUIDANCE = 7.0;

/** Titles starting with any of these get renamed to the first caption. */
const AUTO_RENAME_PREFIXES = ['快捷创作 ', '改歌 ', '局部重绘 '];

export interface CreateStoreState {
  creations: Creation[];
  activeId: string | null;
  loaded: boolean;
  /** Human-readable error for the last failed action (rendered by editors). */
  error: string | null;

  // ---- engine / music model (local DiT variants, like the old selector) ----
  engineStatus: AceStepStatus | null;
  /** DiT catalog entries (Base Q5/Q8, XL Base Q5/Q8). */
  catalog: AceStepCatalogEntry[];
  /** Selected DiT filename (persisted in localStorage). */
  selectedDit: string | null;
  /** The DiT filename currently loaded in the pipeline (null = none/other). */
  loadedDit: string | null;
  /** Active bundle-download task ids + polled progress. */
  downloadTasks: string[];
  downloadProgress: Record<string, AceStepDownloadProgress>;
  engineBusy: boolean;

  // ---- AI agent models ----
  agentModels: string[];

  // ---- generation progress (global: one pipeline at a time) ----
  progress: AceStepProgressEvent | null;
  /** Id of the track currently generating (track editor busy state). */
  generatingTrackId: string | null;
  /** 多首串发进度（generateQuick 用；单首/换一版为 null）。 */
  generateProgress: { id: string; done: number; total: number } | null;

  initialize: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshCatalog: () => Promise<void>;
  /** Select a downloaded DiT variant as the active music model. */
  selectModel: (filename: string) => void;
  /** Download the full bundle (text encoder + DiT + VAE) for a variant. */
  downloadModel: (filename: string) => Promise<void>;
  ensureEngineLoaded: () => Promise<void>;

  selectCreation: (id: string) => void;
  createCreation: (type: CreationType, opts?: { remixMode?: RemixMode }) => Promise<Creation>;
  deleteCreation: (id: string) => Promise<void>;
  renameCreation: (id: string, title: string) => void;
  patchCreation: (id: string, patch: Partial<Creation>) => void;
  patchParams: (id: string, patch: Partial<QuickParams>) => void;
  patchRemixParams: (id: string, patch: Partial<RemixParams>) => void;
  /** 「送入改歌/局部重绘」：以指定音频为源新建 remix 创作并选中。 */
  sendToRemix: (
    source: { path: string; name: string; durationSeconds?: number },
    mode: RemixMode,
  ) => Promise<void>;

  // quick editor
  acceptStyleOptimization: (
    id: string,
    caption: string,
    captionZh: string,
    durationSec: number
  ) => void;
  clearStyleOptimization: (id: string) => void;
  generateQuick: (id: string) => Promise<void>;
  /** 改歌 / 局部重绘生成（remix 创作）。 */
  generateRemix: (id: string) => Promise<void>;
  regenerateSample: (id: string, sampleId: string) => Promise<void>;

  // samples
  saveSampleToLibrary: (
    id: string,
    sampleId: string,
    meta?: { title?: string; artist?: string; coverPath?: string },
  ) => Promise<PackageSongResult | null>;
  deleteSample: (id: string, sampleId: string) => void;

  // track editor
  addTrack: (
    id: string,
    kind: TrackKind,
    name: string,
    prompt: string,
    lyrics?: string,
    vocalLanguage?: string
  ) => Promise<string>;
  generateTrack: (id: string, trackId: string) => Promise<void>;
  /** 换一版: regenerate against the track's original conditioning base. */
  regenerateTrack: (id: string, trackId: string) => Promise<void>;
  updateTrack: (id: string, trackId: string, patch: Partial<CreationTrack>) => void;
  removeTrack: (id: string, trackId: string) => void;

  // export
  exportMix: (id: string) => Promise<string | null>;
}

/** Per-creation in-memory generation context (persisted in the envelope). */
const lastRequests = new Map<string, AceRequest>();

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

// ---- selected music model persistence (same key as the old selector) ----

const DIT_STORAGE_KEY = 'acestep-selected-dit';

function loadPersistedDit(): string | null {
  try {
    return localStorage.getItem(DIT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistDit(filename: string | null): void {
  try {
    if (filename) localStorage.setItem(DIT_STORAGE_KEY, filename);
    else localStorage.removeItem(DIT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Map a DiT catalog entry to its bundle preset id (text encoder + DiT + VAE). */
function presetIdForDit(entry: AceStepCatalogEntry): string | null {
  if (entry.role !== 'dit') return null;
  const family = entry.ditType === 'xl-base' ? 'xl-base' : 'base';
  const quant = entry.variant.includes('Q8') ? 'q8' : 'q5';
  return `${family}-${quant}`;
}

function detectLanguage(text: string): string {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[a-zA-Z]/.test(text)) return 'en';
  return '';
}

/** Snap a legacy duration to the nearest duration option (0 = auto). */
function snapDuration(seconds: number): number {
  const steps = [0, 60, 90, 120, 150, 180, 240];
  return steps.reduce((best, s) => (Math.abs(s - seconds) < Math.abs(best - seconds) ? s : best), 0);
}

function creationToSession(creation: Creation, requests: Record<string, AceRequest>): AceStepSessionData {
  return {
    id: creation.id,
    title: creation.title,
    createdAt: creation.createdAt,
    updatedAt: creation.updatedAt,
    chatMessages: [],
    creationPlan: {
      __createState: true,
      version: 1,
      creation,
      lastRequests: requests,
    },
    outputs: [],
    mode: creation.type === 'track' ? 'lego' : 'text2music',
    legoState: null,
  };
}

/** Map a legacy (chat-flow) session into a quick creation so old works stay visible. */
function migrateLegacySession(data: AceStepSessionData): Creation {
  const plan = (data.creationPlan ?? {}) as {
    caption?: string;
    lyrics?: string;
    duration?: number;
  };
  const outputs = (data.outputs ?? []) as Array<{
    id?: string;
    outputPath?: string;
    durationSeconds?: number;
    createdAt?: number;
  }>;
  const creation = createCreation('quick', data.title);
  creation.id = data.id;
  creation.createdAt = data.createdAt;
  creation.updatedAt = data.updatedAt;
  creation.optimizedCaption = typeof plan.caption === 'string' ? plan.caption : undefined;
  if (typeof plan.lyrics === 'string' && plan.lyrics && plan.lyrics !== '[Instrumental]') {
    creation.lyricsSegments = parseLyricsText(plan.lyrics).map((b) => ({
      id: newId('seg'),
      kind: b.tag,
      lines: b.lines,
    }));
  }
  creation.params.durationSec = typeof plan.duration === 'number' ? snapDuration(plan.duration) : 0;
  creation.params.instrumental = plan.lyrics === '[Instrumental]';
  creation.samples = outputs
    .filter((o) => typeof o.outputPath === 'string')
    .map((o) => ({
      id: o.id ?? newId('sm'),
      audioPath: o.outputPath as string,
      durationSeconds: o.durationSeconds ?? 0,
      createdAt: o.createdAt ?? data.updatedAt,
      inLibrary: false,
    }));
  return creation;
}

async function loadCreationFromSession(meta: {
  id: string;
}): Promise<Creation | null> {
  try {
    const data = await aceStepService.sessionLoad(meta.id);
    if (isCreateStateEnvelope(data.creationPlan)) {
      const envelope = data.creationPlan;
      // Sample ids are globally unique — accumulate across creations so
      // 换一版 keeps working for every loaded creation (no clearing here).
      for (const [k, v] of Object.entries(envelope.lastRequests ?? {})) {
        lastRequests.set(k, v as AceRequest);
      }
      const creation = envelope.creation;
      // 瞬态状态不跨会话：生成中被重启的创作，加载时复位，
      // 避免「生成中…」转圈永挂。
      creation.generating = false;
      creation.tracks = (creation.tracks ?? []).map((t) =>
        t.status === 'generating' ? { ...t, status: 'empty', error: undefined } : t,
      );
      return creation;
    }
    return migrateLegacySession(data);
  } catch (e) {
    log.warn(`Failed to load session ${meta.id}:`, e);
    return null;
  }
}

export const useCreateStore = create<CreateStoreState>((set, get) => {
  const persist = (creation: Creation) => {
    const timer = saveTimers.get(creation.id);
    if (timer) clearTimeout(timer);
    saveTimers.set(
      creation.id,
      setTimeout(() => {
        saveTimers.delete(creation.id);
        const requests: Record<string, AceRequest> = {};
        for (const s of creation.samples) {
          const req = lastRequests.get(s.id);
          if (req) requests[s.id] = req;
        }
        aceStepService
          .sessionSave(creationToSession(creation, requests))
          .catch((e) => log.warn('session save failed:', e));
      }, 500),
    );
  };

  const touch = (id: string, patch: Partial<Creation>) => {
    set((s) => ({
      creations: s.creations.map((c) =>
        c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c,
      ),
    }));
    const updated = get().creations.find((c) => c.id === id);
    if (updated) persist(updated);
  };

  const updateSample = (id: string, sampleId: string, patch: Partial<CreationSample>) => {
    const cr = get().creations.find((c) => c.id === id);
    if (!cr) return;
    touch(id, {
      samples: cr.samples.map((s) => (s.id === sampleId ? { ...s, ...patch } : s)),
    });
  };

  /**
   * 串发生成公共编排（快捷/改歌共用）：装载引擎 → 逐首构建请求并生成 →
   * 样品入组 → 后台打分/LRC 对齐 → 卸载引擎。单曲失败中断后续（已产出保留）。
   */
  const runSampleSeries = async (
    id: string,
    total: number,
    build: (cr: Creation) => {
      req: AceRequest;
      srcAudioPath?: string;
      refAudioPath?: string;
    },
  ): Promise<void> => {
    set({ generateProgress: total > 1 ? { id, done: 0, total } : null });
    touch(id, { generating: true });
    let succeeded = 0;
    try {
      await get().ensureEngineLoaded();
      for (let i = 0; i < total; i++) {
        const cr = get().creations.find((c) => c.id === id);
        if (!cr) break;
        const { req, srcAudioPath, refAudioPath } = build(cr);
        try {
          const result = await aceStepService.generate({
            request: req,
            srcAudioPath,
            refAudioPath,
          });
          const sample: CreationSample = {
            id: newId('sm'),
            audioPath: result.outputPath,
            durationSeconds: result.durationSeconds,
            createdAt: Date.now(),
            inLibrary: false,
          };
          lastRequests.set(sample.id, req);
          const fresh = get().creations.find((c) => c.id === id);
          if (fresh) {
            const shouldRename =
              req.caption.length > 0 &&
              AUTO_RENAME_PREFIXES.some((p) => fresh.title.startsWith(p));
            touch(id, {
              samples: [sample, ...fresh.samples],
              title: shouldRename ? req.caption.slice(0, 16) : fresh.title,
            });
          }
          // 生成完成：后台自动打分 + 歌词对齐
          void enrichSample(id, sample.id, result.outputPath, req.lyrics, req.vocal_language || '');
          succeeded += 1;
        } catch (e) {
          log.error('generation failed:', e);
          set({ error: e instanceof Error ? e.message : String(e) });
          break;
        }
        if (total > 1) set({ generateProgress: { id, done: i + 1, total } });
      }
      if (total > 1 && succeeded > 0) log.info(`generation: ${succeeded}/${total} samples`);
    } catch (e) {
      // ensureEngineLoaded failure
      log.error('generation failed:', e);
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ generateProgress: null });
      touch(id, { generating: false });
      try {
        await aceStepService.unload();
        await get().refreshStatus();
      } catch {
        // unload failure must not mask the result.
      }
    }
  };

  return {
    creations: [],
    activeId: null,
    loaded: false,
    error: null,

    engineStatus: null,
    catalog: [],
    selectedDit: null,
    loadedDit: null,
    downloadTasks: [],
    downloadProgress: {},
    engineBusy: false,

    agentModels: [DEFAULT_AGENT_MODEL],

    progress: null,
    generatingTrackId: null,
    generateProgress: null,

    initialize: async () => {
      if (get().loaded) return;
      try {
        const [metas, catalog, status, models] = await Promise.all([
          aceStepService.sessionList(),
          aceStepService.listCatalog().catch(() => [] as AceStepCatalogEntry[]),
          aceStepService.getStatus().catch(() => null),
          listAgentModels(),
        ]);
        const creations = (
          await Promise.all(metas.map((m) => loadCreationFromSession(m)))
        ).filter((c): c is Creation => c !== null);
        creations.sort((a, b) => b.updatedAt - a.updatedAt);
        const dits = catalog.filter((e) => e.role === 'dit');
        const persisted = loadPersistedDit();
        const selected =
          dits.find((e) => e.filename === persisted && e.exists)?.filename ??
          dits.find((e) => e.exists)?.filename ??
          dits[0]?.filename ??
          null;
        set({
          creations,
          catalog: dits,
          engineStatus: status,
          agentModels: models,
          selectedDit: selected,
          loaded: true,
          activeId: get().activeId ?? creations[0]?.id ?? null,
        });
        // Product rule: a selected-but-missing model auto-downloads its bundle.
        const entry = dits.find((e) => e.filename === selected);
        if (entry && !entry.exists) void get().downloadModel(entry.filename);
      } catch (e) {
        log.error('initialize failed:', e);
        set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
      }
    },

    refreshStatus: async () => {
      try {
        const status = await aceStepService.getStatus();
        set({ engineStatus: status });
      } catch {
        // status probe failure is non-fatal.
      }
    },

    refreshCatalog: async () => {
      try {
        const all = await aceStepService.listCatalog();
        set({ catalog: all.filter((e) => e.role === 'dit') });
      } catch {
        // ignore
      }
    },

    selectModel: (filename) => {
      const entry = get().catalog.find((e) => e.filename === filename);
      if (!entry || !entry.exists) return;
      persistDit(filename);
      set({ selectedDit: filename });
    },

    downloadModel: async (filename) => {
      const entry = get().catalog.find((e) => e.filename === filename);
      if (!entry) return;
      const presetId = presetIdForDit(entry);
      if (!presetId) return;
      if (get().downloadTasks.length > 0) return; // one bundle at a time
      try {
        const ids = await aceStepService.downloadPreset(presetId);
        set({ downloadTasks: ids, downloadProgress: {} });
        // Box the timer so `tick` can clear it without use-before-define.
        const poll = { timer: undefined as ReturnType<typeof setInterval> | undefined };
        const tick = async (): Promise<void> => {
          const tasks = get().downloadTasks;
          if (tasks.length === 0) {
            if (poll.timer) clearInterval(poll.timer);
            return;
          }
          const updates: Record<string, AceStepDownloadProgress> = {};
          const still: string[] = [];
          for (const taskId of tasks) {
            try {
              const p = await aceStepService.getDownloadProgress(taskId);
              if (p) {
                updates[taskId] = p;
                if (p.status === 'Downloading' || p.status === 'Pending') still.push(taskId);
              }
            } catch {
              // ignore
            }
          }
          set({ downloadProgress: updates, downloadTasks: still });
          if (still.length < tasks.length) await get().refreshCatalog();
          if (still.length === 0 && poll.timer) clearInterval(poll.timer);
        };
        poll.timer = setInterval(() => {
          void tick();
        }, 1500);
      } catch (e) {
        log.warn('model download failed:', e);
        set({ error: String(e) });
      }
    },

    ensureEngineLoaded: async () => {
      const selected = get().selectedDit;
      const entry = get().catalog.find((e) => e.filename === selected);
      if (!selected || !entry) throw new Error('NO_MODEL');
      if (get().downloadTasks.length > 0) throw new Error('MODEL_DOWNLOADING');
      if (!entry.exists) {
        // Auto-download kicks in; the caller surfaces the friendly signal.
        void get().downloadModel(selected);
        throw new Error('MODEL_DOWNLOADING');
      }
      const status = get().engineStatus;
      if (status?.synthLoaded && get().loadedDit === selected) return;
      set({ engineBusy: true });
      try {
        if (status?.synthLoaded && get().loadedDit !== selected) {
          await aceStepService.unload();
        }
        const all = await aceStepService.listCatalog();
        const pick = (role: string): string => {
          const found = all.find((e) => e.role === role && e.exists);
          if (!found) throw new Error(`MISSING_MODEL_${role}`);
          return found.localPath;
        };
        await aceStepService.loadSynth({
          textEncoderPath: pick('text_encoder'),
          ditPath: entry.localPath,
          vaePath: pick('vae'),
        });
        set({ loadedDit: selected });
        await get().refreshStatus();
        log.info('Synth loaded with DiT:', selected);
      } finally {
        set({ engineBusy: false });
      }
    },

    selectCreation: (id: string) => set({ activeId: id, error: null }),

    createCreation: async (type, opts) => {
      const count = get().creations.filter((c) => c.type === type).length + 1;
      const defaultTitle =
        type === 'quick'
          ? `快捷创作 ${count}`
          : type === 'track'
            ? `分轨创作 ${count}`
            : opts?.remixMode === 'repaint'
              ? `局部重绘 ${count}`
              : `改歌 ${count}`;
      const creation = createCreation(type, defaultTitle, opts?.remixMode);
      set((s) => ({ creations: [creation, ...s.creations], activeId: creation.id }));
      persist(creation);
      return creation;
    },

    deleteCreation: async (id) => {
      const cr = get().creations.find((c) => c.id === id);
      if (!cr) return;
      for (const t of cr.tracks) {
        if (t.stemPath) audioEngine.dropBuffer(t.stemPath);
      }
      set((s) => ({
        creations: s.creations.filter((c) => c.id !== id),
        activeId: s.activeId === id ? (s.creations.find((c) => c.id !== id)?.id ?? null) : s.activeId,
      }));
      try {
        await aceStepService.sessionDelete(id);
      } catch (e) {
        log.warn('session delete failed:', e);
      }
    },

    renameCreation: (id, title) => touch(id, { title }),

    patchCreation: (id, patch) => touch(id, patch),

    patchParams: (id, patch) => {
      const cr = get().creations.find((c) => c.id === id);
      if (!cr) return;
      touch(id, { params: { ...cr.params, ...patch } });
    },

    patchRemixParams: (id, patch) => {
      const cr = get().creations.find((c) => c.id === id);
      if (!cr?.remixParams) return;
      touch(id, { remixParams: { ...cr.remixParams, ...patch } });
    },

    sendToRemix: async (source, mode) => {
      // 作品页/样例卡可能先于创作分区挂载：initialize 幂等，确保 store 就绪。
      await get().initialize();
      const creation = await get().createCreation('remix', { remixMode: mode });
      get().patchRemixParams(creation.id, {
        sourcePath: source.path,
        sourceName: source.name,
        sourceDurationSec: source.durationSeconds ?? 0,
        mode,
      });
      get().selectCreation(creation.id);
      log.info(`sendToRemix: ${source.name} → ${mode} ${creation.id}`);
    },

    acceptStyleOptimization: (id, caption, captionZh, durationSec) => {
      const cr = get().creations.find((c) => c.id === id);
      if (!cr) return;
      touch(id, {
        optimizedCaption: caption,
        optimizedCaptionZh: captionZh,
        params: {
          ...cr.params,
          // AI 建议的时长吸附到最近档位（70s → 60/90），保证下拉可选中。
          durationSec: durationSec > 0 ? snapDuration(durationSec) : cr.params.durationSec,
        },
      });
    },

    clearStyleOptimization: (id) =>
      touch(id, { optimizedCaption: undefined, optimizedCaptionZh: undefined }),

    generateQuick: async (id) => {
      const cr = get().creations.find((c) => c.id === id);
      if (!cr || cr.generating) return;
      // 送模型的必须是英文标准 caption（AI 优化产物）；中文描述只是优化输入。
      const caption = cr.optimizedCaption?.trim();
      if (!caption) {
        set({ error: 'NEED_STYLE' });
        return;
      }
      // 生成数量：引擎是单管线（不支持并发）→ 串发逐首产出，数量 clamp 1-4。
      const total = Math.min(Math.max(cr.params.generateCount ?? 1, 1), 4);
      set({ error: null });
      await runSampleSeries(id, total, (current) => {
        const req = createDefaultAceRequest();
        req.caption = current.optimizedCaption?.trim() ?? '';
        req.lyrics = current.params.instrumental
          ? '[Instrumental]'
          : serializeLyrics(current.lyricsSegments.filter((s) => s.lines.length > 0));
        req.task_type = 'text2music';
        // auto = 按歌词行数计算（引擎 auto 只有 ~30s）
        req.duration =
          current.params.durationSec > 0
            ? current.params.durationSec
            : estimateDurationSec(current.lyricsSegments, current.params.instrumental);
        if (!current.params.instrumental) {
          req.vocal_language = current.params.vocalLanguage || detectLanguage(req.lyrics);
        }
        req.lm_mode = 'format';
        req.use_cot_caption = false;
        req.inference_steps = BASE_STEPS;
        req.shift = BASE_SHIFT;
        req.guidance_scale = BASE_GUIDANCE;
        // 每首独立 seed：多首样品互不重复
        req.seed = randomSeed();
        return { req, refAudioPath: current.params.refAudioPath || undefined };
      });
    },

    generateRemix: async (id) => {
      const cr = get().creations.find((c) => c.id === id);
      const rp = cr?.remixParams;
      if (!cr || !rp || cr.generating) return;
      if (!rp.sourcePath) {
        set({ error: 'NO_SOURCE' });
        return;
      }
      const total = Math.min(Math.max(cr.params.generateCount ?? 1, 1), 4);
      set({ error: null });
      await runSampleSeries(id, total, (current) => {
        const params = current.remixParams;
        const req = createDefaultAceRequest();
        // caption 可选（引擎对 cover/repaint 直传 DiT），但官方实践 caption 是风格主控。
        req.caption = current.optimizedCaption?.trim() ?? '';
        req.lyrics = current.params.instrumental
          ? '[Instrumental]'
          : serializeLyrics(current.lyricsSegments.filter((s) => s.lines.length > 0));
        req.task_type =
          params?.mode === 'nofsq' ? 'cover-nofsq' : params?.mode === 'repaint' ? 'repaint' : 'cover';
        const strength = Math.min(Math.max(params?.coverStrength ?? 1.0, 0), 1);
        req.audio_cover_strength = strength;
        if (params?.mode === 'repaint') {
          req.repainting_start = params.repaintStart;
          req.repainting_end = params.repaintEnd;
        }
        if (!current.params.instrumental && req.lyrics) {
          req.vocal_language = current.params.vocalLanguage || detectLanguage(req.lyrics);
        }
        req.lm_mode = 'format';
        req.use_cot_caption = false;
        req.inference_steps = BASE_STEPS;
        req.shift = BASE_SHIFT;
        req.guidance_scale = BASE_GUIDANCE;
        req.seed = randomSeed();
        return {
          req,
          srcAudioPath: params?.sourcePath,
          // 官方建议：忠实重混（nofsq）用 ref=src 保音色贴近原曲；用户显式选的参考音色优先。
          refAudioPath:
            current.params.refAudioPath ||
            (params?.mode === 'nofsq' ? params.sourcePath : undefined),
        };
      });
    },

    regenerateSample: async (id, sampleId) => {
      const cr = get().creations.find((c) => c.id === id);
      const req = lastRequests.get(sampleId);
      if (!cr || !req || cr.generating) return;
      touch(id, { generating: true });
      try {
        await get().ensureEngineLoaded();
        const next: AceRequest = { ...req, seed: randomSeed() };
        // ref/src 路径取创作当前值（lastRequests 只存 AceRequest，不含文件路径）：
        // 参考音色跟随 quick/cremix 现值；nofsq 无显式参考时保持 ref=src 官方建议。
        const refAudioPath =
          cr.params.refAudioPath ||
          (next.task_type === 'cover-nofsq' ? cr.remixParams?.sourcePath : undefined);
        const result = await aceStepService.generate({
          request: next,
          srcAudioPath: cr.remixParams?.sourcePath || undefined,
          refAudioPath: refAudioPath || undefined,
        });
        const sample: CreationSample = {
          id: newId('sm'),
          audioPath: result.outputPath,
          durationSeconds: result.durationSeconds,
          createdAt: Date.now(),
          inLibrary: false,
        };
        lastRequests.set(sample.id, next);
        const fresh = get().creations.find((c) => c.id === id);
        if (fresh) touch(id, { samples: [sample, ...fresh.samples], generating: false });
        // 换一版完成：后台自动打分 + 歌词对齐
        void enrichSample(id, sample.id, result.outputPath, next.lyrics, next.vocal_language || '');
      } catch (e) {
        log.error('regenerateSample failed:', e);
        set({ error: e instanceof Error ? e.message : String(e) });
        touch(id, { generating: false });
      } finally {
        try {
          await aceStepService.unload();
          await get().refreshStatus();
        } catch {
          // ignore.
        }
      }
    },

    saveSampleToLibrary: async (id, sampleId, meta) => {
      const cr = get().creations.find((c) => c.id === id);
      const sample = cr?.samples.find((s) => s.id === sampleId);
      if (!cr || !sample) return null;
      try {
        // 歌词与评分在生成完成时已自动做好（sample.lrc / sample.score）
        const plainLyrics =
          (cr.type === 'quick' || cr.type === 'remix') &&
          !cr.params.instrumental &&
          cr.lyricsSegments.length > 0
            ? serializeLyrics(cr.lyricsSegments)
            : undefined;
        const [machineId, deviceName, authInfo] = await Promise.all([
          api.invoke<string>('get_machine_id').catch(() => ''),
          api.invoke<string>('get_device_name').catch(() => ''),
          api
            .invoke<{ member_id?: string; username?: string } | null>('get_auth_info')
            .catch(() => null),
        ]);
        const result = await aceStepService.packageSong({
          audioPath: sample.audioPath,
          lyrics: sample.lrc ?? plainLyrics ?? null,
          coverPath: meta?.coverPath ?? null,
          song: {
            title: meta?.title || cr.title,
            artist: meta?.artist,
            mode: cr.type === 'track' ? 'lego' : 'text2music',
            lyricsLanguage: cr.params.instrumental ? undefined : cr.params.vocalLanguage || undefined,
            score: sample.score,
          },
          creationPlan: {
            caption: cr.optimizedCaption ?? cr.styleInput,
            lyrics: plainLyrics ?? '',
          },
          internal: {
            machineId,
            deviceName,
            userId: authInfo?.member_id?.toString() ?? '',
            userName: authInfo?.username ?? '',
            sessionId: cr.id,
          },
        });
        updateSample(id, sampleId, { inLibrary: true });
        return result;
      } catch (e) {
        log.error('saveSampleToLibrary failed:', e);
        set({ error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },

    deleteSample: (id, sampleId) => {
      const cr = get().creations.find((c) => c.id === id);
      if (!cr) return;
      lastRequests.delete(sampleId);
      touch(id, { samples: cr.samples.filter((s) => s.id !== sampleId) });
    },

    addTrack: async (id, kind, name, prompt, lyrics, vocalLanguage) => {
      const trackId = newId('tr');
      const track: CreationTrack = {
        id: trackId,
        kind,
        name,
        prompt,
        lyrics,
        vocalLanguage,
        gainDb: 0,
        muted: false,
        solo: false,
        status: 'empty',
      };
      const cr = get().creations.find((c) => c.id === id);
      if (!cr) return trackId;
      touch(id, { tracks: [...cr.tracks, track] });
      return trackId;
    },

    generateTrack: async (id, trackId) => {
      await runTrackGeneration(set, get, touch, id, trackId, { useOriginalBase: false });
    },

    regenerateTrack: async (id, trackId) => {
      await runTrackGeneration(set, get, touch, id, trackId, { useOriginalBase: true });
    },

    updateTrack: (id, trackId, patch) => {
      const cr = get().creations.find((c) => c.id === id);
      if (!cr) return;
      touch(id, {
        tracks: cr.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
      });
    },

    removeTrack: (id, trackId) => {
      const cr = get().creations.find((c) => c.id === id);
      if (!cr) return;
      const track = cr.tracks.find((t) => t.id === trackId);
      if (track?.stemPath) audioEngine.dropBuffer(track.stemPath);
      touch(id, { tracks: cr.tracks.filter((t) => t.id !== trackId) });
    },

    exportMix: async (id) => {
      const cr = get().creations.find((c) => c.id === id);
      if (!cr) return null;
      const ready = cr.tracks
        .filter((t) => t.status === 'ready' && t.stemPath)
        .map((t) => ({
          trackId: t.id,
          stemPath: t.stemPath as string,
          gainDb: t.gainDb,
          muted: t.muted,
          solo: t.solo,
        }));
      if (ready.length === 0) {
        set({ error: 'NOTHING_TO_EXPORT' });
        return null;
      }
      try {
        const wav = await audioEngine.renderMixToWav(ready);
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        const { save } = await import('@tauri-apps/plugin-dialog');
        const target = await save({
          title: '导出成品',
          defaultPath: `${cr.title}.wav`,
          filters: [{ name: 'WAV', extensions: ['wav'] }],
        });
        if (!target) return null;
        await writeFile(target, wav);
        return target;
      } catch (e) {
        log.error('exportMix failed:', e);
        set({ error: e instanceof Error ? e.message : String(e) });
        return null;
      }
    },
  };
});

/** Latest generated track whose mix conditions the next lego layer. */
function conditioningTrack(tracks: CreationTrack[], excludeTrackId?: string): CreationTrack | null {
  const ready = tracks.filter(
    (t) => t.status === 'ready' && t.mixPath && t.id !== excludeTrackId,
  );
  return ready.length > 0 ? ready[ready.length - 1] : null;
}

/**
 * 生成完成后的自动增强（后台执行，不阻塞 UI）：
 * 歌曲打分（客观音质指标）+ 歌词 LRC 对齐（逐字时间戳），写回样例。
 * 对齐器模型未就绪时降级跳过（仅记日志，打包时回退纯文本歌词）。
 */
async function enrichSample(
  id: string,
  sampleId: string,
  audioPath: string,
  lyrics: string | undefined,
  vocalLanguage: string,
): Promise<void> {
  const write = (patch: { score?: CreationSample['score']; lrc?: string }) => {
    const state = useCreateStore.getState();
    const cr = state.creations.find((c) => c.id === id);
    if (!cr) return;
    useCreateStore.setState({
      creations: state.creations.map((c) =>
        c.id === id
          ? {
              ...c,
              updatedAt: Date.now(),
              samples: c.samples.map((s) => (s.id === sampleId ? { ...s, ...patch } : s)),
            }
          : c,
      ),
    });
    const updated = useCreateStore.getState().creations.find((c) => c.id === id);
    if (updated) {
      const requests: Record<string, AceRequest> = {};
      for (const s of updated.samples) {
        const rr = lastRequests.get(s.id);
        if (rr) requests[s.id] = rr;
      }
      aceStepService
        .sessionSave(creationToSession(updated, requests))
        .catch((e) => log.warn('session save failed:', e));
    }
  };
  try {
    const score = await aceStepService.scoreSong(audioPath);
    write({ score });
  } catch (e) {
    log.warn('scoreSong failed:', e);
  }
  if (lyrics && lyrics.trim() && lyrics.trim() !== '[Instrumental]') {
    try {
      const aligned = await aceStepService.alignLyrics({
        audioPath,
        lyrics,
        language: vocalLanguage || undefined,
      });
      write({ lrc: aligned.lrc });
    } catch (e) {
      log.warn('alignLyrics failed (packaging will fall back to plain lyrics):', e);
    }
  }
}

/** Shared body for generateTrack / regenerateTrack. */
async function runTrackGeneration(
  setState: (partial: Partial<CreateStoreState>) => void,
  getState: () => CreateStoreState,
  touch: (id: string, patch: Partial<Creation>) => void,
  id: string,
  trackId: string,
  opts: { useOriginalBase: boolean },
): Promise<void> {
  const cr = getState().creations.find((c) => c.id === id);
  const track = cr?.tracks.find((t) => t.id === trackId);
  if (!cr || !track || getState().generatingTrackId) return;

  const isBase = track.kind === 'base';
  const caption = track.prompt.trim();
  if (!caption) {
    setState({ error: 'NEED_TRACK_PROMPT' });
    return;
  }

  getState().updateTrack(id, trackId, { status: 'generating', error: undefined });
  setState({ generatingTrackId: trackId, error: null });
  try {
    await getState().ensureEngineLoaded();
    const req = createDefaultAceRequest();
    req.caption = caption;
    req.lyrics = track.lyrics || '[Instrumental]';
    req.task_type = isBase ? 'text2music' : 'lego';
    if (!isBase) req.track = track.kind === 'custom' ? 'other' : track.kind;
    // auto = 按歌词行数计算（基底轨无人声时按纯音乐 90s 兜底）
    req.duration =
      isBase && cr.params.durationSec > 0
        ? cr.params.durationSec
        : estimateDurationSec(
            track.lyrics ? [{ lines: track.lyrics.split(/\r?\n/) }] : [],
            track.lyrics === '[Instrumental]',
          );
    if (track.lyrics && track.lyrics !== '[Instrumental]') {
      req.vocal_language = track.vocalLanguage || detectLanguage(track.lyrics);
    }
    req.lm_mode = 'format';
    req.use_cot_caption = false;
    req.inference_steps = BASE_STEPS;
    req.shift = BASE_SHIFT;
    req.guidance_scale = BASE_GUIDANCE;
    req.seed = randomSeed();

    const genRequest: Parameters<typeof aceStepService.generate>[0] = { request: req };
    if (!isBase) {
      let srcPath: string | undefined;
      if (opts.useOriginalBase && track.baseAtGen) {
        srcPath = track.baseAtGen;
      } else {
        const latest = getState().creations.find((c) => c.id === id);
        const base = conditioningTrack(latest?.tracks ?? [], trackId);
        if (!base?.mixPath) throw new Error('NEED_BASE_TRACK');
        srcPath = base.mixPath;
      }
      if (!srcPath) throw new Error('NEED_BASE_TRACK');
      genRequest.srcAudioPath = srcPath;
    }
    const result = await aceStepService.generate(genRequest);
    getState().updateTrack(id, trackId, {
      status: 'ready',
      stemPath: result.stemPath ?? result.outputPath,
      mixPath: result.outputPath,
      baseAtGen: isBase ? undefined : genRequest.srcAudioPath,
    });
    // The full mix also lands in the creation's sample group (成品预览).
    const fresh = getState().creations.find((c) => c.id === id);
    if (fresh) {
      const sample: CreationSample = {
        id: newId('sm'),
        audioPath: result.outputPath,
        durationSeconds: result.durationSeconds,
        createdAt: Date.now(),
        inLibrary: false,
      };
      lastRequests.set(sample.id, req);
      touch(id, { samples: [sample, ...fresh.samples] });
      // 生成完成：后台自动打分 + 歌词对齐
      void enrichSample(id, sample.id, result.outputPath, req.lyrics, req.vocal_language || '');
    }
  } catch (e) {
    log.error('track generation failed:', e);
    const message = e instanceof Error ? e.message : String(e);
    getState().updateTrack(id, trackId, { status: 'error', error: message });
    setState({ error: message });
  } finally {
    setState({ generatingTrackId: null });
    try {
      await aceStepService.unload();
      await getState().refreshStatus();
    } catch {
      // ignore.
    }
  }
}
