/**
 * Enhanced LRC (word-by-word LRC) parser.
 *
 * The backend's `build_enhanced_lrc` (see
 * `src/apps/desktop/src/api/acestep_api.rs`) emits the industry-standard
 * enhanced LRC format:
 *
 * ```
 * [ti:Song Title]
 * [ar:Artist]
 * [mm:ss.xx]<mm:ss.xx>word1<mm:ss.xx>word2<mm:ss.xx>word3
 * [mm:ss.xx]<mm:ss.xx>word1...
 * ```
 *
 * - Line-level `[mm:ss.xx]` at the start of each line decides when the line
 *   is shown.
 * - Word/char-level `<mm:ss.xx>` before each word decides per-word karaoke
 *   highlighting.
 * - Players that don't understand `<...>` tags ignore them and fall back to
 *   plain line-by-line display.
 *
 * Time format: `mm:ss.xx` (minutes : seconds . centiseconds). The parser also
 * tolerates `mm:ss.xxx` (milliseconds), `mm:ss`, and `h:mm:ss.xx`.
 */

/** A single word/character with its start time (seconds). */
export interface LyricWord {
  /** Word/character text (may include trailing space). */
  text: string;
  /** Start time in seconds. */
  time: number;
}

/** A single lyric line with its start time and word breakdown. */
export interface LyricLine {
  /** Line start time in seconds (from the `[mm:ss.xx]` tag). */
  time: number;
  /** Word-level breakdown for karaoke highlighting. Empty when the line has
   * no `<mm:ss.xx>` tags (standard LRC line). */
  words: LyricWord[];
  /** Plain text of the line (words concatenated), used for fallback display
   * and search. */
  rawText: string;
}

/** Result of parsing an LRC file. */
export interface ParsedLrc {
  /** Song title from `[ti:...]` tag, if present. */
  title?: string;
  /** Artist from `[ar:...]` tag, if present. */
  artist?: string;
  /** Album from `[al:...]` tag, if present. */
  album?: string;
  /** LRC offset (milliseconds) from `[offset:...]` tag, if present. Positive
   * values shift lyrics earlier, negative later. Already applied to line
   * and word times. */
  offsetMs?: number;
  /** Parsed lyric lines, sorted by start time ascending. */
  lines: LyricLine[];
}

/**
 * 歌曲段落标签（与 song.json 的 legoState.segments 对齐）。
 *
 * 用于在歌词浮层 header 显示当前段落（Verse 1 / Chorus / Bridge 等），
 * 帮助用户理解歌曲结构。仅 lego 模式生成的歌曲有此信息；
 * text2music 模式生成的歌曲 segments 为空数组。
 */
export interface LyricSegment {
  /** 段落开始时间（秒） */
  start: number;
  /** 段落结束时间（秒，最后一段为歌曲总时长） */
  end: number;
  /** 段落标签（如 "intro" / "verse" / "chorus" / "bridge" / "outro"） */
  label: string;
  /** 段落索引（0-based） */
  index: number;
}

const TIME_BRACKET_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TIME_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/**
 * Convert matched time components to seconds.
 *
 * - `mm` = minutes (1-3 digits)
 * - `ss` = seconds (1-2 digits, 0-59)
 * - `frac` = fractional seconds (1-3 digits). 2 digits = centiseconds,
 *   3 digits = milliseconds. 1 digit = tenths of a second.
 */
function partsToSeconds(mm: string, ss: string, frac: string | undefined): number {
  const minutes = Number.parseInt(mm, 10);
  const seconds = Number.parseInt(ss, 10);
  let fractional = 0;
  if (frac) {
    const fracNum = Number.parseInt(frac, 10);
    // 2 digits -> centiseconds (x0.01), 3 digits -> milliseconds (x0.001),
    // 1 digit -> tenths (x0.1). Match by digit count, not value.
    if (frac.length === 1) fractional = fracNum / 10;
    else if (frac.length === 2) fractional = fracNum / 100;
    else fractional = fracNum / 1000;
  }
  return minutes * 60 + seconds + fractional;
}

