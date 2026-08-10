/**
 * SessionParamsPanel — fixed parameter panel for the active session.
 *
 * Displays the current session's CreationPlan (produced by the LLM) and
 * allows inline editing + one-click generation. Extracted from the old
 * inline PlanCard in ChatCreateView so it can live in the right sidebar.
 */

import React, { useState, useRef } from 'react';
import {
  Music,
  Loader2,
  Play,
  Edit3,
  Check,
  ChevronDown,
  ChevronUp,
  Sparkles,
} from 'lucide-react';
import { Modal } from '@/component-library/components/Modal/Modal';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useAceStepStore } from '../store/acestepStore';
import { MusicModelSelector } from './MusicModelSelector';
import './SessionParamsPanel.scss';

// ---- Field sub-component (inline, single-use) ----

// Options may be plain strings (used as both value and label) or
// { value, label } pairs (for cases where the stored value differs from
// what the user should see, e.g. vocal_language codes "zh" → "中文").
type FieldOption = string | { value: string; label: string };

interface FieldProps {
  label: string;
  editing: boolean;
  value: string;
  onChange: (v: string) => void;
  options?: FieldOption[];
  multiline?: boolean;
  small?: boolean;
}

const Field: React.FC<FieldProps> = ({
  label,
  editing,
  value,
  onChange,
  options,
  multiline,
  small,
}) => {
  const baseClass = `session-params__field${small ? ' session-params__field--small' : ''}`;
  if (editing) {
    if (options) {
      // Normalize to { value, label } pairs.
      const normalized: { value: string; label: string }[] = options.map((opt) =>
        typeof opt === 'string' ? { value: opt, label: opt } : opt,
      );
      // Ensure the current value is selectable. This handles two cases:
      //   1. Empty initial state (before the LLM fills the field).
      //   2. LLM-provided values not in the standard list (e.g. "Db major"
      //      when we only list "C# major"). Without this, the <select>
      //      would silently show the first option instead of the real value.
      const valueInOptions = normalized.some((opt) => opt.value === value);
      const allOptions = valueInOptions
        ? normalized
        : [{ value, label: value || '—' }, ...normalized];
      return (
        <div className={baseClass}>
          <label>{label}</label>
          <select value={value} onChange={(e) => onChange(e.target.value)}>
            {allOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      );
    }
    if (multiline) {
      return (
        <div className={baseClass}>
          <label>{label}</label>
          <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} />
        </div>
      );
    }
    return (
      <div className={baseClass}>
        <label>{label}</label>
        <input value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  }

  return (
    <div className={baseClass}>
      <label>{label}</label>
      <span className="session-params__field-value">{value || '—'}</span>
    </div>
  );
};

// ---- Dropdown option sets ----
//
// Predefined options for the Key and Vocal Language fields. These match
// the value formats the LLM is prompted to emit (see styleAdvisor.ts and
// creationAdvisor.ts), so LLM-produced plans slot in directly. Non-standard
// LLM values (e.g. "Db major") are still rendered via the Field component's
// "ensure current value is selectable" fallback.

// All 12 major + 12 minor keys, using sharps (matches the prompt examples
// "C major, A minor, F# minor"). Flats are equivalent and handled by the
// fallback if the LLM emits them.
const KEYSCALE_OPTIONS: string[] = [
  'C major', 'C# major', 'D major', 'D# major', 'E major', 'F major',
  'F# major', 'G major', 'G# major', 'A major', 'A# major', 'B major',
  'C minor', 'C# minor', 'D minor', 'D# minor', 'E minor', 'F minor',
  'F# minor', 'G minor', 'G# minor', 'A minor', 'A# minor', 'B minor',
];

// Vocal language codes the LLM outputs (zh/en/ja/ko/instrumental) mapped to
// display labels. Native names are used for languages (standard convention
// for language selectors); "instrumental" is localized via t() at the
// call site so it follows the UI locale.
const VOCAL_LANGUAGE_CODES = ['zh', 'en', 'ja', 'ko', 'instrumental'] as const;
const VOCAL_LANGUAGE_LABELS: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
};

