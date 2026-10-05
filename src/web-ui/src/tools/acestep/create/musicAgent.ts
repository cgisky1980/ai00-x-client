/**
 * musicAgent — client for the AI00-Music music agent over the AI gateway.
 *
 * The gateway (`/ai00-internal/llm/v1/chat/completions`) is the agent
 * system's unified LLM entry: it resolves `primary` (remote main model),
 * `ai00s:<submodel>` references and local models through the same
 * client_factory chain as dsh. Auth uses the shared internal token
 * (X-Ai00-Internal-Token); the embedded Salvo origin is same-origin in
 * production and explicit 127.0.0.1:2100 in dev (same convention as DshAPI).
 *
 * Default model is `primary` (remote) — NOT the local fast tier.
 */

import { getAi00sInternalToken } from '@ai00-x/shared';
import { tokenManager } from '@/infrastructure/auth/TokenManager';
import {
  STYLE_SYSTEM_PROMPT,
  LYRICS_SYSTEM_PROMPT,
  DIRECTIVE_ROUTER_PROMPT,
  buildStyleOptimizerPrompt,
  buildLyricsWriterPrompt,
  buildDirectiveRouterPrompt,
} from './agentPrompts';

const GATEWAY_BASE = import.meta.env.DEV ? 'http://127.0.0.1:2100' : window.location.origin;

/** Default agent model: remote main model. */
export const DEFAULT_AGENT_MODEL = 'primary';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function gatewayHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Ai00-Internal-Token': await getAi00sInternalToken(),
  };
  const bearer = await tokenManager.getAccessToken();
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  return headers;
}

/**
 * Stream a chat completion through the gateway. Calls onDelta per content
 * chunk and resolves with the full text. Throws with a friendly message when
 * the gateway is unreachable (manual creation stays usable).
 */
async function chatStream(params: {
  messages: ChatMessage[];
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<string> {
  const { messages, model = DEFAULT_AGENT_MODEL, onDelta } = params;
  let resp: Response;
  try {
    resp = await fetch(`${GATEWAY_BASE}/ai00-internal/llm/v1/chat/completions`, {
      method: 'POST',
      headers: await gatewayHeaders(),
      body: JSON.stringify({ model, messages, stream: true }),
    });
  } catch {
    throw new Error('AI_SERVICE_UNREACHABLE');
  }
  if (!resp.ok) {
    throw new Error(`AI_SERVICE_ERROR_${resp.status}`);
  }

  const contentType = resp.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !resp.body) {
    // Non-streaming JSON fallback.
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    onDelta?.(text);
    return text;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload) as {
          // OpenAI shape (local RWKV path through the gateway).
          choices?: Array<{ delta?: { content?: string } }>;
          // Ai00-S pass-through shape: reasoning frames carry thinking, the
          // answer arrives in top-level `text` frames; `content` kept for
          // OpenAI-style pass-throughs; `error` = in-band upstream failure
          // (e.g. 429 rate limit).
          text?: unknown;
          content?: unknown;
          error?: unknown;
        };
        if (chunk.error) {
          const message =
            typeof chunk.error === 'string'
              ? chunk.error
              : ((chunk.error as { message?: string }).message ?? 'upstream error');
          throw new Error(message);
        }
        let delta = chunk.choices?.[0]?.delta?.content ?? '';
        if (!delta && typeof chunk.text === 'string') {
          delta = chunk.text;
        }
        if (!delta && typeof chunk.content === 'string') {
          delta = chunk.content;
        }
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      } catch (e) {
        // Surface real upstream errors; keep-alive / partial frames are ignored.
        if (e instanceof Error && e.message && e.message !== 'Unexpected end of JSON input' && !/JSON/.test(e.message)) {
          throw e;
        }
      }
    }
  }
  return full;
}

/** Logical models offered by the gateway (for the agent model dropdown). */
export async function listAgentModels(): Promise<string[]> {
  try {
    const resp = await fetch(`${GATEWAY_BASE}/ai00-internal/llm/v1/models`, {
      headers: await gatewayHeaders(),
    });
    if (!resp.ok) return [DEFAULT_AGENT_MODEL];
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    return ids.includes(DEFAULT_AGENT_MODEL) ? ids : [DEFAULT_AGENT_MODEL, ...ids];
  } catch {
    return [DEFAULT_AGENT_MODEL];
  }
}