/**
 * Parse an enhanced LRC string into structured form.
 *
 * Metadata tags (`[ti:]`, `[ar:]`, `[al:]`, `[offset:]`) are extracted when
 * present. The `[offset:]` value (milliseconds) is applied to every line's
 * start time and to every word's start time (positive offset shifts earlier).
 *
 * Lines with no `[mm:ss.xx]` tag (e.g. blank lines, pure-text comments) are
 * skipped. Lines with multiple `[mm:ss.xx]` tags produce one `LyricLine` per
 * tag (industry-standard behavior: a single lyric text can be reused at
 * multiple timestamps).
 *
 * The returned `lines` array is sorted by `time` ascending.
 */
export function parseEnhancedLrc(lrcText: string): ParsedLrc {
  const result: ParsedLrc = { lines: [] };
  if (!lrcText) return result;

  const rawLines = lrcText.split(/\r?\n/);

  // First pass: extract metadata tags and detect offset.
  let offsetMs = 0;
  for (const line of rawLines) {
    const tiMatch = line.match(/^\s*\[ti\s*:\s*(.*?)\s*\]\s*$/i);
    if (tiMatch) {
      result.title = tiMatch[1];
      continue;
    }
    const arMatch = line.match(/^\s*\[ar\s*:\s*(.*?)\s*\]\s*$/i);
    if (arMatch) {
      result.artist = arMatch[1];
      continue;
    }
    const alMatch = line.match(/^\s*\[al\s*:\s*(.*?)\s*\]\s*$/i);
    if (alMatch) {
      result.album = alMatch[1];
      continue;
    }
    const offsetMatch = line.match(/^\s*\[offset\s*:\s*([+-]?\d+)\s*\]\s*$/i);
    if (offsetMatch) {
      offsetMs = Number.parseInt(offsetMatch[1], 10);
      result.offsetMs = offsetMs;
      continue;
    }
  }
  const offsetSec = offsetMs / 1000;

  // Second pass: parse lyric lines (those with at least one [mm:ss.xx] tag).
  for (const line of rawLines) {
    // Find all line-level timestamps at the start of the line.
    // Pattern: [mm:ss.xx] optionally repeated, then the rest is content.
    TIME_BRACKET_RE.lastIndex = 0;
    const lineTimes: number[] = [];
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    // Only consider timestamps that form a prefix (contiguous from start,
    // possibly separated by whitespace).
    while ((m = TIME_BRACKET_RE.exec(line)) !== null) {
      if (m.index !== lastEnd) {
        // Allow whitespace between timestamps but not arbitrary text.
        const between = line.slice(lastEnd, m.index);
        if (!/^\s*$/.test(between)) break;
      }
      lineTimes.push(partsToSeconds(m[1], m[2], m[3]));
      lastEnd = m.index + m[0].length;
    }
    if (lineTimes.length === 0) continue;

    // Content = everything after the leading [mm:ss.xx] tags.
    const content = line.slice(lastEnd);

    // Parse word-level <mm:ss.xx> tags within the content.
    // Build words by scanning through the content, alternating between
    // timestamp tags and the text that follows each.
    const words: LyricWord[] = [];
    WORD_TIME_RE.lastIndex = 0;
    let cursor = 0;
    let wm: RegExpExecArray | null;
    let pendingText = '';
    while ((wm = WORD_TIME_RE.exec(content)) !== null) {
      // Text between previous tag and this tag.
      const textBetween = content.slice(cursor, wm.index);
      if (textBetween) {
        if (words.length === 0) {
          // Text before any <mm:ss.xx> tag: attach to next word as a prefix
          // (rare in enhanced LRC; the backend always emits a leading tag).
          pendingText += textBetween;
        } else {
          words[words.length - 1].text += textBetween;
        }
      }
      words.push({
        text: pendingText,
        time: partsToSeconds(wm[1], wm[2], wm[3]) + offsetSec,
      });
      pendingText = '';
      cursor = wm.index + wm[0].length;
    }
    // Trailing text after the last <mm:ss.xx> tag.
    if (cursor < content.length) {
      const trailing = content.slice(cursor);
      if (words.length > 0) {
        words[words.length - 1].text += trailing;
      } else {
        // No word tags at all: the whole content is plain text.
        pendingText += trailing;
      }
    }
    // If we accumulated pendingText but never found a word tag, fold it into
    // a single synthetic word at the line start time.
    if (words.length === 0 && pendingText) {
      words.push({ text: pendingText, time: 0 });
    }

    // Raw text = content with all <mm:ss.xx> tags stripped.
    const rawText = content.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '');

    for (const lineTime of lineTimes) {
      // Adjust word times: if a synthetic word was created (no word tags),
      // set its time to the line time. Otherwise keep the parsed word times.
      const adjustedWords = words.map((w, i) => {
        if (words.length === 1 && i === 0 && w.time === 0) {
          return { ...w, time: lineTime + offsetSec };
        }
        return w;
      });
      result.lines.push({
        time: lineTime + offsetSec,
        words: adjustedWords,
        rawText: rawText.trim(),
      });
    }
  }

  // Sort by line start time ascending. Stable sort keeps source order for
  // lines with identical timestamps.
  result.lines.sort((a, b) => a.time - b.time);
  return result;
}