// ---- Lyrics editor sub-component ----
//
// A purpose-built lyrics editor, not a plain textarea. Differences from a
// generic text editor:
//   1. Line-number gutter (left) — lyrics are line-oriented; numbering
//      helps the user reference "line N needs revision" in chat.
//   2. Monospace font + no-wrap — keeps `[Verse]`/`[Chorus]` tags and
//      lyric lines column-aligned, mirroring how ACE-Step parses them.
//   3. Stats footer — live line/char/section counts so the user can tell
//      at a glance whether the draft has enough content for the target
//      duration (rough rule: ~1 line ≈ 4-6s of vocal).
//   4. Always editable (no separate view/edit toggle) — editing lyrics is
//      the primary action, not an afterthought.
//   5. Section-tag awareness — counts `[...]`-only lines as sections
//      (Verse/Chorus/Bridge/Outro...), distinct from lyric lines.

interface LyricsEditorProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

const SECTION_TAG_RE = /^\s*\[[^\]]+\]\s*$/;

// ---- Tag data ----
//
// ACE-Step parses ENGLISH structure tags like `[Verse]` / `[Chorus]` — the
// model does not understand Chinese tags. So the buttons display Chinese
// (for user recognition) but insert the English tag text (for the model).
//
// Source: creationAdvisor.ts "Structure tags" + "Vocal control tags".

interface LyricsTag {
  zh: string; // Chinese display label
  en: string; // English tag content (without brackets)
}

const TAG_GROUPS: { title: string; tags: LyricsTag[] }[] = [
  {
    title: '基础结构',
    tags: [
      { zh: '前奏', en: 'Intro' },
      { zh: '主歌', en: 'Verse' },
      { zh: '主歌1', en: 'Verse 1' },
      { zh: '预副歌', en: 'Pre-Chorus' },
      { zh: '副歌', en: 'Chorus' },
      { zh: '桥段', en: 'Bridge' },
      { zh: '尾奏', en: 'Outro' },
    ],
  },
  {
    title: '动态段落',
    tags: [
      { zh: '渐强', en: 'Build' },
      { zh: '爆发', en: 'Drop' },
      { zh: '分解', en: 'Breakdown' },
    ],
  },
  {
    title: '器乐',
    tags: [
      { zh: '纯器乐', en: 'Instrumental' },
      { zh: '吉他独奏', en: 'Guitar Solo' },
      { zh: '钢琴间奏', en: 'Piano Interlude' },
    ],
  },
  {
    title: '特殊',
    tags: [
      { zh: '淡出', en: 'Fade Out' },
      { zh: '静默', en: 'Silence' },
    ],
  },
  {
    title: '人声控制',
    tags: [
      { zh: '沙哑', en: 'raspy vocal' },
      { zh: '轻语', en: 'whispered' },
      { zh: '假音', en: 'falsetto' },
      { zh: '强唱', en: 'powerful belting' },
      { zh: '念白', en: 'spoken word' },
      { zh: '和声', en: 'harmonies' },
    ],
  },
];

