/**
 * AI00-Music music agent prompts.
 *
 * Two focused system prompts — style polish and lyrics writing each carry only
 * the rules their task needs. Few-shot examples are structured data serialized
 * via JSON.stringify (no hand-written nested-quote JSON strings).
 *
 * Spec distilled from 参考/ACE-Step-Tutorial-zh.md (official tutorial) plus
 * community best practices (8-12 tag budget, genre-first formula, instruments
 * over adjectives).
 */

/** The caption JSON shape both the prompt and the examples share. */
interface CaptionJson {
  caption: string;
  bpm: number;
  duration: number;
  keyscale: string;
  timesignature: string;
  vocal_language: string;
  captionZh: string;
  reasoning: string;
}

/** Style-polish system prompt: brief -> ONE caption JSON. */
export const STYLE_SYSTEM_PROMPT = `You are AI00-Music, the style-polish step of the Ai00-X music agent. Turn the user's brief (ANY language) into ONE ACE-Step caption and reply with a single JSON object — no prose, no markdown fences.

## Caption formula
genre FIRST, then mood → 2-3 SPECIFIC instruments → vocal type → production tag → "<n> bpm". 8-12 comma-separated English tags total; beyond 15 they dilute each other.

## Hard rules
1. English comma-separated tags ONLY. Name instruments specifically: "felt piano" / "808 drums" / "fingerpicked acoustic guitar" — never bare "piano"/"drums"/"guitar", never adjective-only ("elegant, refined" describes nothing).
2. Vocal songs MUST state the vocal type ("female breathy vocal", "raspy male vocal") AND include "upfront vocal, vocal-led, sparse accompaniment" — buried vocals are the #1 failure. Avoid dense tags (lush strings, wall of sound).
3. bpm is dual-written: the bpm field AND a "<n> bpm" tag. keyscale / timesignature go ONLY in their own fields, never in the caption.
4. Include >= 1 production tag (lo-fi / polished / analog warmth / tape saturation / live recording / intimate).
5. Never mix conflicting styles — resolve as time evolution ("opens with X, builds into Y").
6. captionZh: a one-line gloss of the caption in the brief's language.

## Priority: brief > lyrics
The user brief ALWAYS wins. Lyrics (when provided) are only a mood reference: infer emotion, energy, vocal color and instruments from their imagery ONLY for dimensions the brief leaves open. When lyrics are provided, vocal_language follows the LYRICS' language; otherwise infer from the brief.

## Duration
Each lyric line ≈ 3s plus ~15s intro/outro; round to the nearest 10s, clamp 60-300.

## Output (ONLY this JSON)
{"caption":"...","bpm":72,"duration":180,"keyscale":"A minor","timesignature":"4/4","vocal_language":"zh","captionZh":"...","reasoning":"one short sentence"}
vocal_language ∈ zh | en | ja | ko | instrumental
`;

/** Lyrics-writing system prompt: spec + output shape, nothing else. */
export const LYRICS_SYSTEM_PROMPT = `You are AI00-Music, the lyrics-writing step of the Ai00-X music agent. Write complete song lyrics and reply with a single JSON object — no prose, no markdown fences.

## Structure tags (one per section)
Basic: [Intro] [Verse 1] [Verse 2] [Pre-Chorus] [Chorus] [Final Chorus] [Bridge] [Outro] · Dynamic: [Build] [Drop] [Breakdown] · Instrumental: [Instrumental] [Guitar Solo] [Piano Interlude] · Special: [Fade Out]
- Combo descriptors with "-": [Chorus - anthemic]. MAX 2 — stacked tags get sung or confuse the model.
- If a caption is given, tags' instruments/mood/vocals MUST match it (caption = global setting, lyrics = timeline).

## Delivery / energy words (use sparingly, as descriptors)
vocal: raspy vocal, whispered, falsetto, powerful belting, spoken word, harmonies, call and response, ad-lib
energy: high energy, low energy, building energy, explosive, melancholic, euphoric, dreamy, aggressive

## What makes good lyrics
1. ONE theme, ONE core metaphor — every section serves it; no imagery hopping, no adjective piles.
2. Concrete over abstract: real objects, places, actions, sensory details — show, don't tell; no stock clichés.
3. Chorus = hook: the title line lands in the chorus (repeat it verbatim); verses tell the story, chorus pays off the emotion.
4. Emotional arc: verse sets the scene → pre-chorus builds → chorus peaks → bridge turns → final chorus lands.
5. Rhyme: consistent end-rhyme inside each section; natural phrasing first — never bend a line just to rhyme.
6. Singable lines: 6-10 syllables, matching positions keep similar counts, open vowels on long notes.
7. UPPERCASE = stronger delivery; (parentheses) = background vocals.

## Output (ONLY this JSON)
{"title":"...","segments":[{"tag":"Verse 1","descriptors":["soft"],"lines":["...","..."]},{"tag":"Chorus","descriptors":[],"lines":["..."]}]}
"tag" = structure tag above; "descriptors" optional (MAX 2); "lines" = lyric lines WITHOUT brackets.
`;

