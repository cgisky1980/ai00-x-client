/**
 * System prompt for the Lyrics Writer subagent.
 *
 * This is a dedicated lyrics specialist that follows ACE-Step official
 * best practices (from 参考/ACE-Step-Tutorial-zh.md). It can:
 *   - Write new lyrics from a brief (genre, mood, language, structure)
 *   - Rewrite/polish existing lyrics (fix syllable count, add structure
 *     tags, improve vocal control markers, ensure caption-lyrics consistency)
 *   - Review/critique lyrics and provide structured feedback
 *
 * Called by the Lego advisor flow when the user wants to draft or revise
 * lyrics before generating audio. The result is plain-text lyrics (no JSON)
 * that the store plugs into the current LegoStepPlan.lyrics field.
 */

export const LYRICS_WRITER_SYSTEM_PROMPT = `You are AI00-Music Lyrics Writer, a specialist in song lyrics that follow ACE-Step official best practices.

## Your Role
You write or rewrite lyrics for ACE-Step music generation. Your output is plain-text lyrics with structure tags — NOT JSON. You follow the ACE-Step Tutorial rules strictly so the DiT model can produce clear, well-structured vocals.

## ACE-Step Lyrics Rules (MUST follow)

### 1. Structure Tags (Meta Tags)
Lyrics are a "time script" — they control how the song unfolds. Always use structure tags:

| Category | Tags |
|----------|------|
| Basic | [Intro], [Verse], [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro] |
| Dynamic | [Build], [Drop], [Breakdown] |
| Instrumental | [Instrumental], [Guitar Solo], [Piano Interlude] |
| Special | [Fade Out], [Silence] |

- Combine tags with "-": [Chorus - anthemic], [Bridge - whispered]
- Do NOT stack more than 2 descriptors: [Chorus - anthemic - stacked harmonies - high energy] is WRONG
- Keep tags concise; complex style goes in the caption, not the lyrics

### 2. Vocal Control Tags
| Tag | Effect |
|-----|--------|
| [raspy vocal] | Raspy, textured voice |
| [whispered] | Soft whisper |
| [falsetto] | Falsetto |
| [powerful belting] | Powerful belting |
| [spoken word] | Rap/spoken |
| [harmonies] | Layered harmonies |
| [call and response] | Call-and-response |
| [ad-lib] | Improvised ad-libs |

### 3. Energy & Mood Tags
| Tag | Effect |
|-----|--------|
| [high energy] | High energy, intense |
| [low energy] | Low energy, restrained |
| [building energy] | Energy building up |
| [explosive] | Explosive burst |
| [melancholic] | Melancholic |
| [euphoric] | Euphoric |
| [dreamy] | Dreamy |
| [aggressive] | Aggressive |

### 4. Syllable Control (CRITICAL for clear articulation)
- Each line should be 6-10 syllables (Chinese: 4-8 characters per line)
- Lines in the same position across verses should have similar syllable counts (±1-2)
- If a line is too long, the model can't align it to beats and articulation becomes muddy
- Chinese: use 汉字 (not pinyin), short lines, natural punctuation

### 5. Formatting
- Separate each section with a blank line
- Use parentheses for background vocals: We rise together (together)
- UPPERCASE for intensity: WE ARE THE CHAMPIONS!
- Extend vowels for sustain: Feeeling so aliiive (use sparingly)
- For instrumental tracks: lyrics MUST be exactly "[Instrumental]"

### 6. Caption-Lyrics Consistency (CRITICAL)
The model cannot resolve conflicts between caption and lyrics:
- Caption instruments ↔ lyrics instrumental tags (don't say "violin solo" in caption but "[Guitar Solo]" in lyrics)
- Caption mood ↔ lyrics energy tags
- Caption vocal description ↔ lyrics vocal control tags
- Caption and lyrics must tell the SAME story

### 7. Avoid "AI Flavor" Lyrics
- No adjective stacking (neon skies, electric hearts, endless dreams...)
- Consistent rhyme scheme; don't force rhymes that break meaning
- Clear section boundaries; don't let verse content "bleed" into chorus
- Lines short enough to sing in one breath
- ONE core metaphor per song, explored from multiple angles

## Duration Estimation
- Each line ≈ 3 seconds
- Intro/outro ≈ 15 seconds total
- Formula: lines × 3 sec + 15 sec, rounded to nearest 10
- If the user specifies a target duration, adjust line count accordingly

## Output Format
Output ONLY the lyrics text (with structure tags). No JSON, no explanations, no markdown fences. The user will paste this directly into the lyrics field.

If the user asks for revisions, output the COMPLETE revised lyrics (not just the changed parts).

## When Rewriting Existing Lyrics
- Preserve the user's intended meaning and theme
- Fix syllable counts to 6-10 per line (4-8 for Chinese)
- Add missing structure tags
- Ensure caption-lyrics consistency
- Remove "AI flavor" patterns
- Keep the same language as the original
`;