const LyricsEditor: React.FC<LyricsEditorProps> = ({ value, onChange, disabled }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lines = value.split('\n');
  const lineCount = lines.length;
  const charCount = value.length;
  const sectionCount = lines.filter((l) => SECTION_TAG_RE.test(l)).length;

  // Keep the line-number gutter scroll-synced with the textarea so they
  // stay aligned when the content overflows.
  const handleScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Insert a structure tag at the start of the line containing the cursor.
  // The tag is placed on its own line (`[Tag]\n`) because ACE-Step expects
  // structure tags to occupy a full line.
  const insertTag = (en: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const before = value.slice(0, start);
    const lineStart = before.lastIndexOf('\n') + 1;
    const tagText = `[${en}]\n`;
    const newValue = value.slice(0, lineStart) + tagText + value.slice(lineStart);
    onChange(newValue);
    // Restore cursor to just after the inserted tag, on the next line.
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = lineStart + tagText.length;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
        textareaRef.current.focus();
      }
    });
  };

  return (
    <div className="lyrics-editor">
      <div className="lyrics-editor__main">
        {/* Left: tag panel — Chinese buttons insert English tags. */}
        <div className="lyrics-editor__tag-panel">
          {TAG_GROUPS.map((group) => (
            <div key={group.title} className="lyrics-editor__tag-group">
              <div className="lyrics-editor__tag-group-title">{group.title}</div>
              <div className="lyrics-editor__tag-buttons">
                {group.tags.map((tag) => (
                  <button
                    key={tag.en}
                    type="button"
                    className="lyrics-editor__tag-btn"
                    onClick={() => insertTag(tag.en)}
                    disabled={disabled}
                    title={`插入 [${tag.en}]`}
                  >
                    {tag.zh}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {/* Right: line-number gutter + textarea */}
        <div className="lyrics-editor__body">
          <div className="lyrics-editor__gutter" ref={gutterRef} aria-hidden="true">
            {lines.map((_, i) => (
              <div key={i} className="lyrics-editor__line-num">{i + 1}</div>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            className="lyrics-editor__textarea"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={handleScroll}
            rows={12}
            disabled={disabled}
            spellCheck={false}
            wrap="off"
          />
        </div>
      </div>
      <div className="lyrics-editor__status">
        <span>{lineCount} 行</span>
        <span>·</span>
        <span>{charCount} 字</span>
        <span>·</span>
        <span>{sectionCount} 段落</span>
      </div>
    </div>
  );
};

// ---- Main component ----

interface SessionParamsPanelProps {
  /**
   * When true, the panel renders with a pulsing accent border to draw the
   * user's attention to the freshly generated plan. Driven by the store's
   * `planJustReady` flag (set when the LLM produces a new CreationPlan,
   * cleared on any user interaction or generation start).
   */
  highlight?: boolean;
}

export const SessionParamsPanel: React.FC<SessionParamsPanelProps> = ({ highlight = false }) => {
  const { t } = useI18n('acestep');
  const creationPlan = useAceStepStore((s) => s.activeSession?.creationPlan ?? null);
  const updatePlan = useAceStepStore((s) => s.updatePlan);
  const generateFromPlan = useAceStepStore((s) => s.generateFromPlan);
  const generationState = useAceStepStore((s) => s.generationState);
  const ditOverrides = useAceStepStore((s) => s.ditOverrides);
  const setDitOverrides = useAceStepStore((s) => s.setDitOverrides);
  const lyricsEditorOpen = useAceStepStore((s) => s.lyricsEditorOpen);
  const setLyricsEditorOpen = useAceStepStore((s) => s.setLyricsEditorOpen);
  const reviseLyricsWithAI = useAceStepStore((s) => s.reviseLyricsWithAI);
  const chatStreaming = useAceStepStore((s) => s.chatStreaming);
  const isSubagentStream = useAceStepStore((s) => s.isSubagentStream);

  const [editing, setEditing] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [lyricsReviseInput, setLyricsReviseInput] = useState('');

  const isGenerating =
    generationState === 'generating' || generationState === 'loading-models';

  if (!creationPlan) {
    return (
      <div className="session-params session-params--empty">
        <div className="session-params__empty-icon">
          <Music size={24} />
        </div>
        <p>{t('chatCreate.planEmpty', { defaultValue: 'No plan yet. Chat to generate one.' })}</p>
      </div>
    );
  }

  // The "Generate song" button stays disabled until the plan has the
  // required inference fields. Lyrics alone are not enough — caption,
  // BPM, and duration must all be present (non-empty / > 0). This prevents
  // the user from starting generation with a half-formed plan (e.g. right
  // after the lyrics subagent finishes, before the LLM has filled in the
  // other fields).
  const planComplete =
    creationPlan.caption.trim().length > 0 &&
    creationPlan.bpm > 0 &&
    creationPlan.duration > 0;

  const handleGenerate = async () => {
    await generateFromPlan();
  };

  return (
    <div className={`session-params${highlight ? ' session-params--ready' : ''}`}>
      <div className="session-params__header">
        <span className="session-params__title">
          <Music size={14} />
          {t('chatCreate.planTitle', { defaultValue: 'Creation Plan' })}
          {highlight && (
            <span className="session-params__ready-badge">
              {t('chatCreate.planReadyBadge', { defaultValue: '新' })}
            </span>
          )}
        </span>
        <div className="session-params__actions">
          <button
            className="session-params__action-btn"
            onClick={() => setEditing(!editing)}
            disabled={isGenerating}
            title={editing ? t('common.done', { defaultValue: 'Done' }) : t('chatCreate.edit', { defaultValue: 'Edit' })}
          >
            {editing ? <Check size={14} /> : <Edit3 size={14} />}
          </button>
        </div>
      </div>

      <div className="session-params__body">
        {/* Caption */}
        <Field
          label={t('chatCreate.caption', { defaultValue: 'Caption' })}
          editing={editing}
          value={creationPlan.caption}
          onChange={(v) => updatePlan({ caption: v })}
          multiline
        />

        {/* BPM / Duration / Key / Language row */}
        <div className="session-params__row">
          <Field
            label={t('chatCreate.bpm', { defaultValue: 'BPM' })}
            editing={editing}
            value={String(creationPlan.bpm || '')}
            onChange={(v) => updatePlan({ bpm: parseInt(v) || 0 })}
            small
          />
          <Field
            label={t('chatCreate.duration', { defaultValue: 'Duration' })}
            editing={editing}
            value={String(creationPlan.duration || '')}
            onChange={(v) => updatePlan({ duration: parseInt(v) || 0 })}
            small
          />
          <Field
            label={t('chatCreate.keyScale', { defaultValue: 'Key' })}
            editing={editing}
            value={creationPlan.keyscale}
            onChange={(v) => updatePlan({ keyscale: v })}
            options={KEYSCALE_OPTIONS}
            small
          />
          <Field
            label={t('chatCreate.vocalLanguage', { defaultValue: 'Vocal' })}
            editing={editing}
            value={creationPlan.vocal_language}
            onChange={(v) => updatePlan({ vocal_language: v })}
            options={VOCAL_LANGUAGE_CODES.map((code) => ({
              value: code,
              label:
                VOCAL_LANGUAGE_LABELS[code] ??
                t('chatCreate.vocalLanguageInstrumental', {
                  defaultValue: '器乐（无人声）',
                }),
            }))}
            small
          />
        </div>

        {/* Lyrics — preview + "edit" button that opens a modal dialog.
            The full editor (tag panel + line numbers + textarea) lives in
            a Modal because the right sidebar is too narrow for it. */}
        <div className="session-params__lyrics">
          <div className="session-params__lyrics-header">
            <span className="session-params__lyrics-label">
              {t('chatCreate.lyrics', { defaultValue: '歌词草稿' })}
            </span>
            <button
              type="button"
              className="session-params__lyrics-edit-btn"
              onClick={() => setLyricsEditorOpen(true)}
              disabled={isGenerating}
            >
              <Edit3 size={12} />
              {t('chatCreate.editLyrics', { defaultValue: '编辑歌词' })}
            </button>
          </div>
          <pre
            className="session-params__lyrics-preview"
            onClick={() => !isGenerating && setLyricsEditorOpen(true)}
          >
            {creationPlan.lyrics?.trim()
              ? creationPlan.lyrics
              : t('chatCreate.lyricsEmpty', { defaultValue: '点击编辑歌词…' })}
          </pre>
        </div>

        {/* Lyrics editor modal — full-size editor with tag panel + AI revise
            input at the bottom. The modal is driven by store.lyricsEditorOpen
            so it can be opened both from the "编辑歌词" button and from the
            "需要修改歌词" ask option in the chat flow. */}
        <Modal
          isOpen={lyricsEditorOpen}
          onClose={() => setLyricsEditorOpen(false)}
          title={t('chatCreate.lyricsEditorTitle', { defaultValue: '歌词编辑器' })}
          size="large"
          contentClassName="lyrics-editor-modal-content"
        >
          <LyricsEditor
            value={creationPlan.lyrics}
            onChange={(v) => updatePlan({ lyrics: v })}
            disabled={isGenerating}
          />
          {/* AI revise bar — user describes a revision direction and the
              LLM rewrites the lyrics accordingly. Disabled while the
              subagent is running (chatStreaming + isSubagentStream). */}
          <div className="lyrics-editor__revise">
            <input
              type="text"
              className="lyrics-editor__revise-input"
              value={lyricsReviseInput}
              onChange={(e) => setLyricsReviseInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  const text = lyricsReviseInput.trim();
                  if (!text || chatStreaming) return;
                  void reviseLyricsWithAI(text);
                  setLyricsReviseInput('');
                }
              }}
              placeholder={t('chatCreate.lyricsRevisePlaceholder', {
                defaultValue: '说出你的修改方向，让AI修改',
              })}
              disabled={chatStreaming || isGenerating}
            />
            <button
              type="button"
              className="lyrics-editor__revise-btn"
              onClick={() => {
                const text = lyricsReviseInput.trim();
                if (!text || chatStreaming) return;
                void reviseLyricsWithAI(text);
                setLyricsReviseInput('');
              }}
              disabled={chatStreaming || isGenerating || !lyricsReviseInput.trim()}
            >
              {chatStreaming && isSubagentStream ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Sparkles size={14} />
              )}
              {t('chatCreate.lyricsReviseBtn', { defaultValue: 'AI 修改' })}
            </button>
          </div>
        </Modal>

        {/* Reasoning */}
        {creationPlan.reasoning && (
          <div className="session-params__reasoning">
            <span className="session-params__field-label">
              {t('chatCreate.reasoning', { defaultValue: 'Reasoning' })}
            </span>
            <p>{creationPlan.reasoning}</p>
          </div>
        )}

        {/* Advanced DiT parameters (collapsible).
            Lets the user fine-tune inference_steps / guidance_scale / shift.
            Defaults follow official INFERENCE.md for the Base/SFT model.
            Each hint documents the parameter's effect, not just its range:
              - inference_steps: denoise steps; higher = better quality but
                slower (official range 32-64, default 50).
              - guidance_scale: CFG scale; higher = stronger text adherence
                (caption/lyrics followed more strictly, diction clearer).
                Official range 5.0-9.0, default 7.0. Base/SFT only.
              - shift: timestep shift factor; redistributes denoise steps
                across noise levels. Official range 1.0-5.0, default 1.0.
                Rarely needs adjustment for Base model. */}
        <div className="session-params__advanced">
          <button
            type="button"
            className="session-params__advanced-toggle"
            onClick={() => setAdvancedExpanded(!advancedExpanded)}
            aria-expanded={advancedExpanded}
          >
            {advancedExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span>{t('chatCreate.advancedTitle', { defaultValue: '高级参数' })}</span>
          </button>
          {advancedExpanded && (
            <div className="session-params__advanced-body">
              <div className="session-params__field session-params__field--small">
                <label>
                  {t('chatCreate.inferenceSteps', { defaultValue: '推理步数' })}
                  <span className="session-params__field-hint">
                    {t('chatCreate.inferenceStepsHint', {
                      defaultValue: '默认 50（32-64）。去噪步数，越高质量越好但更慢',
                    })}
                  </span>
                </label>
                <input
                  type="number"
                  min={32}
                  max={200}
                  step={1}
                  value={ditOverrides.inferenceSteps}
                  onChange={(e) =>
                    setDitOverrides({
                      inferenceSteps: Math.max(32, parseInt(e.target.value, 10) || 50),
                    })
                  }
                  disabled={isGenerating}
                />
              </div>
              <div className="session-params__field session-params__field--small">
                <label>
                  {t('chatCreate.guidanceScale', { defaultValue: '引导强度' })}
                  <span className="session-params__field-hint">
                    {t('chatCreate.guidanceScaleHint', {
                      defaultValue: '官方 7.0（5.0-9.0）。越高越遵循 caption，咬字更清晰。人声被伴奏盖过时可提高到 8.5-9.0（仅 Base/SFT 模型有效，turbo 无效）',
                    })}
                  </span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={15}
                  step={0.5}
                  value={ditOverrides.guidanceScale}
                  onChange={(e) =>
                    setDitOverrides({
                      guidanceScale: parseFloat(e.target.value) || 0,
                    })
                  }
                  disabled={isGenerating}
                />
              </div>
              <div className="session-params__field session-params__field--small">
                <label>
                  {t('chatCreate.shift', { defaultValue: 'Shift' })}
                  <span className="session-params__field-hint">
                    {t('chatCreate.shiftHint', {
                      defaultValue: '官方 1.0（1.0-5.0）。时间步偏移，一般无需调整',
                    })}
                  </span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={5}
                  step={0.5}
                  value={ditOverrides.shift}
                  onChange={(e) =>
                    setDitOverrides({
                      shift: parseFloat(e.target.value) || 1.0,
                    })
                  }
                  disabled={isGenerating}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Generate button — disabled while generating OR when the plan is
          incomplete (missing caption / BPM / duration). Lyrics alone are
          not enough to start generation. */}
      <div className="session-params__footer">
        <MusicModelSelector />
        <button
          className="session-params__generate"
          onClick={handleGenerate}
          disabled={isGenerating || !planComplete}
          title={
            !planComplete
              ? t('chatCreate.planIncompleteHint', {
                  defaultValue: '请先在对话中确认歌词并生成其他参数（曲风/BPM/时长）',
                })
              : undefined
          }
        >
          {isGenerating ? (
            <Loader2 size={16} className="spin" />
          ) : (
            <Play size={16} />
          )}
          <span>{t('chatCreate.confirmGenerate', { defaultValue: 'Generate' })}</span>
        </button>
      </div>
    </div>
  );
};
