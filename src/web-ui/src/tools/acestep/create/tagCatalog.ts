/**
 * Structure-tag catalog for the lyrics editor.
 *
 * Canonical tags and their semantics come from the official ACE-Step 1.5
 * tutorial (参考/ACE-Step-Tutorial-zh.md): structure tags, combo descriptors
 * (max 2), vocal-control tags and energy tags. The editor displays localized
 * Chinese tags; submission always serializes to the English canonical form
 * the engine expects.
 */

/** One canonical structure tag with its Chinese display label. */
export interface StructureTag {
  /** Canonical English tag as submitted to the engine, e.g. "Verse 1". */
  en: string;
  /** Chinese display label, e.g. "主歌 1". */
  zh: string;
  /** Group for the picker UI. */
  group: 'structure' | 'dynamic' | 'instrumental' | 'special';
}

export const STRUCTURE_TAGS: StructureTag[] = [
  { en: 'Intro', zh: '前奏', group: 'structure' },
  { en: 'Verse 1', zh: '主歌 1', group: 'structure' },
  { en: 'Verse 2', zh: '主歌 2', group: 'structure' },
  { en: 'Verse 3', zh: '主歌 3', group: 'structure' },
  { en: 'Pre-Chorus', zh: '预副歌', group: 'structure' },
  { en: 'Chorus', zh: '副歌', group: 'structure' },
  { en: 'Final Chorus', zh: '末段副歌', group: 'structure' },
  { en: 'Bridge', zh: '桥段', group: 'structure' },
  { en: 'Outro', zh: '尾奏', group: 'structure' },
  { en: 'Build', zh: '推进', group: 'dynamic' },
  { en: 'Drop', zh: '爆点', group: 'dynamic' },
  { en: 'Breakdown', zh: '留白段', group: 'dynamic' },
  { en: 'Instrumental', zh: '间奏', group: 'instrumental' },
  { en: 'Guitar Solo', zh: '吉他独奏', group: 'instrumental' },
  { en: 'Piano Interlude', zh: '钢琴间奏', group: 'instrumental' },
  { en: 'Fade Out', zh: '淡出', group: 'special' },
];

/** english tag → zh label lookup. */
const EN_TO_ZH = new Map(STRUCTURE_TAGS.map((t) => [t.en, t.zh]));

/** Human-readable vocal-control / energy tags (inline, kept as-is). */
export const INLINE_TAGS: StructureTag[] = [
  { en: 'raspy vocal', zh: '沙哑嗓音', group: 'special' },
  { en: 'whispered', zh: '轻声', group: 'special' },
  { en: 'falsetto', zh: '假声', group: 'special' },
  { en: 'powerful belting', zh: '强力嘶吼', group: 'special' },
  { en: 'spoken word', zh: '说唱念白', group: 'special' },
  { en: 'harmonies', zh: '和声层叠', group: 'special' },
  { en: 'ad-lib', zh: '即兴装饰', group: 'special' },
  { en: 'high energy', zh: '高能量', group: 'special' },
  { en: 'low energy', zh: '低能量', group: 'special' },
  { en: 'building energy', zh: '能量递增', group: 'special' },
  { en: 'explosive', zh: '爆发', group: 'special' },
  { en: 'dreamy', zh: '梦幻', group: 'special' },
];

/** Chinese label for a canonical English tag (falls back to the tag itself). */
export function zhTag(en: string): string {
  return EN_TO_ZH.get(en) ?? en;
}

/** 段落修饰词徽章集（取自官方教程的组合描述词/人声/能量标记，双语）。 */
export const DESCRIPTOR_CHIPS: Array<{ en: string; zh: string }> = [
  { en: 'anthemic', zh: '激昂' },
  { en: 'whispered', zh: '轻声' },
  { en: 'soft', zh: '柔和' },
  { en: 'powerful', zh: '强力' },
  { en: 'falsetto', zh: '假声' },
  { en: 'raspy', zh: '沙哑' },
  { en: 'dreamy', zh: '梦幻' },
  { en: 'melancholic', zh: '忧郁' },
  { en: 'euphoric', zh: '欣快' },
  { en: 'aggressive', zh: '爆裂' },
  { en: 'warm', zh: '温暖' },
  { en: 'bright', zh: '明亮' },
  { en: 'sparse', zh: '稀疏' },
  { en: 'layered', zh: '层叠' },
];

/** descriptor en -> zh label */
export function zhDescriptor(en: string): string {
  return DESCRIPTOR_CHIPS.find((c) => c.en === en)?.zh ?? en;
}

/** Serialize one segment header to the engine form, e.g. "[Chorus - anthemic]". */
export function serializeSegmentHeader(en: string, descriptors?: string[]): string {
  if (descriptors && descriptors.length > 0) {
    return `[${en} - ${descriptors.slice(0, 2).join(' - ')}]`;
  }
  return `[${en}]`;
}

/** Serialize lyric segments to the engine form (canonical English tags). */
export function serializeLyrics(
  segments: Array<{ kind: string; descriptors?: string[]; lines: string[] }>,
): string {
  return segments
    .map((seg) => `${serializeSegmentHeader(seg.kind, seg.descriptors)}\n${seg.lines.join('\n')}`)
    .join('\n\n');
}

/**
 * Parse pasted lyrics (either English canonical tags or our Chinese labels,
 * optionally with `-` descriptors) into { tag, descriptors, lines } blocks.
 * Unrecognized headers keep their raw text as a custom tag.
 */
export interface ParsedBlock {
  tag: string;
  descriptors: string[];
  lines: string[];
}

export function parseLyricsText(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const zhToEn = new Map(STRUCTURE_TAGS.map((t) => [t.zh, t.en]));
  let current: ParsedBlock | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const parts = header[1].split('-').map((p) => p.trim());
      const head = zhToEn.get(parts[0]) ?? parts[0];
      current = { tag: head, descriptors: parts.slice(1), lines: [] };
      blocks.push(current);
      continue;
    }
    if (!line) continue; // drop blank lines; blocks are separated by headers
    if (!current) {
      current = { tag: 'Verse 1', descriptors: [], lines: [] };
      blocks.push(current);
    }
    current.lines.push(line);
  }
  return blocks;
}