export interface StyleOptimization {
  caption: string;
  bpm: number;
  duration: number;
  keyscale: string;
  timesignature: string;
  vocal_language: string;
  captionZh: string;
  reasoning: string;
}

/** Extract the first JSON object from a possibly chatty response. */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('AI_BAD_JSON');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Optimize a casual style brief into a spec-compliant English caption
 * (with Chinese gloss and suggested bpm/duration).
 */
export async function optimizeStyle(params: {
  brief: string;
  lyricsContext?: string;
  instrumental?: boolean;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<StyleOptimization> {
  const text = await chatStream({
    messages: [
      { role: 'system', content: STYLE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildStyleOptimizerPrompt({
          brief: params.brief,
          lyricsContext: params.lyricsContext,
          instrumental: params.instrumental,
        }),
      },
    ],
    model: params.model,
    onDelta: params.onDelta,
  });
  const parsed = extractJson(text) as Partial<StyleOptimization>;
  if (!parsed.caption) throw new Error('AI_BAD_JSON');
  return {
    caption: parsed.caption,
    bpm: Number(parsed.bpm) || 0,
    duration: Number(parsed.duration) || 0,
    keyscale: parsed.keyscale ?? '',
    timesignature: parsed.timesignature ?? '',
    vocal_language: parsed.vocal_language ?? '',
    captionZh: parsed.captionZh ?? '',
    reasoning: parsed.reasoning ?? '',
  };
}

/** One validated lyrics segment from the agent's standardized JSON response. */
export interface LyricsSegmentJson {
  tag: string;
  descriptors: string[];
  lines: string[];
}

export interface LyricsJson {
  title: string;
  segments: LyricsSegmentJson[];
}

/**
 * Validate/normalize the lyrics writer's standardized JSON output.
 * Throws AI_BAD_JSON when no usable segment survives — the caller surfaces
 * a friendly retry message instead of filling the editor with garbage.
 */
export function parseLyricsResponse(text: string): LyricsJson {
  const parsed = extractJson(text) as {
    title?: unknown;
    segments?: Array<{ tag?: unknown; descriptors?: unknown; lines?: unknown }>;
  };
  const raw = Array.isArray(parsed.segments) ? parsed.segments : [];
  const segments = raw
    .map((s) => ({
      tag: typeof s.tag === 'string' ? s.tag.trim() : '',
      descriptors: Array.isArray(s.descriptors)
        ? s.descriptors.filter((d): d is string => typeof d === 'string').map((d) => d.trim()).filter(Boolean).slice(0, 2)
        : [],
      lines: Array.isArray(s.lines)
        ? s.lines.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
        : [],
    }))
    .filter((s) => s.tag.length > 0 && s.lines.length > 0);
  if (segments.length === 0) throw new Error('AI_BAD_JSON');
  return {
    title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
    segments,
  };
}

/** Write full tagged lyrics (optionally following a template structure). */
export async function writeLyrics(params: {
  theme: string;
  templateName?: string;
  templateStructure?: string;
  sectionHints?: string;
  caption?: string;
  vocalLanguage?: string;
  /** When present, rewrite these lyrics per `theme` (the user instruction) instead of writing from scratch. */
  existingLyrics?: string;
  model?: string;
  onDelta?: (delta: string) => void;
}): Promise<string> {
  return chatStream({
    messages: [
      { role: 'system', content: LYRICS_SYSTEM_PROMPT },
      { role: 'user', content: buildLyricsWriterPrompt(params) },
    ],
    model: params.model,
    onDelta: params.onDelta,
  });
}

/**
 * Route a free-form AI-bar instruction to its target: the style caption, the
 * lyrics, or both when the instruction explicitly touches both sides.
 * Conservative fallback = 'style' (the historically only target).
 */
export async function classifyDirective(params: {
  instruction: string;
  model?: string;
}): Promise<'style' | 'lyrics' | 'both'> {
  try {
    const text = await chatStream({
      messages: [
        { role: 'system', content: DIRECTIVE_ROUTER_PROMPT },
        { role: 'user', content: buildDirectiveRouterPrompt(params.instruction) },
      ],
      model: params.model,
    });
    if (/\bboth\b/i.test(text)) return 'both';
    return /\blyrics\b/i.test(text) ? 'lyrics' : 'style';
  } catch {
    return 'style';
  }
}