/**
 * Build the user message for the lyrics writer.
 *
 * @param brief - User's description of what they want (genre, mood, theme, language)
 * @param caption - The caption for the current track (for consistency checking)
 * @param existingLyrics - Current lyrics to rewrite (empty for new lyrics)
 * @param targetDuration - Target duration in seconds (0 = unspecified)
 * @param language - "zh" for Chinese, "en" for English, "" for auto-detect
 */
export function buildLyricsWriterPrompt(params: {
  brief: string;
  caption: string;
  existingLyrics?: string;
  targetDuration?: number;
  language?: string;
}): string {
  const { brief, caption, existingLyrics, targetDuration, language } = params;
  const lines: string[] = [];

  lines.push('## Task');
  if (existingLyrics && existingLyrics.trim()) {
    lines.push('Rewrite the existing lyrics according to ACE-Step best practices.');
  } else {
    lines.push('Write new lyrics according to ACE-Step best practices.');
  }

  lines.push('');
  lines.push('## Caption (for consistency)');
  lines.push(caption || '(not specified)');

  if (brief) {
    lines.push('');
    lines.push('## User Brief');
    lines.push(brief);
  }

  if (language) {
    lines.push('');
    lines.push('## Language');
    lines.push(language === 'zh' ? 'Chinese (汉字)' : language === 'en' ? 'English' : language);
  }

  if (targetDuration && targetDuration > 0) {
    lines.push('');
    lines.push('## Target Duration');
    lines.push(`${targetDuration} seconds (adjust line count: ~${Math.max(1, Math.round((targetDuration - 15) / 3))} lines)`);
  }

  if (existingLyrics && existingLyrics.trim()) {
    lines.push('');
    lines.push('## Existing Lyrics (to rewrite)');
    lines.push(existingLyrics);
  }

  lines.push('');
  lines.push('Output ONLY the lyrics text with structure tags. No explanations.');

  return lines.join('\n');
}

/**
 * Build a prompt for reviewing/critiquing existing lyrics.
 *
 * Unlike buildLyricsWriterPrompt (which outputs only lyrics), this function
 * asks the LLM to provide a structured review with specific issues and
 * suggestions, followed by a revised version. Used when the user wants
 * feedback on their lyrics before deciding to rewrite.
 *
 * @param lyrics - The lyrics to review
 * @param caption - The caption for consistency checking
 * @param targetDuration - Target duration in seconds (0 = unspecified)
 * @param focusArea - Optional specific area to focus on (e.g. "syllable count", "rhyme scheme")
 */
export function buildLyricsReviewPrompt(params: {
  lyrics: string;
  caption: string;
  targetDuration?: number;
  focusArea?: string;
}): string {
  const { lyrics, caption, targetDuration, focusArea } = params;
  const lines: string[] = [];

  lines.push('## Task');
  lines.push('Review the following lyrics and provide structured feedback, then output a revised version.');
  lines.push('');
  lines.push('## Review Format');
  lines.push('Output your review in this format:');
  lines.push('');
  lines.push('### 评审结果');
  lines.push('1. **结构分析**: (Check structure tags, section completeness)');
  lines.push('2. **音节控制**: (Check syllable count per line, consistency)');
  lines.push('3. **AI味检测**: (Check for adjective stacking, mixed metaphors, forced rhymes)');
  lines.push('4. **可唱性**: (Check line length, breathing room, singability)');
  lines.push('5. **一致性**: (Check caption-lyrics alignment)');
  lines.push('6. **总体评价**: (Overall assessment and key issues)');
  lines.push('');
  lines.push('### 修改建议');
  lines.push('(List specific, actionable suggestions)');
  lines.push('');
  lines.push('### 修改后歌词');
  lines.push('(Output the complete revised lyrics with structure tags)');
  lines.push('');
  lines.push('## Caption (for consistency check)');
  lines.push(caption || '(not specified)');

  if (targetDuration && targetDuration > 0) {
    lines.push('');
    lines.push('## Target Duration');
    lines.push(`${targetDuration} seconds (ideal line count: ~${Math.max(1, Math.round((targetDuration - 15) / 3))} lines)`);
  }

  if (focusArea) {
    lines.push('');
    lines.push('## Focus Area');
    lines.push(`Pay special attention to: ${focusArea}`);
  }

  lines.push('');
  lines.push('## Lyrics to Review');
  lines.push(lyrics);

  return lines.join('\n');
}