/** One genre-anchored few-shot example (structured — no nested-quote JSON). */
interface StyleExample {
  match: RegExp;
  brief: string;
  out: CaptionJson;
}

/** 曲风 few-shot 示例表（官方教程范式；关键词命中即选为格式参考）。 */
export const STYLE_EXAMPLES: StyleExample[] = [
  {
    match: /piano|钢琴|ballad|抒情|慢歌|忧伤/i,
    brief: '安静晚上听的钢琴曲，有点忧伤，女声',
    out: {
      caption:
        'melancholic felt piano ballad, female breathy vocal, upfront vocal, vocal-led, sparse accompaniment, warm tape saturation, intimate, 72 bpm, polished',
      bpm: 72,
      duration: 180,
      keyscale: 'A minor',
      timesignature: '4/4',
      vocal_language: 'zh',
      captionZh: '忧愁的毛毡钢琴叙事曲，女声气声演唱，人声靠前，稀疏伴奏，温暖磁带质感',
      reasoning: 'Minor-key felt piano carries the late-night sadness; sparse mix keeps the vocal clear.',
    },
  },
  {
    match: /folk|民谣|吉他|叙事|acoustic/i,
    brief: '一个人的旅行，民谣，木吉他',
    out: {
      caption:
        'warm acoustic folk ballad, male vocal, fingerpicked acoustic guitar, gentle harmonica, storytelling, intimate, 90 bpm, bedroom recording',
      bpm: 90,
      duration: 210,
      keyscale: 'G major',
      timesignature: '4/4',
      vocal_language: 'zh',
      captionZh: '温暖的原声民谣，男声，指弹木吉他与口琴点缀，叙事感',
      reasoning: 'Fingerpicked guitar and harmonica fit the road-trip storytelling mood.',
    },
  },
  {
    match: /rap|说唱|嘻哈|hip.?hop|boom/i,
    brief: '一首自信的说唱，讲奋斗',
    out: {
      caption:
        'hard-hitting boom bap hip-hop, confident male rap vocal, spoken word delivery, punchy 808 drums, vinyl scratches, gritty city night, 92 bpm',
      bpm: 92,
      duration: 200,
      keyscale: 'F minor',
      timesignature: '4/4',
      vocal_language: 'zh',
      captionZh: '硬核 boom bap 说唱，男声念白，808 鼓点与黑胶采样，都市夜色',
      reasoning: 'Boom bap groove anchors the striving narrative with grit.',
    },
  },
  {
    match: /edm|电子|电音|舞曲|dance|house/i,
    brief: '音乐节气氛的电音，女声',
    out: {
      caption:
        'uplifting progressive EDM, euphoric female vocal, sidechained synth pads, driving four-on-the-floor kick, wide stereo, festival energy, 128 bpm, polished',
      bpm: 128,
      duration: 220,
      keyscale: 'C major',
      timesignature: '4/4',
      vocal_language: 'en',
      captionZh: '渐进式电音，欣快女声，侧链合成器铺底，四踩底鼓，音乐节能量',
      reasoning: 'Four-on-the-floor and wide pads deliver the festival lift.',
    },
  },
  {
    match: /儿歌|儿童|童谣|kids|nursery|可爱/i,
    brief: '可爱的儿歌，尤克里里',
    out: {
      caption:
        'playful nursery song, sweet childlike vocal, ukulele, toy piano, hand claps, bright warm tone, singalong chorus, 100 bpm',
      bpm: 100,
      duration: 90,
      keyscale: 'C major',
      timesignature: '4/4',
      vocal_language: 'zh',
      captionZh: '俏皮儿歌，童声，尤克里里与玩具钢琴，拍手声，明亮温暖',
      reasoning: 'Simple singalong structure with toy timbres for kids.',
    },
  },
  {
    match: /rock|摇滚|乐队|金属|metal/i,
    brief: '燥起来的摇滚，讲青春',
    out: {
      caption:
        'energetic indie rock anthem, raspy male vocal, distorted electric guitars, driving bass, live drum kit, garage energy, gang vocals in chorus, 140 bpm, raw',
      bpm: 140,
      duration: 210,
      keyscale: 'E major',
      timesignature: '4/4',
      vocal_language: 'zh',
      captionZh: '独立摇滚，沙哑男声，失真吉他与现场鼓，副歌和声，车库能量',
      reasoning: 'Raw guitars and gang vocals channel youthful restlessness.',
    },
  },
];

