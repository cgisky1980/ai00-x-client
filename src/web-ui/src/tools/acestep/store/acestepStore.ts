/**
 * AceStep Zustand store — multi-session with disk persistence.
 *
 * Each session owns its own chatMessages, creationPlan, and outputs.
 * Sessions are persisted as JSON under {RUNTIME_DIR}/acestep-sessions/.
 */

import { create } from 'zustand';
import { aceStepService } from '../services/AceStepService';
import { CREATION_ADVISOR_SYSTEM_PROMPT } from '../prompts/creationAdvisor';
import {
  LEGO_ADVISOR_SYSTEM_PROMPT,
  buildLegoContextSummary,
} from '../prompts/legoAdvisor';
import {
  LYRICS_WRITER_SYSTEM_PROMPT,
  buildLyricsWriterPrompt,
} from '../prompts/lyricsWriter';
import {
  STYLE_ADVISOR_SYSTEM_PROMPT,
  buildStyleAdvisorPrompt,
} from '../prompts/styleAdvisor';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import type {
  AceRequest,
  AceStepAlignLyricsResult,
  AceStepChatMessage,
  AceStepGenerateRequest,
  AceStepGenerateResult,
  AceStepLocalModel,
  AceStepProgressEvent,
  AceStepSession,
  AceStepSessionData,
  AceStepSessionMeta,
  AceStepStatus,
  ChatMessage,
  CreationPlan,
  GeneratedAudio,
  LegoFlowState,
  LegoStepPlan,
  PackageDialogOptions,
  PackageSongRequest,
  PackageSongResult,
  SessionMode,
} from '../types';
import { createDefaultAceRequest } from '../types';

/**
 * Minimal shape of the Rust `AuthInfo` struct (mirrors
 * `src/apps/desktop/src/auth.rs::AuthInfo`). Defined locally to avoid
 * cross-module coupling with SystemAPI.ts.
 */
interface AuthInfo {
  username: string;
  token: string;
  logged_at: number;
  plan_tier?: string | null;
  member_id?: number | null;
  refresh_token?: string | null;
}

export type GenerationState = 'idle' | 'loading-models' | 'generating' | 'error';

/** Session-scoped id for LLM streaming events (regenerated on each switch). */
let chatStreamSessionId = `acestep-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Debounced save timer. */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Generate a unique message id. */
function newMsgId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Generate a unique session id. */
function newSessionId(): string {
  return `acestep-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Determine the preset id to download for a given DiT filename.
 * Maps a DiT variant to its preset bundle (text encoder + DiT + VAE).
 */
function presetIdForDiTFilename(filename: string): string {
  const isXl = filename.includes('xl');
  const isQ8 = filename.includes('Q8');
  const family = isXl ? 'xl-base' : 'base';
  const quant = isQ8 ? 'q8' : 'q5';
  return `${family}-${quant}`;
}

/**
 * Wait (polling) until all given download tasks reach a terminal state.
 * Resolves when every task is Completed. Throws if any task Failed.
 */