/**
 * Find the index of the lyric line active at `currentTime` (seconds).
 *
 * Returns -1 when `currentTime` is before the first line, or when `lines` is
 * empty. Uses binary search for O(log n) lookup: called on every
 * `audio.timeupdate` event (4-66 Hz).
 *
 * The active line is the last line whose `time` is <= `currentTime`. This
 * matches standard LRC player behavior: a line stays highlighted until the
 * next line starts.
 */
export function findCurrentLineIndex(lines: LyricLine[], currentTime: number): number {
  if (lines.length === 0) return -1;
  if (currentTime < lines[0].time) return -1;

  let lo = 0;
  let hi = lines.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= currentTime) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * Find the index of the word active at `currentTime` within a line.
 *
 * Returns -1 when no word has started yet (i.e. `currentTime` is before the
 * first word). Used for per-word karaoke highlighting.
 */
export function findCurrentWordIndex(words: LyricWord[], currentTime: number): number {
  if (words.length === 0) return -1;
  if (currentTime < words[0].time) return -1;

  let lo = 0;
  let hi = words.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].time <= currentTime) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * 从 song.json 的 legoState.segments 构建 LyricSegment 数组。
 *
 * 输入格式（来自后端 song.json）：
 * ```json
 * {
 *   "legoState": {
 *     "segments": [
 *       { "start": 0, "end": 30, "label": "intro" },
 *       { "start": 30, "end": 60, "label": "verse" }
 *     ]
 *   }
 * }
 * ```
 *
 * 输入为空或字段缺失时返回空数组。函数不抛错，容错处理。
 *
 * @param legoState song.json 的 legoState 字段（可为 undefined）
 * @param fallbackDuration 歌曲总时长（最后一段 end 为 0 时用此值填充）
 */
export function buildSegments(
  legoState:
    | { segments?: Array<{ start?: number; end?: number; label?: string }> }
    | undefined,
  fallbackDuration: number,
): LyricSegment[] {
  if (!legoState?.segments?.length) return [];
  return legoState.segments.map((s, i) => ({
    start: s.start ?? 0,
    end: s.end ?? fallbackDuration,
    label: s.label ?? `segment-${i + 1}`,
    index: i,
  }));
}

/**
 * 二分查找当前时间所在的 segment 索引。
 *
 * 返回 -1 当 currentTime 在第一段之前或 segments 为空。
 */
export function findCurrentSegmentIndex(
  segments: LyricSegment[],
  currentTime: number,
): number {
  if (segments.length === 0) return -1;
  if (currentTime < segments[0].start) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= currentTime) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/** Format a time in seconds as `mm:ss` for display. */
export function formatTimeDisplay(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  const ssStr = ss.toString().padStart(2, '0');
  return `${mm}:${ssStr}`;
}