/** 按 brief 曲风关键词选最贴近的 few-shot 示例（默认钢琴抒情）。 */
export function pickStyleExample(brief: string): string {
  const hit = STYLE_EXAMPLES.find((e) => e.match.test(brief)) ?? STYLE_EXAMPLES[0];
  return `brief "${hit.brief}" -> ${JSON.stringify(hit.out)}`;
}

/** 行边界截断（默认 2000 字符），防止超长歌词挤爆 prompt。 */
export function truncateLyricsContext(text: string, max = 2000): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return text.slice(0, cut > 0 ? cut : max).trimEnd();
}

/** Style optimizer task: casual user brief (any language) -> standardized caption JSON. */
export function buildStyleOptimizerPrompt(params: {
  brief: string;
  lyricsContext?: string;
  instrumental?: boolean;
}): string {
  const { brief, lyricsContext, instrumental } = params;
  const lines: string[] = [];
  lines.push('## Task');
  lines.push('Turn the user brief into ONE caption JSON. Output ONLY the JSON object.');
  lines.push('');
  lines.push('## Format example (closest genre — format reference ONLY, do not copy its words)');
  lines.push(pickStyleExample(brief));
  lines.push('');
  lines.push('## User brief (PRIMARY — always wins)');
  lines.push(
    brief ||
      (lyricsContext && !instrumental
        ? '(empty — infer everything from the lyrics below; still propose something tasteful)'
        : '(empty — propose something tasteful)'),
  );
  if (instrumental) {
    lines.push('');
    lines.push('INSTRUMENTAL piece: no vocal tags, "vocal_language": "instrumental".');
  } else if (lyricsContext) {
    lines.push('');
    lines.push('## Existing lyrics (mood reference — infer emotion/energy/imagery; the brief above wins any conflict)');
    lines.push(lyricsContext);
  }
  return lines.join('\n');
}

/** Lyrics writer task: theme + template structure -> structured lyrics JSON. */
export function buildLyricsWriterPrompt(params: {
  theme: string;
  templateName?: string;
  templateStructure?: string;
  sectionHints?: string;
  caption?: string;
  vocalLanguage?: string;
  /** When present, rewrite these lyrics per the user instruction instead of writing from scratch. */
  existingLyrics?: string;
}): string {
  const { theme, templateName, templateStructure, sectionHints, caption, vocalLanguage, existingLyrics } = params;
  const rewrite = Boolean(existingLyrics?.trim());
  const lines: string[] = [];
  lines.push('## Task');
  lines.push(
    rewrite
      ? 'Rewrite the existing lyrics per the user instruction. Output ONLY the JSON object.'
      : 'Write complete lyrics following the structure-tag spec. Output ONLY the JSON object.',
  );
  lines.push('');
  if (!rewrite && templateName) {
    lines.push(`## Required structure: ${templateName}`);
    if (templateStructure) lines.push(`Sections (use EXACTLY these tags, in this order): ${templateStructure}`);
    if (sectionHints) lines.push(`Per-section writing hints:\n${sectionHints}`);
    lines.push('');
  }
  if (caption) {
    lines.push('## Caption (lyrics MUST stay consistent with it)');
    lines.push(caption);
    lines.push('');
  }
  if (rewrite) {
    lines.push(
      '## Existing lyrics (rewrite per the user instruction — keep section tags/order and what already works unless the instruction says otherwise)',
    );
    lines.push(existingLyrics!);
    lines.push('');
  }
  lines.push(rewrite ? '## User instruction (PRIMARY — always wins)' : '## Theme / brief from the user');
  lines.push(theme || '(free creation — pick something evocative)');
  if (vocalLanguage) {
    lines.push('');
    lines.push(`Write the lyrics in ${vocalLanguage === 'zh' ? 'Chinese' : vocalLanguage === 'en' ? 'English' : vocalLanguage}.`);
  }
  return lines.join('\n');
}

/** Intent router: decide whether a free-form instruction targets the style caption or the lyrics. */
export const DIRECTIVE_ROUTER_PROMPT = `You are the intent router of the Ai00-X music creation tool. Read the user's instruction and reply with EXACTLY one word — no punctuation, no explanation:
- "style" — change the MUSIC only: genre, instruments, mood, tempo, vocals, production.
- "lyrics" — change the WORDS only: text, theme, rhyme, sections, structure.
- "both" — BOTH sides are explicitly touched (e.g. "改成摇滚，副歌也重写"): music AND words.
Pick "both" ONLY when both sides are clearly requested; otherwise reply the single dominant target.`;

/** Router task prompt (kept separate so the system prompt stays tiny and cacheable). */
export function buildDirectiveRouterPrompt(instruction: string): string {
  return `## Instruction\n${instruction}\n\n## Reply\nstyle | lyrics | both`;
}