async function waitForDownloads(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const results = await Promise.all(
      taskIds.map((id) => aceStepService.getDownloadProgress(id)),
    );
    const done = results.filter((p) => p && p.status !== 'Downloading' && p.status !== 'Pending');
    if (done.length === taskIds.length) {
      const failed = done.filter((p) => p!.status === 'Failed');
      if (failed.length > 0) {
        throw new Error(
          `Model download failed: ${failed.map((p) => p!.error ?? 'unknown error').join('; ')}`,
        );
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Ensure the synth (text encoder + DiT + VAE) models are present on disk.
 * If any are missing, auto-downloads the full bundle for the preferred DiT
 * (falls back to a recommended 2B/4B preset) and waits for completion.
 * Returns the resolved file paths.
 */
async function ensureSynthModels(): Promise<{
  textEncoderPath: string;
  ditPath: string;
  vaePath: string;
}> {
  const models = await aceStepService.listLocalModels();
  const pick = (role: string) => models.find((m) => m.role === role && m.exists);
  const te = pick('text_encoder');
  const vae = pick('vae');
  const selectedFilename = (() => {
    try {
      return localStorage.getItem('acestep-selected-dit');
    } catch {
      return null;
    }
  })();
  const dit =
    (selectedFilename
      ? models.find(
          (m) => m.role === 'dit' && m.exists && m.filename === selectedFilename,
        )
      : undefined) ?? pick('dit');

  if (te && dit && vae) {
    return {
      textEncoderPath: te.localPath,
      ditPath: dit.localPath,
      vaePath: vae.localPath,
    };
  }

  // Missing something — auto-download the full bundle.
  const preferredFilename =
    selectedFilename ??
    models.find((m) => m.role === 'dit')?.filename ??
    'acestep-v15-base-Q8_0.gguf';
  const presetId = presetIdForDiTFilename(preferredFilename);
  const ids = await aceStepService.downloadPreset(presetId);
  await waitForDownloads(ids);

  // Re-resolve after download.
  const refreshed = await aceStepService.listLocalModels();
  const rpick = (role: string) => refreshed.find((m) => m.role === role && m.exists);
  const rte = rpick('text_encoder');
  const rvae = rpick('vae');
  const rdit =
    (selectedFilename
      ? refreshed.find(
          (m) => m.role === 'dit' && m.exists && m.filename === selectedFilename,
        )
      : undefined) ?? rpick('dit');
  if (!rte || !rdit || !rvae) {
    throw new Error('Missing model files. Model download did not complete.');
  }
  return {
    textEncoderPath: rte.localPath,
    ditPath: rdit.localPath,
    vaePath: rvae.localPath,
  };
}

/**
 * Try to extract a CreationPlan JSON from an assistant message.
 *
 * Handles three cases:
 * 1. Pure JSON (possibly wrapped in ```json ... ``` fences).
 * 2. JSON embedded in prose (find first `{` ... last `}`).
 * 3. No valid JSON — returns null.
 */
function tryParsePlan(text: string): CreationPlan | null {
  if (!text || !text.includes('{')) return null;

  // 1. Try ```json ... ``` or ``` ... ``` fenced block.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : null;

  /**
   * Remove invalid JSON escape sequences.
   * LLMs sometimes emit escapes like `\�` or `\x` that are not valid JSON.
   * Valid JSON escapes: \" \\ \/ \b \f \n \r \t \uXXXX
   */
  const sanitize = (s: string): string =>
    s.replace(/\\(?!["\\/bfnrtu])/g, '');

  const buildPlan = (obj: Record<string, unknown>): CreationPlan | null => {
    // Validate required fields. Force task_type to text2music (chat flow
    // only supports new-song generation; the LLM may emit other modes).
    if (typeof obj.task_type === 'string' && typeof obj.caption === 'string') {
      // The LLM sometimes misspells "lyrics" as "lyrs", "lyric", or
      // "lyrics_text". Accept any of these as the lyrics field.
      const lyrics =
        (obj.lyrics as string) ??
        (obj.lyrs as string) ??
        (obj.lyric as string) ??
        (obj.lyrics_text as string) ??
        '';
      return {
        task_type: 'text2music',
        caption: obj.caption as string,
        lyrics,
        bpm: typeof obj.bpm === 'number' ? obj.bpm : 0,
        duration: typeof obj.duration === 'number' ? obj.duration : 0,
        keyscale: (obj.keyscale as string) ?? '',
        timesignature: (obj.timesignature as string) ?? '',
        vocal_language: (obj.vocal_language as string) ?? '',
        reasoning: (obj.reasoning as string) ?? '',
      };
    }
    return null;
  };

  const tryParse = (s: string): CreationPlan | null => {
    // First attempt: raw parse.
    try {
      return buildPlan(JSON.parse(s) as Record<string, unknown>);
    } catch {
      // fall through to sanitized attempt
    }
    // Second attempt: strip invalid escapes and retry.
    try {
      return buildPlan(JSON.parse(sanitize(s)) as Record<string, unknown>);
    } catch {
      // fall through
    }
    // Third attempt: escape raw control chars (real newlines/tabs) that the
    // LLM left inside string values — e.g. multi-line `lyrics`/`existing_lyrics`
    // fields. JSON.parse throws "Bad control character" otherwise, so the plan
    // is never extracted and no plan/subagent runs.
    try {
      return buildPlan(
        JSON.parse(escapeControlCharsInStrings(s)) as Record<string, unknown>,
      );
    } catch {
      // fall through
    }
    // Fourth attempt: repair common LLM JSON errors (e.g. `]` instead of
    // `}`) and retry. This is the fix for the "write_lyrics JSON stored
    // as raw text" bug — the LLM closes the object with `]` after an
    // array-valued field, so extractJsonBlocks can't find a balanced
    // `{...}` block and parsing fails.
    try {
      return buildPlan(JSON.parse(repairJson(s)) as Record<string, unknown>);
    } catch {
      // fall through
    }
    // Fifth attempt: sanitize + repair.
    try {
      return buildPlan(
        JSON.parse(repairJson(sanitize(s))) as Record<string, unknown>,
      );
    } catch {
      // fall through
    }
    return null;
  };

  if (candidate) {
    const plan = tryParse(candidate);
    if (plan) return plan;
  }

  // 2. Extract all balanced {...} blocks and try each one (reverse order).
  const blocks = extractJsonBlocks(text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const plan = tryParse(blocks[i]);
    if (plan) return plan;
  }

  // 3. Fallback: if no balanced blocks were found but the text starts with
  //    `{`, try parsing the entire text. This handles the case where the
  //    LLM closes the object with `]` instead of `}` — extractJsonBlocks
  //    can't find a matching `}` so it returns nothing, but repairJson
  //    can fix the trailing `]` → `}` and recover the JSON.
  if (blocks.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const plan = tryParse(trimmed);
      if (plan) return plan;
    }
  }

  return null;
}

/**
 * Extract all top-level `{...}` blocks from a string using brace matching.
 *
 * This handles the common case where the LLM outputs reasoning text
 * interspersed with JSON objects (sometimes repeating the same JSON multiple
 * times). A naive "first `{` to last `}`" approach would capture the
 * reasoning text in between, producing invalid JSON. Instead, we track brace
 * depth and extract each balanced `{...}` block individually.
 *
 * Blocks are returned in order of appearance. Callers that want the "final"
 * answer (LLMs often repeat the answer at the end) should iterate in reverse.
 */
function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Track string state so braces inside strings don't affect depth.
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          blocks.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  return blocks;
}

/**
 * Escape raw control characters (newline / carriage-return / tab) that the
 * LLM left INSIDE JSON string values, converting them to valid escape
 * sequences (`\n` / `\r` / `\t`).
 *
 * Why needed: the LLM often emits multi-line fields such as `lyrics` or
 * `existing_lyrics` with REAL newline characters instead of escaped `\n`.
 * JSON spec forbids raw control characters inside strings, so `JSON.parse`
 * throws "Bad control character in string literal" — and the whole action
 * (write_lyrics / write_style) fails to be detected. This mirrors what was
 * observed in production: the user clicks "确认歌词OK，生成其他参数" but the
 * style subagent never runs because the write_style JSON can't be parsed.
 *
 * The function tracks in-string state (respecting `\"` escapes) so it only
 * escapes control chars inside string values, leaving structural whitespace
 * between JSON tokens untouched.
 */
function escapeControlCharsInStrings(s: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (inString && ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && (ch === '\n' || ch === '\r' || ch === '\t')) {
      result += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
      continue;
    }
    result += ch;
  }
  return result;
}

/**
 * Attempt to repair common LLM JSON syntax errors so that `JSON.parse`
 * can succeed.
 *
 * Handles the following mistakes (observed in production):
 * 1. Object closed with `]` instead of `}` — VERY common when the LLM
 *    has just emitted an array-valued field like `existing_lyrics` and
 *    mistakenly closes the outer object with `]`.
 * 2. Array closed with `}` instead of `]` (less common, mirror case).
 * 3. Trailing comma before the closing brace/bracket.
 * 4. Missing closing brace/bracket entirely.
 *
 * The function is intentionally conservative — it only touches the
 * trailing character(s) and trailing commas, so it won't corrupt
 * valid JSON. It is used as a LAST-RESORT fallback after raw parse
 * and sanitize+parse have both failed.
 */
function repairJson(s: string): string {
  let repaired = s.trim();

  // 1. Remove trailing comma before closing brace/bracket.
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  // 2. Object closed with `]` instead of `}`.
  //    Check AFTER comma removal so ",]" → "}" (not "],").
  if (repaired.startsWith('{') && repaired.endsWith(']')) {
    repaired = repaired.slice(0, -1) + '}';
  }

  // 3. Array closed with `}` instead of `]`.
  if (repaired.startsWith('[') && repaired.endsWith('}')) {
    repaired = repaired.slice(0, -1) + ']';
  }

  // 4. Missing closing brace/bracket — append one matching the opener.
  if (
    repaired.startsWith('{') &&
    !repaired.endsWith('}') &&
    !repaired.endsWith(']')
  ) {
    repaired = repaired + '}';
  } else if (
    repaired.startsWith('[') &&
    !repaired.endsWith(']') &&
    !repaired.endsWith('}')
  ) {
    repaired = repaired + ']';
  }

  return repaired;
}

/**
 * Result of parsing a single Lego turn from the LLM.
 *  - 'step': the LLM proposed (or revised) one layer plan
 *  - 'complete': the LLM signalled the track is finished
 *  - 'ask': the LLM wants to ask the user a question with options
 *  - 'search': the LLM wants to search the web for background knowledge
 *  - 'write_lyrics': the LLM delegates lyrics writing to the lyrics subagent
 *  - null: no valid JSON could be extracted
 */
type LegoStepParseResult =
  | { type: 'step'; plan: LegoStepPlan }
  | { type: 'complete'; reasoning: string }
  | { type: 'ask'; question: string; options: string[] }
  | { type: 'search'; query: string; reason: string }
  | { type: 'write_lyrics'; brief: string; caption: string; language: string; existingLyrics: string }
  | { type: 'write_style'; brief: string; lyrics: string; language: string }
  | null;

/**
 * Try to extract a single-step Lego plan, "complete" signal, "ask"
 * question, or "search" request from an assistant message.
 *
 * The LLM is expected to return ONE of these JSON shapes:
 *   {"track":"drums","caption":"...","lyrics":"...","reasoning":"...","duration":0}
 *   {"action":"complete","reasoning":"..."}
 *   {"action":"ask","question":"...","options":["...","..."]}
 *   {"action":"search","query":"...","reason":"..."}
 *
 * Reuses the same sanitization strategy as tryParsePlan to handle invalid
 * JSON escape sequences. Returns null if no valid JSON is found.
 */
function tryParseLegoStep(text: string): LegoStepParseResult {
  if (!text || !text.includes('{')) return null;

  // 1. Try ```json ... ``` or ``` ... ``` fenced block.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : null;

  /**
   * Remove invalid JSON escape sequences (same rule as tryParsePlan).
   * Valid JSON escapes: \" \\ \/ \b \f \n \r \t \uXXXX
   */
  const sanitize = (s: string): string =>
    s.replace(/\\(?!["\\/bfnrtu])/g, '');

  const build = (obj: unknown): LegoStepParseResult => {
    if (!obj || typeof obj !== 'object') return null;
    const root = obj as Record<string, unknown>;

    // "complete" signal.
    if (root.action === 'complete') {
      const reasoning =
        typeof root.reasoning === 'string' ? root.reasoning : '';
      return { type: 'complete', reasoning };
    }

    // "ask" action — LLM wants to ask the user a question with options.
    // If the LLM forgot the "options" field, provide sensible defaults so
    // the ask flow still works (the LLM frequently omits options when
    // presenting lyrics for review).
    if (root.action === 'ask') {
      const question =
        typeof root.question === 'string' ? root.question : '';
      const rawOptions = Array.isArray(root.options) ? root.options : [];
      const options = rawOptions.filter(
        (o): o is string => typeof o === 'string' && o.length > 0,
      );
      if (question) {
        const finalOptions = options.length > 0
          ? options
          : ['歌词很好，生成', '需要修改歌词', '重新写一版'];
        return { type: 'ask', question, options: finalOptions };
      }
      return null;
    }

    // "search" action — LLM wants to search the web for background knowledge.
    if (root.action === 'search') {
      const query =
        typeof root.query === 'string' ? root.query : '';
      const reason =
        typeof root.reason === 'string' ? root.reason : '';
      if (query) {
        return { type: 'search', query, reason };
      }
      return null;
    }

    // "write_lyrics" action — LLM delegates lyrics writing/revising to the
    // specialized lyrics subagent for higher-quality results.
    if (root.action === 'write_lyrics') {
      const brief =
        typeof root.brief === 'string' ? root.brief : '';
      const caption =
        typeof root.caption === 'string' ? root.caption : '';
      const language =
        typeof root.language === 'string' ? root.language : 'zh';
      const existingLyrics =
        typeof root.existing_lyrics === 'string'
          ? root.existing_lyrics
          : (typeof root.lyrics === 'string' ? root.lyrics : '');
      if (brief) {
        return { type: 'write_lyrics', brief, caption, language, existingLyrics };
      }
      return null;
    }

    // "write_style" action — LLM delegates style design (caption / BPM / key
    // / duration / vocal_language) to the specialized style subagent. This
    // happens AFTER the user approves the lyrics. The subagent returns a
    // JSON object that the store plugs into creationPlan.
    if (root.action === 'write_style') {
      const brief =
        typeof root.brief === 'string' ? root.brief : '';
      const lyrics =
        typeof root.lyrics === 'string' ? root.lyrics : '';
      const language =
        typeof root.language === 'string' ? root.language : 'zh';
      if (brief || lyrics) {
        return { type: 'write_style', brief, lyrics, language };
      }
      return null;
    }

    // Fallback: LLM outputs batch format {"action":"plan","tracks":[...]}
    // even though the prompt says one-at-a-time. Extract the FIRST track as
    // the current step plan so the user isn't stuck.
    if (root.action === 'plan' && Array.isArray(root.tracks)) {
      const first = root.tracks[0];
      if (first && typeof first === 'object') {
        const t = first as Record<string, unknown>;
        const caption =
          typeof t.caption === 'string' ? t.caption : '';
        if (caption) {
          return {
            type: 'step',
            plan: {
              track: typeof t.track === 'string' ? t.track : '',
              caption,
              lyrics: typeof t.lyrics === 'string' ? t.lyrics : '',
              reasoning:
                typeof root.reasoning === 'string'
                  ? root.reasoning
                  : '',
              duration:
                typeof t.duration === 'number' ? t.duration : 0,
            },
          };
        }
      }
      return null;
    }

    // Single-step plan.
    const track = typeof root.track === 'string' ? root.track : '';
    const caption = typeof root.caption === 'string' ? root.caption : '';
    const lyrics = typeof root.lyrics === 'string' ? root.lyrics : '';
    const reasoning =
      typeof root.reasoning === 'string' ? root.reasoning : '';
    const duration =
      typeof root.duration === 'number' ? root.duration : 0;
    if (!caption) return null;
    return {
      type: 'step',
      plan: { track, caption, lyrics, reasoning, duration },
    };
  };

  const tryParse = (s: string): LegoStepParseResult => {
    // First attempt: raw parse.
    try {
      return build(JSON.parse(s));
    } catch {
      // fall through to sanitized attempt
    }
    // Second attempt: strip invalid escapes and retry.
    try {
      return build(JSON.parse(sanitize(s)));
    } catch {
      // fall through
    }
    // Third attempt: escape raw control chars (real newlines/tabs) that the
    // LLM left inside string values — e.g. multi-line `lyrics`/`existing_lyrics`
    // fields. This is the root cause of "write_style / write_lyrics emitted
    // but the subagent never executes": JSON.parse throws "Bad control
    // character" so the action is never detected and no plan/subagent runs.
    try {
      return build(JSON.parse(escapeControlCharsInStrings(s)));
    } catch {
      // fall through
    }
    // Fourth attempt: repair common LLM JSON errors (e.g. `]` instead of
    // `}`) and retry. This is the fix for the "调用歌词 subagent displayed
    // but never executed" bug — the LLM closes the write_lyrics object
    // with `]` after the existing_lyrics string field, so extractJsonBlocks
    // can't find a balanced `{...}` block and tryParseLegoStep returns null.
    // The subagent is never triggered and the raw JSON is stored as the
    // message content.
    try {
      return build(JSON.parse(repairJson(s)));
    } catch {
      // fall through
    }
    // Fifth attempt: sanitize + repair.
    try {
      return build(JSON.parse(repairJson(sanitize(s))));
    } catch {
      // fall through
    }
    return null;
  };

  if (candidate) {
    const result = tryParse(candidate);
    if (result) return result;
  }

  // 2. Extract all balanced {...} blocks and try each one.
  //    Iterate in reverse order — the LLM often repeats the final answer
  //    at the end after reasoning.
  const blocks = extractJsonBlocks(text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const result = tryParse(blocks[i]);
    if (result) return result;
  }

  // 3. Fallback: if no balanced blocks were found but the text starts with
  //    `{`, try parsing the entire text. This handles the case where the
  //    LLM closes the object with `]` instead of `}` — extractJsonBlocks
  //    can't find a matching `}` so it returns nothing, but repairJson
  //    can fix the trailing `]` → `}` and recover the JSON.
  if (blocks.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const result = tryParse(trimmed);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Extract the lyrics portion from an ask-question string.
 *
 * The LLM's ask question typically looks like:
 *   "我为你草拟了以下歌词，请评审：\n\n[Verse 1]\n歌词...\n\n[Chorus]\n歌词...\n\n你觉得如何？"
 *
 * This function extracts everything from the first structure tag (e.g.
 * [Verse 1], [Intro], [Chorus]) to the end, stripping any trailing
 * closing question like "你觉得如何？".
 *
 * Returns empty string if no structure tags are found (meaning the
 * question is not about lyrics review).
 */
function extractLyricsFromQuestion(question: string): string {
  if (!question) return '';

  // Find the first structure tag. ACE-Step structure tags include:
  // [Intro], [Verse], [Pre-Chorus], [Chorus], [Bridge], [Outro],
  // [Build], [Drop], [Breakdown], [Instrumental], [Guitar Solo],
  // [Piano Interlude], [Fade Out], [Silence], etc.
  const tagPattern =
    /\[(?:Intro|Verse|Pre-Chorus|Chorus|Bridge|Outro|Build|Drop|Breakdown|Instrumental|Guitar\s*Solo|Piano\s*Interlude|Fade\s*Out|Silence)[^\]]*\]/i;
  const match = question.match(tagPattern);
  if (!match || match.index === undefined) return '';

  const startIndex = match.index;
  let lyrics = question.slice(startIndex);

  // Strip trailing closing questions (Chinese & English variants).
  const closingPatterns = [
    /\n\s*你觉得.{0,15}[？?]\s*$/s,
    /\n\s*你觉得怎么样.*[？?]\s*$/s,
    /\n\s*你觉得如何.*[？?]\s*$/s,
    /\n\s*请评审.*$/s,
    /\n\s*What do you think.*\?\s*$/is,
  ];
  for (const pattern of closingPatterns) {
    lyrics = lyrics.replace(pattern, '');
  }

  return lyrics.trim();
}

/** Create a new empty session object. */
function createEmptySession(id: string, mode: SessionMode): AceStepSession {
  const now = Date.now();
  return {
    id,
    title: mode === 'lego' ? 'New Lego Session' : 'New Session',
    createdAt: now,
    updatedAt: now,
    chatMessages: [],
    creationPlan: null,
    outputs: [],
    mode,
    // Lego mode starts in 'awaiting-plan' — the user must describe the first
    // layer in chat before the LLM proposes a plan.
    legoState:
      mode === 'lego'
        ? {
            currentStep: 0,
            steps: [],
            candidates: [],
            selectedIndices: [],
            baseAudioPath: undefined,
            askState: null,
            phase: 'awaiting-plan',
          }
        : null,
  };
}

/** Schedule a debounced save of the active session (500ms). */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // useAceStepStore is defined below; safe at runtime (this callback
    // executes after store creation).
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    useAceStepStore.getState().saveActiveSession();
  }, 500);
}

/** Convert frontend session to backend DTO. */
function sessionToData(session: AceStepSession): AceStepSessionData {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    chatMessages: session.chatMessages,
    creationPlan: session.creationPlan,
    outputs: session.outputs,
    mode: session.mode,
    legoState: session.legoState,
  };
}

/** Parse backend DTO to frontend session. */
function dataToSession(data: AceStepSessionData): AceStepSession {
  const mode = ((data.mode as SessionMode) ?? 'text2music');
  return {
    id: data.id,
    title: data.title,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    chatMessages: (data.chatMessages as ChatMessage[]) ?? [],
    creationPlan: (data.creationPlan as CreationPlan | null) ?? null,
    outputs: (data.outputs as GeneratedAudio[]) ?? [],
    mode,
    legoState: (data.legoState as LegoFlowState | null) ?? null,
  };
}

interface AceStepStore {
  // ---- Session management ----
  sessions: AceStepSessionMeta[];
  activeSessionId: string | null;
  activeSession: AceStepSession | null;
  sessionsLoading: boolean;

  // ---- Global pipeline state ----
  status: AceStepStatus | null;
  statusLoading: boolean;
  localModels: AceStepLocalModel[];
  localModelsLoading: boolean;
  generationState: GenerationState;
  error: string | null;
  progress: AceStepProgressEvent | null;
  /** True while a LRC alignment task is running (per-output, not global). */
  lrcGeneratingId: string | null;
  /** Progress stage/message from the aligner backend (for UX feedback). */
  lrcProgress: { stage: string; progress: number; message: string } | null;
  /** Aligner model download progress (null when no download in progress). */
  alignerDownload: {
    progress: number;
    total: number | null;
    state: string;
  } | null;

  // ---- Chat streaming state (global, not per-session) ----
  chatStreaming: boolean;
  chatError: string | null;
  selectedModel: string;
  streamingMessageId: string | null;
  /** When true, the ongoing stream is from the lyrics subagent (not main chat). */
  isSubagentStream: boolean;
  /**
   * The sessionId of the currently-active LLM stream. Used by the
   * `acestep_llm_chunk` / `acestep_llm_done` event listeners (useAceStep.ts)
   * to filter out stale events from a previous stream. Without this filter,
   * a done event from the main conversation stream can be processed during
   * a subagent stream (race condition), causing finishStreaming to enter
   * the isSubagentStream path with the wrong content — which is the root
   * cause of "调用歌词 subagent displayed but subagent never executes".
   */
  currentChatSessionId: string | null;

  // ---- DiT model selection (which music model to use for generation) ----
  // Stores the DiT filename (e.g. "acestep-v15-base-Q8_0.gguf") or null for auto.
  selectedDiTFilename: string | null;
  setSelectedDiTFilename: (filename: string | null) => void;

  // ---- Session actions ----
  loadSessions: () => Promise<void>;
  createSession: (mode?: SessionMode) => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  saveActiveSession: () => Promise<void>;

  // ---- Pipeline actions ----
  refreshStatus: () => Promise<void>;
  refreshLocalModels: () => Promise<void>;
  loadSynth: (
    textEncoderPath: string,
    ditPath: string,
    vaePath: string,
    keepLoaded?: boolean,
  ) => Promise<void>;
  loadLm: (modelPath: string) => Promise<void>;
  loadFromSelection: (selection: {
    textEncoder: AceStepLocalModel;
    dit: AceStepLocalModel;
    vae: AceStepLocalModel;
  }) => Promise<void>;
  unload: () => Promise<void>;
  generate: (
    request: AceStepGenerateRequest,
    label: string,
  ) => Promise<AceStepGenerateResult | null>;
  cancel: () => Promise<void>;
  /** Score a generated audio's quality via Rust signal analysis. */
  scoreAudio: (audioId: string, audioPath: string) => Promise<void>;
  clearError: () => void;
  removeOutput: (id: string) => void;
  setProgress: (event: AceStepProgressEvent | null) => void;
  /**
   * Generate timestamped LRC lyrics for a generated audio output.
   *
   * Uses Qwen3-ForcedAligner-0.6B via pure-Rust inference. If the GGUF model
   * is missing, automatically starts a download (~994 MB) with live progress,
   * then proceeds to alignment once complete.
   * Updates the `GeneratedAudio` entry with `lrc` and `lrcPath` fields.
   */
  generateLrc: (
    audioId: string,
    lyrics: string,
    language?: string,
  ) => Promise<AceStepAlignLyricsResult | null>;
  /** True while a `.a00m` packaging task is running (per-output, not global). */
  packagingId: string | null;
  /**
   * Package a generated song into a `.a00m` archive.
   *
   * Flow:
   * 1. Find the target audio output by id.
   * 2. If LRC is missing, run `generateLrc` first (lyrics export is part of
   *    the packaging flow).
   * 3. Fetch internal trace info (machineId / deviceName / authInfo) in
   *    parallel — best-effort, empty string on failure.
   * 4. Build the output path from `options.outputDir` + `options.filename`.
   * 5. Build a `PackageSongRequest` with the LRC, creation plan / lego state,
   *    chat history, cover path, and internal trace.
   * 6. Invoke `acestep_package_song` (CPU-heavy: WAV→FLAC + ZIP write).
   *
   * Returns the `PackageSongResult` on success, or `null` if packaging failed
   * (error is in `error`).
   */
  packageSong: (
    audioId: string,
    options: PackageDialogOptions,
  ) => Promise<PackageSongResult | null>;

  // ---- Plan actions ----
  generatePlan: (userInput: string) => Promise<void>;
  updatePlan: (patch: Partial<CreationPlan>) => void;
  generateFromPlan: () => Promise<AceStepGenerateResult | null>;
  clearPlan: () => void;
  /**
   * True when a CreationPlan was just produced by the LLM and the user
   * hasn't yet acknowledged/interacted with it. Drives the "plan ready"
   * reminder banner in the chat column and the pulse highlight on the
   * right-side SessionParamsPanel. Set to false by:
   *   - dismissPlanReady()
   *   - updatePlan / clearPlan / generateFromPlan
   *   - any generation start
   */
  planJustReady: boolean;
  dismissPlanReady: () => void;
  /**
   * Whether the lyrics editor modal is open. Driven by the "需要修改歌词"
   * ask option (which opens the modal instead of sending a chat message)
   * and by the "编辑歌词" button in SessionParamsPanel.
   */
  lyricsEditorOpen: boolean;
  setLyricsEditorOpen: (open: boolean) => void;
  /**
   * Ask the LLM to revise the current lyrics according to the user's
   * instruction (e.g. "make the chorus more passionate"). Sends a hidden
   * message to the main advisor which triggers write_lyrics with the
   * existing lyrics + instruction. The revised lyrics land in
   * creationPlan.lyrics and the editor (bound to the store) updates live.
   */
  reviseLyricsWithAI: (instruction: string) => Promise<void>;
  /**
   * User-tunable DiT overrides for the chat-create flow.
   *   - inferenceSteps: passed through as-is (official recommended range
   *     32-64, default 50). User can raise to 64 for slightly better
   *     quality at the cost of ~30% longer generation.
   *   - guidanceScale: passed through as-is (official default 7.0).
   *   - shift: passed through as-is (official default 1.0, range 1.0-5.0).
   *
   * Defaults follow official INFERENCE.md for the Base/SFT model.
   */
  ditOverrides: {
    inferenceSteps: number;
    guidanceScale: number;
    shift: number;
  };
  setDitOverrides: (patch: Partial<{
    inferenceSteps: number;
    guidanceScale: number;
    shift: number;
  }>) => void;

  // ---- Lego flow actions ----
  // planLegoFlow is triggered automatically by finishStreaming when the
  // active session is in lego mode — no manual entry point needed.
  generateLegoCandidates: () => Promise<void>;
  selectLegoCandidate: (candidateIndex: number) => Promise<void>;
  regenerateLegoCandidates: () => Promise<void>;
  /** Edit the current step's caption/lyrics/track before generating. */
  updateLegoStepPlan: (patch: Partial<LegoStepPlan>) => void;
  /** Call the lyrics writer subagent to write/rewrite lyrics. */
  callLyricsWriter: (params: {
    brief: string;
    caption?: string;
    existingLyrics?: string;
    language?: string;
  }) => Promise<string | null>;

  // ---- Chat actions ----
  sendChatMessage: (text: string, opts?: { hidden?: boolean }) => Promise<void>;
  appendChunk: (delta: string) => void;
  finishStreaming: (fullText: string, status: string, error?: string) => void;
  /** Execute a web search and auto-continue the conversation with results. */
  executeSearchAndContinue: (query: string, reason: string) => Promise<void>;
  /** Call lyrics subagent and auto-continue with the generated lyrics. */
  executeLyricsWriterAndContinue: (
    brief: string,
    caption: string,
    language: string,
    existingLyrics?: string,
  ) => Promise<void>;
  /**
   * Call the style subagent and fill creationPlan with the returned
   * parameters (caption / BPM / key / duration / vocal_language). The
   * style subagent enforces ACE-Step best practices (BPM dual-write,
   * specific instruments, vocal type, production & spatial tags). Existing
   * lyrics are preserved.
   */
  executeStyleAdvisorAndContinue: (
    brief: string,
    lyrics: string,
    language: string,
  ) => Promise<void>;
  clearChat: () => void;
  setSelectedModel: (model: string) => void;
}

export const useAceStepStore = create<AceStepStore>((set, get) => ({
  // ---- Session state ----
  sessions: [],
  activeSessionId: null,
  activeSession: null,
  sessionsLoading: false,

  // ---- Global state ----
  status: null,
  statusLoading: false,
  localModels: [],
  localModelsLoading: false,
  generationState: 'idle',
  error: null,
  progress: null,
  lrcGeneratingId: null,
  lrcProgress: null,
  alignerDownload: null,
  packagingId: null,
  chatStreaming: false,
  chatError: null,
  selectedModel: 'primary',
  streamingMessageId: null,
  isSubagentStream: false,
  currentChatSessionId: null,
  planJustReady: false,
  lyricsEditorOpen: false,
  // DiT overrides for the chat-create flow. Defaults follow official
  // INFERENCE.md for the Base/SFT model:
  //   - inferenceSteps=50 → official default (range 32-64)
  //   - guidanceScale=7.0 → official default (range 5.0-9.0)
  //   - shift=1.0 → official default (range 1.0-5.0)
  ditOverrides: {
    inferenceSteps: 50,
    guidanceScale: 7.0,
    shift: 1.0,
  },
  selectedDiTFilename: (() => {
    try {
      return localStorage.getItem('acestep-selected-dit') || null;
    } catch {
      return null;
    }
  })(),

  setSelectedDiTFilename: (filename) => {
    set({ selectedDiTFilename: filename });
    // Persist to localStorage for cross-session restore.
    try {
      if (filename) {
        localStorage.setItem('acestep-selected-dit', filename);
      } else {
        localStorage.removeItem('acestep-selected-dit');
      }
    } catch {
      // ignore
    }
  },

  // ---- Session actions ----

  loadSessions: async () => {
    set({ sessionsLoading: true });
    try {
      const metas = await aceStepService.sessionList();
      set({ sessions: metas, sessionsLoading: false });

      // Auto-load the most recent session, or create a new one if none exist.
      if (metas.length > 0) {
        await get().switchSession(metas[0].id);
      } else {
        await get().createSession();
      }
    } catch {
      set({ sessionsLoading: false });
      // Fallback: create an in-memory session (no persistence).
      await get().createSession();
    }
  },

  createSession: async (mode?: SessionMode) => {
    const sessionMode = mode ?? 'text2music';
    const id = newSessionId();
    const session = createEmptySession(id, sessionMode);
    // Regenerate streaming session id for the new session.
    chatStreamSessionId = `acestep-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    set({
      activeSessionId: id,
      activeSession: session,
      // Reset generation state.
      generationState: 'idle',
      progress: null,
      error: null,
      chatStreaming: false,
      chatError: null,
      streamingMessageId: null,
      planJustReady: false,
    });

    // Persist to disk.
    try {
      await aceStepService.sessionSave(sessionToData(session));
      const metas = await aceStepService.sessionList();
      set({ sessions: metas });
    } catch {
      // Disk save failed — session still works in-memory.
    }
  },

  switchSession: async (id) => {
    try {
      const data = await aceStepService.sessionLoad(id);
      const session = dataToSession(data);
      // Regenerate streaming session id for the switched session.
      chatStreamSessionId = `acestep-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      set({
        activeSessionId: id,
        activeSession: session,
        generationState: 'idle',
        progress: null,
        error: null,
        chatStreaming: false,
        chatError: null,
        streamingMessageId: null,
        // Don't carry over the previous session's "ready" flag.
        planJustReady: false,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  deleteSession: async (id) => {
    try {
      await aceStepService.sessionDelete(id);
      const metas = await aceStepService.sessionList();
      set({ sessions: metas });

      // If the deleted session was active, switch to another or create new.
      if (get().activeSessionId === id) {
        if (metas.length > 0) {
          await get().switchSession(metas[0].id);
        } else {
          await get().createSession();
        }
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  renameSession: async (id, title) => {
    const session = get().activeSession;
    if (session && session.id === id) {
      const updated = { ...session, title, updatedAt: Date.now() };
      set({ activeSession: updated });
      scheduleSave();
    }
    // Update metadata list title.
    set((s) => ({
      sessions: s.sessions.map((m) => (m.id === id ? { ...m, title } : m)),
    }));
  },

  saveActiveSession: async () => {
    const session = get().activeSession;
    if (!session) return;
    try {
      await aceStepService.sessionSave(sessionToData(session));
    } catch {
      // Silent fail — disk errors shouldn't crash the UI.
    }
  },

  // ---- Pipeline actions ----

  refreshStatus: async () => {
    set({ statusLoading: true });
    try {
      const status = await aceStepService.getStatus();
      set({ status, statusLoading: false });
    } catch (e) {
      set({
        statusLoading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  refreshLocalModels: async () => {
    set({ localModelsLoading: true });
    try {
      const models = await aceStepService.listLocalModels();
      set({ localModels: models, localModelsLoading: false });
    } catch (e) {
      set({
        localModelsLoading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  loadSynth: async (textEncoderPath, ditPath, vaePath, keepLoaded) => {
    set({ generationState: 'loading-models', error: null });
    try {
      await aceStepService.loadSynth({
        textEncoderPath,
        ditPath,
        vaePath,
        keepLoaded,
      });
      await get().refreshStatus();
      set({ generationState: 'idle' });
    } catch (e) {
      set({
        generationState: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  loadLm: async (modelPath) => {
    set({ generationState: 'loading-models', error: null });
    try {
      await aceStepService.loadLm({ modelPath });
      await get().refreshStatus();
      set({ generationState: 'idle' });
    } catch (e) {
      set({
        generationState: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  loadFromSelection: async (selection) => {
    const { textEncoder, dit, vae } = selection;
    if (!textEncoder.exists || !dit.exists || !vae.exists) {
      set({ error: 'One or more selected model files do not exist on disk.' });
      return;
    }
    set({ generationState: 'loading-models', error: null });
    try {
      await aceStepService.loadSynth({
        textEncoderPath: textEncoder.localPath,
        ditPath: dit.localPath,
        vaePath: vae.localPath,
      });
      await get().refreshStatus();
      set({ generationState: 'idle' });
    } catch (e) {
      set({
        generationState: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  unload: async () => {
    try {
      await aceStepService.unload();
      await get().refreshStatus();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  generate: async (request, label) => {
    set({ generationState: 'loading-models', error: null, progress: null });
    try {
      // 1. Auto-load synth pipeline if not already loaded.
      const status = await aceStepService.getStatus();
      if (!status.synthLoaded) {
        // Auto-download the full bundle if any model file is missing.
        const paths = await ensureSynthModels();
        await aceStepService.loadSynth({
          textEncoderPath: paths.textEncoderPath,
          ditPath: paths.ditPath,
          vaePath: paths.vaePath,
        });
        await get().refreshStatus();
      }

      // 2. Generate.
      set({ generationState: 'generating' });
      const result = await aceStepService.generate(request);

      const audio: GeneratedAudio = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        outputPath: result.outputPath,
        durationSeconds: result.durationSeconds,
        sampleRate: result.sampleRate,
        channels: result.channels,
        createdAt: Date.now(),
        label,
      };

      // 3. Add to active session's outputs and persist.
      const session = get().activeSession;
      if (session) {
        const updated = {
          ...session,
          outputs: [...session.outputs, audio],
          updatedAt: Date.now(),
        };
        set({ activeSession: updated, progress: null, generationState: 'idle' });
        scheduleSave();

        // Async scoring — does not block the generation result.
        void get().scoreAudio(audio.id, audio.outputPath);
      } else {
        set({ progress: null, generationState: 'idle' });
      }

      return result;
    } catch (e) {
      set({
        generationState: 'error',
        error: e instanceof Error ? e.message : String(e),
        progress: null,
      });
      return null;
    } finally {
      // 4. Auto-unload to free VRAM (load → generate → release).
      try {
        await aceStepService.unload();
        await get().refreshStatus();
      } catch {
        // unload failure should not mask the generation result.
      }
    }
  },

  cancel: async () => {
    try {
      await aceStepService.cancel();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  scoreAudio: async (audioId, audioPath) => {
    try {
      const score = await aceStepService.scoreSong(audioPath);
      const session = get().activeSession;
      if (session) {
        const updated = {
          ...session,
          outputs: session.outputs.map((a) =>
            a.id === audioId ? { ...a, score } : a,
          ),
          updatedAt: Date.now(),
        };
        set({ activeSession: updated });
        scheduleSave();
      }
    } catch (e) {
      console.warn('[ACE-Step] Scoring failed:', e);
    }
  },

  clearError: () => set({ error: null }),

  removeOutput: (id) => {
    const session = get().activeSession;
    if (!session) return;
    set({
      activeSession: {
        ...session,
        outputs: session.outputs.filter((o) => o.id !== id),
        updatedAt: Date.now(),
      },
    });
    scheduleSave();
  },

  setProgress: (event) => set({ progress: event }),

  generateLrc: async (audioId, lyrics, language) => {
    const session = get().activeSession;
    if (!session) return null;
    const audio = session.outputs.find((o) => o.id === audioId);
    if (!audio) return null;
    if (!lyrics.trim()) {
      set({ error: 'Lyrics text is empty, cannot generate LRC.' });
      return null;
    }

    set({ lrcGeneratingId: audioId, error: null, lrcProgress: null });

    // Subscribe to backend progress events.
    let progressUnlisten: (() => void) | null = null;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      progressUnlisten = await listen<{
        stage: string;
        progress: number;
        message: string;
      }>('acestep-align-progress', (event) => {
        set({ lrcProgress: event.payload });
      });
    } catch {
      // Non-Tauri environment — no events, just continue.
    }

    try {
      // --- Ensure ForcedAligner GGUF exists, auto-download if missing ---
      const status = await aceStepService.getAlignerStatus();
      if (!status.exists || status.localSize === 0) {
        // Start download if not already running.
        if (status.downloadState === 'idle') {
          await aceStepService.downloadAligner();
        }

        // Poll until download completes or fails.
        set({
          alignerDownload: {
            progress: status.downloadProgress,
            total: status.downloadTotal,
            state: status.downloadState,
          },
        });

        const pollDeadline = Date.now() + 30 * 60 * 1000; // 30 min timeout
        while (Date.now() < pollDeadline) {
          await new Promise((r) => setTimeout(r, 1000));
          const prog = await aceStepService.pollAlignerProgress();
          if (!prog) {
            // No active download task — check file presence as fallback.
            const recheck = await aceStepService.getAlignerStatus();
            if (recheck.exists && recheck.localSize > 0) break;
            set({ alignerDownload: null });
            throw new Error(
              recheck.downloadError ??
                'Download interrupted: no progress task running.',
            );
          }

          set({
            alignerDownload: {
              progress: prog.progress,
              total: prog.total,
              state: prog.state,
            },
          });

          if (prog.state === 'completed') break;
          if (prog.state === 'failed') {
            set({ alignerDownload: null });
            throw new Error(prog.error ?? 'ForcedAligner download failed.');
          }
        }

        set({ alignerDownload: null });

        // Verify file actually exists after download.
        const finalCheck = await aceStepService.getAlignerStatus();
        if (!finalCheck.exists || finalCheck.localSize === 0) {
          throw new Error(
            'ForcedAligner model not found after download. Please retry.',
          );
        }
      }

      // --- Run alignment ---
      const result = await aceStepService.alignLyrics({
        audioPath: audio.outputPath,
        lyrics,
        language: language ?? 'Chinese',
      });

      // Update the GeneratedAudio entry with LRC data.
      const updated = {
        ...session,
        outputs: session.outputs.map((o) =>
          o.id === audioId
            ? { ...o, lrc: result.lrc, lrcPath: result.lrcPath }
            : o,
        ),
        updatedAt: Date.now(),
      };
      set({ activeSession: updated, lrcGeneratingId: null, lrcProgress: null });
      scheduleSave();
      return result;
    } catch (e) {
      set({
        lrcGeneratingId: null,
        alignerDownload: null,
        lrcProgress: null,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    } finally {
      if (progressUnlisten) {
        try {
          progressUnlisten();
        } catch {
          // ignore
        }
      }
    }
  },

  packageSong: async (audioId, options) => {
    const session = get().activeSession;
    if (!session) return null;
    const audio = session.outputs.find((o) => o.id === audioId);
    if (!audio) return null;

    set({ packagingId: audioId, error: null });

    try {
      // 1. Resolve lyrics text. Prefer already-generated LRC content from
      //    the audio output. Fall back to the creation plan lyrics (when the
      //    user clicks Package before generating LRC).
      const lyricsFromPlan =
        session.creationPlan?.lyrics ?? session.legoState?.steps[0]?.lyrics ?? '';

      let lrcContent = audio.lrc ?? '';

      // 2. If no LRC yet, run alignment first (lyrics export is part of the
      //    packaging flow). Skip only when there are no lyrics at all
      //    (instrumental tracks) — the archive will then omit lyrics.lrc.
      if (!lrcContent && lyricsFromPlan.trim()) {
        const alignResult = await get().generateLrc(audioId, lyricsFromPlan);
        if (!alignResult) {
          throw new Error('Failed to generate LRC before packaging.');
        }
        // Reload the (now mutated) audio entry from the latest session state.
        const latest = get().activeSession?.outputs.find((o) => o.id === audioId);
        lrcContent = latest?.lrc ?? '';
      }

      // 3. Fetch internal trace info in parallel (best-effort — empty string
      //    on failure, so offline packaging still works).
      const [machineId, deviceName, authInfo] = await Promise.all([
        api.invoke<string>('get_machine_id').catch(() => ''),
        api.invoke<string>('get_device_name').catch(() => ''),
        api.invoke<AuthInfo | null>('get_auth_info').catch(() => null),
      ]);
      const userId = authInfo?.member_id?.toString() ?? authInfo?.username ?? '';
      const userName = authInfo?.username ?? '';

      // 4. Build the output path from the user-supplied directory + filename.
      //    Use Tauri's path.join for cross-platform separator handling.
      const { join } = await import('@tauri-apps/api/path');
      const outputPath = await join(options.outputDir, `${options.filename}.a00m`);

      // 5. Build the package request.
      //    - title/artist/album/genre: from PackageDialogOptions
      //    - mode: 'text2music' or 'lego'
      //    - lyrics language: from creation plan or auto-detect
      //    - coverPath: optional cover image (jpg/png/webp)
      //    - internal: machineId/deviceName/userId/userName/sessionId
      const detectLanguage = (text: string): string => {
        if (!text) return '';
        const chineseChars = text.match(/[\u4e00-\u9fff]/g);
        if (chineseChars && chineseChars.length > 3) return 'zh';
        if (/[a-zA-Z]/.test(text)) return 'en';
        return '';
      };
      const lyricsLanguage =
        session.creationPlan?.vocal_language ||
        detectLanguage(lyricsFromPlan) ||
        'zh';

      const request: PackageSongRequest = {
        audioPath: audio.outputPath,
        outputPath,
        lyrics: lrcContent || null,
        lyricsPath: audio.lrcPath ?? null,
        coverPath: options.coverPath,
        internal: {
          machineId,
          deviceName,
          userId,
          userName,
          sessionId: session.id,
        },
        song: {
          title: options.title,
          artist: options.artist || undefined,
          album: options.album || undefined,
          genre: options.genre || undefined,
          mode: session.mode,
          lyricsLanguage,
          score: audio.score,
        },
        creationPlan: session.creationPlan ?? undefined,
        legoState: session.legoState ?? undefined,
        chatMessages: session.chatMessages,
        // Encryption is automatic: the Rust backend always encrypts with the
        // current version's fixed password from `passwords.rs`. No password
        // is collected from the user.
      };

      // 6. Invoke the backend (CPU-heavy: WAV→FLAC + ZIP write on a
      //    spawn_blocking thread).
      const result = await aceStepService.packageSong(request);
      set({ packagingId: null });
      return result;
    } catch (e) {
      set({
        packagingId: null,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  },

  // ---- Plan actions ----

  generatePlan: async (userInput) => {
    // Legacy single-shot plan generation (not streaming).
    // In the new session model, this creates a plan in the active session.
    const session = get().activeSession;
    if (!session) return;

    try {
      const response = await aceStepService.llmComplete({
        prompt: userInput,
        systemPrompt: CREATION_ADVISOR_SYSTEM_PROMPT,
      });

      const jsonStr = response.text
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const plan = JSON.parse(jsonStr) as CreationPlan;

      set({
        activeSession: { ...session, creationPlan: plan, updatedAt: Date.now() },
        planJustReady: true,
      });
      scheduleSave();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  updatePlan: (patch) => {
    const session = get().activeSession;
    if (!session || !session.creationPlan) return;
    set({
      activeSession: {
        ...session,
        creationPlan: { ...session.creationPlan, ...patch },
        updatedAt: Date.now(),
      },
      // Any edit counts as acknowledgement — drop the "ready" highlight.
      planJustReady: false,
    });
    scheduleSave();
  },

  generateFromPlan: async () => {
    const session = get().activeSession;
    if (!session || !session.creationPlan) {
      set({ error: 'No creation plan. Generate a plan first.' });
      return null;
    }

    // Reject empty lyrics. ACE-Step's text2music flow expects vocal content;
    // an empty lyrics field usually means the LLM produced an incomplete
    // plan or the lyrics failed to parse into the right panel. Force the
    // user to review/fill the lyrics before generation can start.
    const lyricsTrimmed = (session.creationPlan.lyrics ?? '').trim();
    if (!lyricsTrimmed) {
      set({
        error: '歌词为空，无法生成。请在右侧面板填写歌词后再开始生成。',
        planJustReady: true, // keep the panel highlighted so the user notices
      });
      return null;
    }

    const plan = session.creationPlan;
    const req = createDefaultAceRequest();
    // Chat flow always generates new songs — force text2music regardless of
    // what the LLM put in the plan.
    req.task_type = 'text2music';
    req.caption = plan.caption;
    req.lyrics = plan.lyrics;
    req.bpm = plan.bpm;
    req.duration = plan.duration;
    req.keyscale = plan.keyscale;
    req.timesignature = plan.timesignature;
    req.vocal_language = plan.vocal_language;

    // LM mode: 'format' (text encoder only, no creative decisions).
    req.lm_mode = 'format';
    req.use_cot_caption = false;

    // DiT params: pulled from ditOverrides (user-tunable via SessionParamsPanel).
    // Defaults follow official INFERENCE.md for the Base/SFT model:
    //   - inference_steps=50 → official default (range 32-64)
    //   - guidance_scale=7.0 → official default (range 5.0-9.0, base only)
    //   - shift=1.0 → official default (range 1.0-5.0)
    // User can raise inference_steps to 64 for slightly better quality at
    // the cost of ~30% longer generation time.
    const overrides = get().ditOverrides;
    req.inference_steps = overrides.inferenceSteps;
    req.guidance_scale = overrides.guidanceScale;
    req.shift = overrides.shift;

    const genRequest: AceStepGenerateRequest = { request: req };
    const label = plan.caption.slice(0, 40) || 'Chat Create';
    // Starting generation dismisses the "ready" reminder.
    set({ planJustReady: false });
    return get().generate(genRequest, label);
  },

  clearPlan: () => {
    const session = get().activeSession;
    if (!session) return;
    set({
      activeSession: { ...session, creationPlan: null, updatedAt: Date.now() },
      planJustReady: false,
    });
    scheduleSave();
  },

  dismissPlanReady: () => {
    if (get().planJustReady) set({ planJustReady: false });
  },

  setLyricsEditorOpen: (open) => {
    set({ lyricsEditorOpen: open });
  },

  reviseLyricsWithAI: async (instruction) => {
    const lyrics = get().activeSession?.creationPlan?.lyrics ?? '';
    const message =
      `[用户要求修改歌词]\n修改方向：${instruction}\n\n` +
      `现有歌词：\n${lyrics}\n\n` +
      `请输出 write_lyrics action 委托给歌词 subagent 重新生成，保留整体结构但按修改方向调整。\n` +
      `必须输出 JSON（不要直接写歌词）：\n` +
      `{"action":"write_lyrics","brief":"${instruction}","caption":"保持原有风格","language":"zh","existing_lyrics":"<上面现有歌词的完整内容>"}`;

    // Mark any unanswered ask as answered BEFORE sending. Without this,
    // sendChatMessage sees hasUnansweredAsk=true and replaces wireContent
    // with "[用户回答了评审问题...不要再调用 write_lyrics]" — which
    // contradicts the revise request. The LLM then either emits a malformed
    // write_lyrics (brief="修改方向：...", missing existing_lyrics) or
    // mimics the system's "调用歌词 subagent" status text without emitting
    // the action JSON. Either way, the lyrics subagent is never triggered.
    // This happens because the "需要修改歌词" ask option opens the editor
    // modal directly (ChatCreateView.handleAskOptionClick) without marking
    // the ask as answered.
    const hasUnansweredAsk = get().activeSession?.chatMessages.some(
      (m) => m.askOptions && !m.askAnswered,
    ) ?? false;
    if (hasUnansweredAsk) {
      set((s) => ({
        activeSession: s.activeSession
          ? {
              ...s.activeSession,
              chatMessages: s.activeSession.chatMessages.map((m) =>
                m.askOptions && !m.askAnswered
                  ? { ...m, askAnswered: true }
                  : m,
              ),
            }
          : null,
      }));
    }

    await get().sendChatMessage(message, { hidden: true });
  },

  setDitOverrides: (patch) => {
    set({ ditOverrides: { ...get().ditOverrides, ...patch } });
  },

  // ---- Lego flow actions ----

  generateLegoCandidates: async () => {
    const session = get().activeSession;
    if (!session || !session.legoState) return;

    const { legoState } = session;
    const step = legoState.steps[legoState.currentStep];
    if (!step) return;

    // Mark lego phase as 'generating' so the UI swaps from the edit form to
    // the progress view. generationState drives the global spinner/overlay.
    set((s) => ({
      generationState: 'generating',
      error: null,
      progress: null,
      activeSession: s.activeSession
        ? {
            ...s.activeSession,
            legoState: {
              ...s.activeSession.legoState!,
              phase: 'generating',
            },
          }
        : null,
    }));

    try {
      // 1. Auto-load synth pipeline if not already loaded. We manage load/
      //    unload ourselves because we generate N candidates in a loop —
      //    store.generate() would reload between each call.
      const status = await aceStepService.getStatus();
      if (!status.synthLoaded) {
        set({ generationState: 'loading-models' });
        // Auto-download the full bundle if any model file is missing.
        const paths = await ensureSynthModels();
        await aceStepService.loadSynth({
          textEncoderPath: paths.textEncoderPath,
          ditPath: paths.ditPath,
          vaePath: paths.vaePath,
        });
        await get().refreshStatus();
      }

      set({ generationState: 'generating' });

      // 2. Build a fresh request per candidate. Each gets a different seed
      //    so the DiT produces variation. synth_batch_size stays at 1
      //    because the backend returns a single output per call.

      // Auto-detect vocal language from lyrics content.
      const detectLanguage = (text: string): string => {
        if (!text) return '';
        const chineseChars = text.match(/[\u4e00-\u9fff]/g);
        if (chineseChars && chineseChars.length > 3) return 'zh';
        if (/[a-zA-Z]/.test(text)) return 'en';
        return '';
      };

      const buildReq = (seed: number): AceRequest => {
        const req = createDefaultAceRequest();
        req.caption = step.caption;
        req.lyrics = step.lyrics;
        req.seed = seed;
        // Step 1: text2music (base layer, no src_audio).
        // Steps 2+: lego (layered over previous selection).
        if (legoState.currentStep === 0) {
          req.task_type = 'text2music';
          // Step 1 sets the song duration.
          req.duration = step.duration > 0 ? step.duration : 0;
        } else {
          req.task_type = 'lego';
          req.track = step.track;
          // Steps 2+ inherit duration from step 1 (the base layer).
          const baseDuration = legoState.steps[0]?.duration ?? 0;
          req.duration = baseDuration > 0 ? baseDuration : 0;
        }

        // Vocal language: auto-detect from lyrics (critical for articulation).
        // For instrumental tracks (lyrics === "[Instrumental]"), leave empty.
        if (step.lyrics && step.lyrics !== '[Instrumental]') {
          req.vocal_language = detectLanguage(step.lyrics);
        }

        // LM mode: 'format' (text encoder only, no creative decisions).
        req.lm_mode = 'format';
        req.use_cot_caption = false;

        // DiT params: base model only (50 steps, with CFG).
        // Official INFERENCE.md: guidance_scale=7.0 for strong text adherence.
        req.inference_steps = 50;
        req.shift = 1.0;
        req.guidance_scale = 7.0;
        req.synth_batch_size = 1; // one per call; we loop instead
        return req;
      };

      // 3. Generate N candidates serially (pipeline holds a lock; parallel
      //    would contend). Use distinct random seeds.
      const candidateCount = 2;
      const candidates: GeneratedAudio[] = [];
      for (let i = 0; i < candidateCount; i++) {
        const seed = Math.floor(Math.random() * 1_000_000) + i * 7;
        const req = buildReq(seed);
        const genRequest: AceStepGenerateRequest = { request: req };
        if (legoState.baseAudioPath) {
          genRequest.srcAudioPath = legoState.baseAudioPath;
        }
        const result = await aceStepService.generate(genRequest);
        candidates.push({
          id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
          outputPath: result.outputPath,
          durationSeconds: result.durationSeconds,
          sampleRate: result.sampleRate,
          channels: result.channels,
          createdAt: Date.now(),
          label: `Step ${legoState.currentStep + 1}: ${step.track || 'base'} #${i + 1}`,
        });
      }

      // 4. Store candidates in legoState (not in session.outputs — those are
      //    for the final completed track only).
      const newCandidatesArr = [...legoState.candidates];
      newCandidatesArr[legoState.currentStep] = candidates;

      set((s) => ({
        activeSession: s.activeSession
          ? {
              ...s.activeSession,
              legoState: {
                ...s.activeSession.legoState!,
                candidates: newCandidatesArr,
                phase: 'selecting',
              },
              updatedAt: Date.now(),
            }
          : null,
      }));
      scheduleSave();
      set({ generationState: 'idle', progress: null });
    } catch (e) {
      set({
        generationState: 'error',
        error: e instanceof Error ? e.message : String(e),
        progress: null,
      });
    } finally {
      // Auto-unload to free VRAM (load → generate N → release).
      try {
        await aceStepService.unload();
        await get().refreshStatus();
      } catch {
        // unload failure should not mask the generation result.
      }
    }
  },

  updateLegoStepPlan: (patch) => {
    const session = get().activeSession;
    if (!session || !session.legoState) return;
    const { legoState } = session;
    const idx = legoState.currentStep;
    const oldStep = legoState.steps[idx];
    if (!oldStep) return;
    const newStep: LegoStepPlan = { ...oldStep, ...patch };
    const newSteps = [...legoState.steps];
    newSteps[idx] = newStep;
    set((s) => ({
      activeSession: s.activeSession
        ? {
            ...s.activeSession,
            legoState: {
              ...s.activeSession.legoState!,
              steps: newSteps,
            },
            updatedAt: Date.now(),
          }
        : null,
    }));
    scheduleSave();
  },

  callLyricsWriter: async (params) => {
    const session = get().activeSession;
    if (!session) return null;

    // Resolve caption, existing lyrics, and target duration based on mode.
    let caption = params.caption ?? '';
    let existingLyrics = params.existingLyrics ?? '';
    let targetDuration = 0;

    if (session.legoState) {
      // Lego mode: read from the current step plan.
      const { legoState } = session;
      const currentPlan = legoState.steps[legoState.currentStep];
      if (!currentPlan) return null;
      caption = caption || currentPlan.caption;
      existingLyrics = existingLyrics || currentPlan.lyrics;
      targetDuration =
        legoState.currentStep === 0
          ? currentPlan.duration
          : (legoState.steps[0]?.duration ?? 0);
    } else if (session.creationPlan) {
      // text2music mode: read from the creation plan.
      caption = caption || session.creationPlan.caption;
      existingLyrics = existingLyrics || session.creationPlan.lyrics;
      targetDuration = session.creationPlan.duration;
    }

    const userPrompt = buildLyricsWriterPrompt({
      brief: params.brief,
      caption,
      existingLyrics,
      targetDuration: targetDuration > 0 ? targetDuration : undefined,
      language: params.language,
    });

    try {
      const response = await aceStepService.llmComplete({
        prompt: userPrompt,
        systemPrompt: LYRICS_WRITER_SYSTEM_PROMPT,
        model: get().selectedModel === 'primary' ? undefined : get().selectedModel,
      });

      // The lyrics writer returns plain text (no JSON). Strip any accidental
      // markdown fences and return the raw lyrics.
      const lyrics = response.text
        .replace(/^```(?:\w*)\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      // Auto-fill the lyrics back into the session.
      if (session.legoState) {
        get().updateLegoStepPlan({ lyrics });
      } else if (session.creationPlan) {
        // Pre-fill lyrics into creationPlan for text2music mode.
        set((s) => ({
          activeSession: s.activeSession
            ? {
                ...s.activeSession,
                creationPlan: {
                  ...s.activeSession.creationPlan!,
                  lyrics,
                },
                updatedAt: Date.now(),
              }
            : null,
        }));
        scheduleSave();
      }

      return lyrics;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  selectLegoCandidate: async (candidateIndex) => {
    const session = get().activeSession;
    if (!session || !session.legoState) return;

    const { legoState } = session;
    const currentCandidates = legoState.candidates[legoState.currentStep];
    if (!currentCandidates || candidateIndex >= currentCandidates.length) return;

    const selected = currentCandidates[candidateIndex];
    const newSelectedIndices = [...legoState.selectedIndices];
    newSelectedIndices[legoState.currentStep] = candidateIndex;

    // After selecting, advance to the next step and return to 'awaiting-plan'
    // so the user can describe the next layer in chat. There is no fixed
    // total step count — the flow ends when the user/LLM says it's done.
    const nextStep = legoState.currentStep + 1;
    set((s) => ({
      activeSession: s.activeSession
        ? {
            ...s.activeSession,
            legoState: {
              ...s.activeSession.legoState!,
              selectedIndices: newSelectedIndices,
              baseAudioPath: selected.outputPath,
              currentStep: nextStep,
              phase: 'awaiting-plan',
            },
            updatedAt: Date.now(),
          }
        : null,
    }));
    scheduleSave();
    set({ generationState: 'idle' });

    // Auto-trigger the LLM to suggest the next layer or ask what to add.
    // Without this, the user is stuck — they don't know what to type next.
    // The LLM receives the context summary of completed layers and can
    // proactively suggest a next layer (e.g. "add drums?") or mark complete.
    const completedTrack = legoState.steps[legoState.currentStep]?.track || 'base';
    await get().sendChatMessage(
      `上一个图层（${completedTrack}）已完成并选定。请根据已有图层，建议下一步该添加什么图层，或者如果觉得已经完成可以标记完成。`,
      { hidden: true },
    );
  },

  regenerateLegoCandidates: async () => {
    const session = get().activeSession;
    if (!session || !session.legoState) return;

    // Clear current step's candidates.
    const newCandidates = [...session.legoState.candidates];
    newCandidates[session.legoState.currentStep] = [];

    set((s) => ({
      activeSession: s.activeSession
        ? {
            ...s.activeSession,
            legoState: {
              ...s.activeSession.legoState!,
              candidates: newCandidates,
              phase: 'generating',
            },
            updatedAt: Date.now(),
          }
        : null,
    }));
    scheduleSave();

    // Regenerate.
    await get().generateLegoCandidates();
  },

  // ---- Chat actions ----

  sendChatMessage: async (text, opts) => {
    const trimmed = text.trim();
    if (!trimmed || get().chatStreaming) return;

    // Ensure we have an active session.
    let session = get().activeSession;
    if (!session) {
      await get().createSession();
      session = get().activeSession;
    }
    if (!session) return;

    // If the user is answering an ask question, prefix the message with a
    // context marker so the LLM clearly understands this is an ask answer
    // (not a random comment). This prevents the LLM from re-asking or
    // re-calling the lyrics subagent when the user has already approved.
    const hasUnansweredAsk = session.chatMessages.some(
      (m) => m.askOptions && !m.askAnswered,
    );
    const wireContent = hasUnansweredAsk
      ? `[用户回答了评审问题，选择了: "${trimmed}"]\n\n请根据用户的选择继续。如果用户选择了"确认歌词OK，生成其他参数"或类似的批准选项，你必须立即输出 write_style action（Option E），委托风格 subagent 生成 caption/BPM 等参数。不要再调用 write_lyrics 或 ask。`
      : trimmed;

    const userMsg: ChatMessage = {
      id: newMsgId(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
      hidden: opts?.hidden,
    };
    const assistantMsg: ChatMessage = {
      id: newMsgId(),
      role: 'assistant',
      content: '',
      streaming: true,
      createdAt: Date.now(),
    };

    // Build wire-format messages from existing history + new user message.
    const priorMessages = session.chatMessages;
    const wireMessages: AceStepChatMessage[] = [
      ...priorMessages
        .filter((m) => m.content.length > 0)
        .map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: wireContent },
    ];

    // Update title from first user message if still default.
    const titleUpdate =
      session.title === 'New Session' && priorMessages.length === 0
        ? { title: trimmed.slice(0, 40), sessions: get().sessions.map((m) => m.id === session!.id ? { ...m, title: trimmed.slice(0, 40) } : m) }
        : {};

    set((s) => {
      if (!s.activeSession) return {};
      // When the user sends a reply (e.g. by clicking an ask option), mark
      // the previous ask-question message as answered so its buttons become
      // disabled. This applies to BOTH modes:
      //   - lego mode: tracked via legoState.phase === 'asking'
      //   - text2music mode: tracked via any message with unanswered askOptions
      const legoState = s.activeSession.legoState;
      const legoIsAsking = !!(legoState && legoState.phase === 'asking');
      const hasUnansweredAsk = s.activeSession.chatMessages.some(
        (m) => m.askOptions && !m.askAnswered,
      );
      const shouldMarkAnswered = legoIsAsking || hasUnansweredAsk;
      const updatedChatMessages = shouldMarkAnswered
        ? s.activeSession.chatMessages.map((m) =>
            m.askOptions && !m.askAnswered
              ? { ...m, askAnswered: true }
              : m,
          )
        : s.activeSession.chatMessages;
      const patchedLegoState =
        legoState && legoIsAsking
          ? { ...legoState, phase: 'awaiting-plan' as const, askState: null }
          : legoState;
      return {
        activeSession: {
          ...s.activeSession,
          chatMessages: [...updatedChatMessages, userMsg, assistantMsg],
          ...titleUpdate,
          ...(patchedLegoState !== legoState
            ? { legoState: patchedLegoState }
            : {}),
          updatedAt: Date.now(),
        },
        chatStreaming: true,
        chatError: null,
        streamingMessageId: assistantMsg.id,
        currentChatSessionId: chatStreamSessionId,
        // CRITICAL: Reset isSubagentStream when a new user-initiated turn
        // starts. Without this, if a prior subagent stream ended abnormally
        // (done event lost, error swallowed, user interrupted, etc.),
        // isSubagentStream would stay `true` and the NEXT finishStreaming
        // call for the main conversation would incorrectly enter the
        // subagent path — treating the main advisor's write_lyrics JSON as
        // lyrics text and never triggering the subagent. This is a root
        // cause of "调用歌词 subagent 不成功" (intermittent subagent
        // failures).
        isSubagentStream: false,
        // Clear previous plan and errors when a new turn starts.
        error: null,
        generationState: 'idle',
      };
    });

    try {
      // Pick system prompt based on session mode: lego mode uses the
      // single-step advisor prompt plus a dynamic summary of already-
      // completed layers so the LLM can build on prior choices.
      const systemPrompt =
        session.mode === 'lego'
          ? LEGO_ADVISOR_SYSTEM_PROMPT +
            '\n\n' +
            buildLegoContextSummary(
              session.legoState?.steps ?? [],
              session.legoState?.selectedIndices ?? [],
            )
          : CREATION_ADVISOR_SYSTEM_PROMPT;
      await aceStepService.llmChatStream({
        messages: wireMessages,
        systemPrompt,
        model: get().selectedModel,
        sessionId: chatStreamSessionId,
      });
      // Safety net: finalize if done event didn't fire.
      if (get().streamingMessageId === assistantMsg.id) {
        get().finishStreaming('', 'ok');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (get().streamingMessageId === assistantMsg.id) {
        get().finishStreaming('', 'error', msg);
      } else {
        set({ chatError: msg });
      }
    }
  },

  appendChunk: (delta) => {
    const id = get().streamingMessageId;
    if (!id || !delta) return;
    set((s) => ({
      activeSession: s.activeSession
        ? {
            ...s.activeSession,
            chatMessages: s.activeSession.chatMessages.map((m) =>
              m.id === id ? { ...m, content: m.content + delta } : m,
            ),
          }
        : null,
    }));
  },

  finishStreaming: (fullText, status, error) => {
    const id = get().streamingMessageId;
    if (!id) {
      // Safety: if isSubagentStream is stuck `true` but there is no active
      // streaming message, reset it. This can happen if a subagent's done
      // event was lost AND the safety net in executeLyricsWriterAndContinue
      // didn't fire (e.g. streamingMessageId was changed by a concurrent
      // sendChatMessage). Without this reset, the NEXT finishStreaming call
      // for the main conversation would wrongly enter the subagent path.
      if (get().isSubagentStream) {
        set({
          isSubagentStream: false,
          chatStreaming: false,
        });
      }
      return;
    }

    // ---- Subagent stream completion ----
    // When a subagent finishes streaming, don't parse plans/asks. Two kinds
    // of subagent stream through here:
    //   1. lyrics subagent → plain-text lyrics (kind='lyrics')
    //   2. style subagent  → JSON object with caption/bpm/duration/...
    // We detect the style subagent by trying to JSON-parse the content; if
    // it has a `caption` field we treat it as style params and fill the
    // creationPlan accordingly (preserving existing lyrics). Otherwise we
    // fall back to the lyrics path.
    if (get().isSubagentStream) {
      const session = get().activeSession;
      const subagentContent =
        session?.chatMessages.find((m) => m.id === id)?.content || fullText;

      // Strip any accidental markdown fences.
      const cleaned = subagentContent
        .replace(/^```(?:\w*)\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      // Try to parse as style JSON (style subagent output).
      let styleParams: {
        caption: string;
        bpm: number;
        duration: number;
        keyscale: string;
        timesignature: string;
        vocal_language: string;
        reasoning: string;
      } | null = null;
      if (status === 'ok' && cleaned.includes('{')) {
        try {
          const parsed = JSON.parse(cleaned) as Record<string, unknown>;
          // Only treat as style params if it has `caption` AND NO `action`
          // field. This prevents misclassifying a main-conversation
          // write_lyrics JSON (which also has a `caption` field) as style
          // subagent output when it wrongly enters the isSubagentStream
          // path (e.g. due to isSubagentStream not being reset). Without
          // this check, the write_lyrics action would be swallowed as
          // styleParams and the subagent would never be triggered.
          if (
            typeof parsed.caption === 'string' &&
            !('action' in parsed)
          ) {
            styleParams = {
              caption: parsed.caption,
              bpm: typeof parsed.bpm === 'number' ? parsed.bpm : 0,
              duration: typeof parsed.duration === 'number' ? parsed.duration : 0,
              keyscale: typeof parsed.keyscale === 'string' ? parsed.keyscale : '',
              timesignature: typeof parsed.timesignature === 'string' ? parsed.timesignature : '',
              vocal_language: typeof parsed.vocal_language === 'string' ? parsed.vocal_language : '',
              reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
            };
          }
        } catch {
          // not JSON — treat as lyrics
        }
      }

      if (styleParams) {
        // Style subagent: fill creationPlan with the returned params,
        // preserving the existing lyrics (the style subagent does NOT
        // return lyrics).
        const existingLyrics = session?.creationPlan?.lyrics ?? '';
        set((s) => ({
          activeSession: s.activeSession
            ? {
                ...s.activeSession,
                chatMessages: s.activeSession.chatMessages.map((m) =>
                  m.id === id
                    ? {
                        ...m,
                        content: `风格参数已生成：${styleParams!.caption}`,
                        streaming: false,
                        error: status === 'error' ? (error ?? 'Unknown error') : undefined,
                      }
                    : m,
                ),
                creationPlan: {
                  task_type: 'text2music' as const,
                  caption: styleParams!.caption,
                  lyrics: existingLyrics,
                  bpm: styleParams!.bpm,
                  duration: styleParams!.duration,
                  keyscale: styleParams!.keyscale,
                  timesignature: styleParams!.timesignature,
                  vocal_language: styleParams!.vocal_language,
                  reasoning: styleParams!.reasoning,
                },
                updatedAt: Date.now(),
              }
            : null,
          streamingMessageId: null,
          chatStreaming: false,
          chatError: status === 'error' ? (error ?? 'Unknown error') : null,
          isSubagentStream: false,
          currentChatSessionId: null,
          planJustReady: true,
        }));
        scheduleSave();
        return;
      }

      // Lyrics subagent path (existing logic).
      const lyrics = cleaned;

      // Mark the subagent message as done.
      set((s) => ({
        activeSession: s.activeSession
          ? {
              ...s.activeSession,
              chatMessages: s.activeSession.chatMessages.map((m) =>
                m.id === id
                  ? {
                      ...m,
                      content: lyrics,
                      streaming: false,
                      error: status === 'error' ? (error ?? 'Unknown error') : undefined,
                    }
                  : m,
              ),
              // Pre-fill lyrics into creationPlan (text2music) or legoState
              // is handled by callLyricsWriter for lego mode. For text2music,
              // update creationPlan directly.
              ...(s.activeSession.mode === 'text2music' && lyrics && status === 'ok'
                ? {
                    creationPlan: {
                      task_type: 'text2music' as const,
                      caption: s.activeSession.creationPlan?.caption ?? '',
                      lyrics,
                      bpm: s.activeSession.creationPlan?.bpm ?? 0,
                      duration: s.activeSession.creationPlan?.duration ?? 0,
                      keyscale: s.activeSession.creationPlan?.keyscale ?? '',
                      timesignature: s.activeSession.creationPlan?.timesignature ?? '',
                      vocal_language: s.activeSession.creationPlan?.vocal_language ?? '',
                      reasoning: s.activeSession.creationPlan?.reasoning ?? '',
                    },
                  }
                : {}),
              updatedAt: Date.now(),
            }
          : null,
        streamingMessageId: null,
        chatStreaming: false,
        chatError: status === 'error' ? (error ?? 'Unknown error') : null,
        isSubagentStream: false,
        currentChatSessionId: null,
      }));
      scheduleSave();

      // Lyrics are now shown in two places (left-side LyricsCard via
      // kind='lyrics', and right-side SessionParamsPanel via
      // creationPlan.lyrics). We do NOT auto-trigger the next LLM turn —
      // instead we present an ask: the user confirms the lyrics are OK, then
      // the LLM is triggered to generate the remaining plan fields (caption,
      // BPM, duration, key, etc.). The "Generate song" button in the right
      // panel stays disabled until those fields are filled.
      if (lyrics && status === 'ok') {
        const askMsg: ChatMessage = {
          id: newMsgId(),
          role: 'assistant',
          content:
            '歌词已生成，请在右侧面板查看和修改。确认歌词后点击下方按钮，自动生成其他参数（曲风/BPM/时长等）。',
          askOptions: ['确认歌词OK，生成其他参数', '需要修改歌词'],
          askAnswered: false,
          createdAt: Date.now(),
        };
        set((s) => ({
          activeSession: s.activeSession
            ? {
                ...s.activeSession,
                chatMessages: [...s.activeSession.chatMessages, askMsg],
                updatedAt: Date.now(),
              }
            : null,
        }));
        scheduleSave();
      } else if (status === 'error') {
        void get().sendChatMessage(
          `[歌词 subagent 错误] ${error ?? 'Unknown error'}\n\n请直接为用户编写歌词。`,
          { hidden: true },
        );
      }
      return;
    }

    // ---- Main chat stream completion ----
    // Snapshot session mode before set() so we can branch below.
    const sessionMode = get().activeSession?.mode ?? 'text2music';

    // Detect search action BEFORE set() so we can trigger the async search
    // flow after updating the UI. Both text2music and lego modes support
    // the search action.
    // Also detect write_lyrics action for subagent delegation.
    const streamingMsg = get().activeSession?.chatMessages.find((m) => m.id === id);
    // Use || (not ??) so empty-string content falls back to fullText.
    // ?? leaves '' as-is (it's not null/undefined), which causes
    // tryParseLegoStep('') to return null — writeLyricsRequest is never
    // set even though the LLM emitted a valid write_lyrics action. This
    // is the root cause of "调用歌词 subagent displayed but never executed":
    // the set() callback uses `m.content.length > 0 ? m.content : fullText`
    // (which DOES fall back), so displayContent shows the action indicator
    // while writeLyricsRequest stays null. The mismatch is intermittent
    // (depends on whether streaming chunks were appended to content before
    // the done event fired).
    const rawContentForDetect = streamingMsg?.content || fullText;
    let searchRequest: { query: string; reason: string } | null = null;
    let writeLyricsRequest: {
      brief: string;
      caption: string;
      language: string;
      existingLyrics: string;
    } | null = null;
    let writeStyleRequest: {
      brief: string;
      lyrics: string;
      language: string;
    } | null = null;
    if (status === 'ok') {
      const parseResultForAction = tryParseLegoStep(rawContentForDetect);
      if (parseResultForAction && parseResultForAction.type === 'search') {
        searchRequest = {
          query: parseResultForAction.query,
          reason: parseResultForAction.reason,
        };
      } else if (
        parseResultForAction &&
        parseResultForAction.type === 'write_lyrics'
      ) {
        writeLyricsRequest = {
          brief: parseResultForAction.brief,
          caption: parseResultForAction.caption,
          language: parseResultForAction.language,
          existingLyrics: parseResultForAction.existingLyrics,
        };
      } else if (
        parseResultForAction &&
        parseResultForAction.type === 'write_style'
      ) {
        writeStyleRequest = {
          brief: parseResultForAction.brief,
          lyrics: parseResultForAction.lyrics,
          language: parseResultForAction.language,
        };
      }
    }

    // Fallback: detect if the LLM directly output lyrics text instead of a
    // write_lyrics action JSON. This happens intermittently — the LLM sees
    // the prior subagent's lyrics output in conversation history and mimics
    // it, writing lyrics inline instead of emitting the action JSON. Without
    // this safety net, the lyrics subagent is never triggered and the user
    // sees "nothing happened" (no lyrics update, no ask for review).
    // Detection: content has >=2 ACE-Step structure tag lines ([Verse]/
    // [Chorus]/[Bridge]...) and was NOT parsed as an action/plan.
    let fallbackLyrics: string | null = null;
    if (
      status === 'ok' &&
      sessionMode === 'text2music' &&
      !writeLyricsRequest &&
      !writeStyleRequest &&
      !searchRequest
    ) {
      const tagMatches = rawContentForDetect.match(
        /^\s*\[[^\]]+\]\s*$/gm,
      );
      if (tagMatches && tagMatches.length >= 2) {
        fallbackLyrics = rawContentForDetect.trim();
      }
    }

    set((s) => {
      if (!s.activeSession) return {};
      const updatedMessages = s.activeSession.chatMessages.map((m) => {
        if (m.id !== id) return m;
        const rawContent = m.content.length > 0 ? m.content : fullText;
        // text2music mode: the LLM may emit an `ask` action (lyrics review),
        // a `search` action (web search), OR a final CreationPlan JSON.
        // We detect `ask`/`search` first; only if neither is found do we
        // attempt to parse a plan.
        // lego mode: don't try to parse a CreationPlan — the LLM emits a
        // LegoStepPlan[] instead. Mark hasPlan=false; the lego flow is
        // driven by legoState, not creationPlan.
        let plan: CreationPlan | null = null;
        let askOptions: string[] | undefined;
        let displayContent = rawContent;
        let kind: ChatMessage['kind'] = m.kind;
        if (status === 'ok' && sessionMode === 'text2music') {
          const askCheck = tryParseLegoStep(rawContent);
          if (askCheck && askCheck.type === 'ask') {
            // LLM is asking the user to review lyrics — don't parse a plan.
            // Replace raw JSON with the question text so the chat bubble
            // reads naturally.
            askOptions = askCheck.options;
            displayContent = askCheck.question;
          } else if (askCheck && askCheck.type === 'search') {
            // LLM wants to search the web — replace raw JSON with a readable
            // search indicator. The async search is triggered after set().
            displayContent = `🔍 搜索中: ${askCheck.query}${askCheck.reason ? `\n原因: ${askCheck.reason}` : ''}`;
            kind = 'status';
          } else if (askCheck && askCheck.type === 'write_lyrics') {
            // LLM delegates lyrics writing to the subagent — show a
            // readable indicator while the subagent works.
            displayContent = `✍️ 调用歌词 subagent: ${askCheck.brief}`;
            kind = 'status';
          } else {
            plan = tryParsePlan(rawContent);
          }
        }
        return {
          ...m,
          content: displayContent,
          streaming: false,
          hasPlan: !!plan,
          plan: plan ?? undefined,
          askOptions,
          askAnswered: false,
          kind,
          error: status === 'error' ? (error ?? 'Unknown error') : undefined,
        };
      });

      // Extract plan for top-level creationPlan (text2music mode only).
      // If the LLM emitted an ask/search action, there is no full plan —
      // but for ask (lyrics review), we pre-fill creationPlan.lyrics so
      // the right panel shows the draft lyrics during review.
      const msg = updatedMessages.find((m) => m.id === id);
      const isAskTurn = !!(msg && msg.askOptions && msg.askOptions.length > 0);

      // When the LLM is presenting lyrics for review (ask action), extract
      // the lyrics from the question text and create a partial plan so the
      // right-side panel shows them immediately.
      let askLyricsPlan: CreationPlan | null = null;
      if (isAskTurn && sessionMode === 'text2music' && msg) {
        const lyrics = extractLyricsFromQuestion(msg.content);
        if (lyrics) {
          askLyricsPlan = {
            task_type: 'text2music',
            caption: s.activeSession.creationPlan?.caption ?? '',
            lyrics,
            bpm: s.activeSession.creationPlan?.bpm ?? 0,
            duration: s.activeSession.creationPlan?.duration ?? 0,
            keyscale: s.activeSession.creationPlan?.keyscale ?? '',
            timesignature: s.activeSession.creationPlan?.timesignature ?? '',
            vocal_language: s.activeSession.creationPlan?.vocal_language ?? '',
            reasoning: s.activeSession.creationPlan?.reasoning ?? '',
          };
        }
      }

      const plan =
        askLyricsPlan ??
        (status === 'ok' && sessionMode === 'text2music' && !isAskTurn && !searchRequest && !writeLyricsRequest && !writeStyleRequest
          ? tryParsePlan(
              msg && msg.content.length > 0 ? msg.content : fullText,
            )
          : null);

      // Lego mode: parse a single-step plan, "complete" signal, or "ask"
      // question from the LLM response.
      let legoStatePatch: Partial<{ legoState: LegoFlowState }> = {};
      let outputsPatch: GeneratedAudio[] | null = null;
      let modifiedMessages = updatedMessages;
      if (status === 'ok' && sessionMode === 'lego') {
        const parseResult = tryParseLegoStep(
          msg && msg.content.length > 0 ? msg.content : fullText,
        );
        const existing = s.activeSession.legoState;
        if (existing && parseResult) {
          if (parseResult.type === 'search') {
            // LLM wants to search the web — replace raw JSON with a readable
            // search indicator. The async search is triggered after set().
            // Lego state is NOT patched — search is transparent to the flow.
            modifiedMessages = updatedMessages.map((m) =>
              m.id === id
                ? {
                    ...m,
                    content: `🔍 搜索中: ${parseResult.query}${parseResult.reason ? `\n原因: ${parseResult.reason}` : ''}`,
                  }
                : m,
            );
          } else if (parseResult.type === 'write_lyrics') {
            // LLM delegates lyrics writing to the subagent. Show a readable
            // indicator; the async call is triggered after set().
            modifiedMessages = updatedMessages.map((m) =>
              m.id === id
                ? {
                    ...m,
                    content: `✍️ 调用歌词 subagent: ${parseResult.brief}`,
                  }
                : m,
            );
          } else if (parseResult.type === 'ask') {
            // Replace the raw JSON in the assistant message with just the
            // question text, and attach askOptions so the UI can render
            // clickable option buttons inline inside the bubble.
            modifiedMessages = updatedMessages.map((m) =>
              m.id === id
                ? {
                    ...m,
                    content: parseResult.question,
                    askOptions: parseResult.options,
                    askAnswered: false,
                  }
                : m,
            );
            legoStatePatch = {
              legoState: {
                ...existing,
                phase: 'asking',
                askState: {
                  question: parseResult.question,
                  options: parseResult.options,
                },
              },
            };
          } else if (parseResult.type === 'step') {
            // New layer (currentStep === steps.length) or revision of the
            // current layer (currentStep < steps.length).
            const newSteps = [...existing.steps];
            if (existing.currentStep < newSteps.length) {
              // Revision: replace the current step's plan.
              newSteps[existing.currentStep] = parseResult.plan;
            } else {
              // New step: append.
              newSteps.push(parseResult.plan);
            }
            legoStatePatch = {
              legoState: {
                ...existing,
                steps: newSteps,
                phase: 'planning',
                askState: null,
              },
            };
          } else if (parseResult.type === 'complete') {
            legoStatePatch = {
              legoState: {
                ...existing,
                phase: 'completed',
                askState: null,
              },
            };
            // Save the final base audio as the session's output so it
            // appears in the library and can be replayed later.
            if (existing.baseAudioPath) {
              outputsPatch = [
                ...s.activeSession.outputs,
                {
                  id: `lego-final-${Date.now()}`,
                  outputPath: existing.baseAudioPath,
                  durationSeconds: 0,
                  sampleRate: 44100,
                  channels: 2,
                  createdAt: Date.now(),
                  label: 'Lego Final Track',
                },
              ];
            }
          }
        }
      }

      return {
        activeSession: {
          ...s.activeSession,
          chatMessages: modifiedMessages,
          // Preserve existing lyrics when the LLM produces a new plan with
          // empty lyrics. This happens in the chat-create flow: after the
          // lyrics subagent fills `creationPlan.lyrics`, the user clicks
          // "确认歌词OK，生成其他参数" and the LLM emits a plan with caption /
          // BPM / duration but leaves `lyrics` blank (it knows the lyrics
          // already exist in the conversation). Without this guard the new
          // plan would overwrite the existing lyrics with an empty string.
          creationPlan: plan
            ? {
                ...plan,
                lyrics:
                  plan.lyrics?.trim().length > 0
                    ? plan.lyrics
                    : (s.activeSession.creationPlan?.lyrics ?? plan.lyrics ?? ''),
              }
            : s.activeSession.creationPlan,
          outputs: outputsPatch ?? s.activeSession.outputs,
          ...legoStatePatch,
          updatedAt: Date.now(),
        },
        streamingMessageId: null,
        chatStreaming: false,
        isSubagentStream: false,
        currentChatSessionId: null,
        chatError: status === 'error' ? (error ?? 'Unknown error') : null,
        // A freshly parsed plan (text2music mode) should trigger the
        // "plan ready" reminder. Lego mode drives its own flow panel,
        // so we don't light up the reminder there.
        planJustReady:
          plan != null && s.activeSession?.mode === 'text2music'
            ? true
            : get().planJustReady,
      };
    });

    // Persist after streaming completes.
    scheduleSave();

    // If the LLM emitted a search action, execute the web search and
    // automatically continue the conversation with the results. This is
    // transparent to the user — they just see "🔍 搜索中: ..." followed by
    // the LLM continuing with enriched knowledge.
    if (searchRequest) {
      void get().executeSearchAndContinue(
        searchRequest.query,
        searchRequest.reason,
      );
    }

    // If the LLM emitted a write_lyrics action, call the lyrics subagent
    // and feed the results back into the conversation. The subagent uses a
    // specialized lyrics-writing system prompt for higher quality output.
    if (writeLyricsRequest) {
      void get().executeLyricsWriterAndContinue(
        writeLyricsRequest.brief,
        writeLyricsRequest.caption,
        writeLyricsRequest.language,
        writeLyricsRequest.existingLyrics,
      );
    }

    // If the LLM emitted a write_style action, call the style subagent and
    // fill the creation plan with the returned parameters. The subagent uses
    // a specialized style-design system prompt for higher quality output
    // (BPM dual-write, specific instruments, vocal type, production tags).
    if (writeStyleRequest) {
      void get().executeStyleAdvisorAndContinue(
        writeStyleRequest.brief,
        writeStyleRequest.lyrics,
        writeStyleRequest.language,
      );
    }

    // Fallback: if the LLM directly output lyrics text (instead of a
    // write_lyrics action JSON), treat the output as the new lyrics. This
    // is a safety net for when the LLM ignores the "output write_lyrics
    // action" instruction and writes lyrics inline — which happens
    // intermittently, especially on the second revision where the LLM has
    // seen the prior subagent output in conversation history and mimics it.
    // Without this, the user sees "nothing happened": no lyrics update,
    // no ask for review.
    if (fallbackLyrics) {
      set((s) => ({
        activeSession: s.activeSession
          ? {
              ...s.activeSession,
              creationPlan: {
                task_type: 'text2music' as const,
                caption: s.activeSession.creationPlan?.caption ?? '',
                lyrics: fallbackLyrics!,
                bpm: s.activeSession.creationPlan?.bpm ?? 0,
                duration: s.activeSession.creationPlan?.duration ?? 0,
                keyscale: s.activeSession.creationPlan?.keyscale ?? '',
                timesignature: s.activeSession.creationPlan?.timesignature ?? '',
                vocal_language: s.activeSession.creationPlan?.vocal_language ?? '',
                reasoning: s.activeSession.creationPlan?.reasoning ?? '',
              },
              updatedAt: Date.now(),
            }
          : null,
      }));
      const askMsg: ChatMessage = {
        id: newMsgId(),
        role: 'assistant',
        content:
          '歌词已生成，请在右侧面板查看和修改。确认歌词后点击下方按钮，自动生成其他参数（曲风/BPM/时长等）。',
        askOptions: ['确认歌词OK，生成其他参数', '需要修改歌词'],
        askAnswered: false,
        createdAt: Date.now(),
      };
      set((s) => ({
        activeSession: s.activeSession
          ? {
              ...s.activeSession,
              chatMessages: [...s.activeSession.chatMessages, askMsg],
              updatedAt: Date.now(),
            }
          : null,
      }));
      scheduleSave();
    }

    // Lego mode: the plan is now in 'planning' phase. The user reviews/edits
    // the lyrics in LegoFlowPanel and clicks "Start generation" to trigger
    // generateLegoCandidates() — no auto-trigger here.
  },

  /**
   * Execute a web search and continue the conversation with the results.
   *
   * Called automatically by `finishStreaming` when the LLM emits a
   * `{"action":"search","query":"..."}` action. The search results are
   * formatted and sent as a user message so the LLM sees them in context
   * and can continue the lyrics/caption work with enriched knowledge.
   */
  executeSearchAndContinue: async (query: string, reason: string) => {
    try {
      const results = await aceStepService.webSearch(query);
      const formatted =
        results.length > 0
          ? results
              .map(
                (r, i) =>
                  `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
              )
              .join('\n\n')
          : '未找到相关搜索结果。';
      const message = `[网络搜索结果] 查询: ${query}\n原因: ${reason}\n\n${formatted}\n\n请根据以上搜索结果继续之前的任务。`;
      await get().sendChatMessage(message, { hidden: true });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      // If search fails, tell the LLM so it can proceed with existing knowledge.
      await get().sendChatMessage(
        `[搜索失败] 查询: ${query}\n错误: ${errorMsg}\n\n请基于你现有的知识继续。`,
        { hidden: true },
      );
    }
  },

  /**
   * Call the lyrics writer subagent with STREAMING output and continue the
   * conversation with the generated lyrics.
   *
   * Called automatically by `finishStreaming` when the LLM emits a
   * `{"action":"write_lyrics","brief":"..."}` action. Unlike the old
   * `callLyricsWriter` (which blocked until completion), this method:
   * 1. Creates a new assistant message visible in the chat
   * 2. Streams the subagent's output in real-time (user sees lyrics being written)
   * 3. When done, feeds the result back to the main advisor conversation
   *
   * The `isSubagentStream` flag tells `finishStreaming` that this stream is
   * a subagent response (not a main chat response), so it doesn't try to
   * parse plans/asks/steps from the lyrics text.
   */
  executeLyricsWriterAndContinue: async (
    brief: string,
    caption: string,
    language: string,
    existingLyrics?: string,
  ) => {
    const session = get().activeSession;
    if (!session) return;

    // Build the user prompt for the lyrics subagent.
    const userPrompt = buildLyricsWriterPrompt({
      brief,
      caption: caption || '',
      existingLyrics: existingLyrics || undefined,
      language,
    });

    // Create a new assistant message for the subagent's streaming output.
    const subagentMsgId = newMsgId();
    const subagentSessionId = `lyrics-subagent-${Date.now()}`;
    const subagentMsg: ChatMessage = {
      id: subagentMsgId,
      role: 'assistant',
      content: '',
      streaming: true,
      createdAt: Date.now(),
      kind: 'lyrics',
    };

    // Add the message and set up streaming state.
    set((s) => ({
      activeSession: s.activeSession
        ? {
            ...s.activeSession,
            chatMessages: [...s.activeSession.chatMessages, subagentMsg],
            updatedAt: Date.now(),
          }
        : null,
      chatStreaming: true,
      chatError: null,
      streamingMessageId: subagentMsgId,
      isSubagentStream: true,
      currentChatSessionId: subagentSessionId,
    }));

    try {
      // Use llmChatStream for real-time streaming. The existing event
      // listeners (acestep_llm_chunk -> appendChunk) will automatically
      // append chunks to this message via streamingMessageId.
      await aceStepService.llmChatStream({
        messages: [{ role: 'user', content: userPrompt }],
        systemPrompt: LYRICS_WRITER_SYSTEM_PROMPT,
        model: get().selectedModel,
        sessionId: subagentSessionId,
      });

      // Safety net: if done event didn't fire, finalize manually.
      if (get().streamingMessageId === subagentMsgId) {
        get().finishStreaming('', 'ok');
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (get().streamingMessageId === subagentMsgId) {
        get().finishStreaming('', 'error', errorMsg);
      }
    }
  },

  executeStyleAdvisorAndContinue: async (
    brief: string,
    lyrics: string,
    language: string,
  ) => {
    const session = get().activeSession;
    if (!session) return;

    // Build the user prompt for the style subagent.
    const userPrompt = buildStyleAdvisorPrompt({
      brief,
      lyrics,
      language,
    });

    // Create a new assistant message for the subagent's streaming output.
    // kind='text' (not 'lyrics') — the output is a JSON object, not lyrics.
    // finishStreaming detects the JSON and fills creationPlan accordingly.
    const subagentMsgId = newMsgId();
    const subagentSessionId = `style-subagent-${Date.now()}`;
    const subagentMsg: ChatMessage = {
      id: subagentMsgId,
      role: 'assistant',
      content: '',
      streaming: true,
      createdAt: Date.now(),
      kind: 'text',
    };

    set((s) => ({
      activeSession: s.activeSession
        ? {
            ...s.activeSession,
            chatMessages: [...s.activeSession.chatMessages, subagentMsg],
            updatedAt: Date.now(),
          }
        : null,
      chatStreaming: true,
      chatError: null,
      streamingMessageId: subagentMsgId,
      isSubagentStream: true,
      currentChatSessionId: subagentSessionId,
    }));

    try {
      await aceStepService.llmChatStream({
        messages: [{ role: 'user', content: userPrompt }],
        systemPrompt: STYLE_ADVISOR_SYSTEM_PROMPT,
        model: get().selectedModel,
        sessionId: subagentSessionId,
      });

      // Safety net: if done event didn't fire, finalize manually.
      if (get().streamingMessageId === subagentMsgId) {
        get().finishStreaming('', 'ok');
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (get().streamingMessageId === subagentMsgId) {
        get().finishStreaming('', 'error', errorMsg);
      }
    }
  },

  clearChat: () => {
    const session = get().activeSession;
    if (!session) return;
    set({
      activeSession: {
        ...session,
        chatMessages: [],
        creationPlan: null,
        updatedAt: Date.now(),
      },
      chatStreaming: false,
      chatError: null,
      streamingMessageId: null,
    });
    scheduleSave();
  },

  setSelectedModel: (model) => set({ selectedModel: model }),
}));
