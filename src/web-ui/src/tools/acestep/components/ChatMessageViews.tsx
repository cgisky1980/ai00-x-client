/**
 * ChatMessageViews — typed renderers for the acestep chat column.
 *
 * ChatCreateView dispatches each visible ChatMessage to one of these 4
 * components based on role + kind + hasPlan. Splitting them out keeps the
 * view file readable and lets each variant own its layout + styling.
 *
 *   LyricsCard    — assistant, kind='lyrics'  → collapsible lyrics draft
 *   PlanCard      — assistant, hasPlan=true   → collapsible creation plan
 *   StatusChip    — assistant, kind='status'  → one-line status indicator
 *   ChatBubble    — everything else           → normal user/assistant bubble
 */

import React from 'react';
import { ArrowUp, FileText, Music2, Search } from 'lucide-react';
import { Markdown } from '@/component-library/components/Markdown/Markdown';
import { useI18n } from '@/infrastructure/i18n';
import { CollapsibleBlock } from './CollapsibleBlock';
import type { ChatMessage } from '../types';

/** Count non-empty lines (for summary text). */
function countLines(content: string): number {
  return content.split('\n').filter((l) => l.trim().length > 0).length;
}

// ============================================================================
// LyricsCard — lyrics subagent output, collapsed by default after streaming
// ============================================================================

export const LyricsCard: React.FC<{ msg: ChatMessage }> = ({ msg }) => {
  const { t } = useI18n('acestep');
  const lineCount = countLines(msg.content);
  const firstLine = msg.content.split('\n')[0]?.trim() ?? '';

  return (
    <div className="chat-create__lyrics-card">
      <CollapsibleBlock
        title={t('chatCreate.cardLyricsTitle', { defaultValue: '歌词草稿' })}
        summary={t('chatCreate.cardLyricsSummary', {
          defaultValue: '{{count}} 行 · {{preview}}',
          count: lineCount,
          preview: firstLine.slice(0, 30),
        })}
        icon={<Music2 size={12} />}
        defaultExpanded={!!msg.streaming}
      >
        <Markdown
          content={msg.content}
          isStreaming={msg.streaming}
          className="chat-create__card-markdown"
        />
      </CollapsibleBlock>
    </div>
  );
};

// ============================================================================
// PlanCard — parsed CreationPlan, shows field table + folded lyrics
// ============================================================================

export const PlanCard: React.FC<{ msg: ChatMessage }> = ({ msg }) => {
  const { t } = useI18n('acestep');
  const plan = msg.plan;
  if (!plan) return null;

  const summaryParts: string[] = [];
  if (plan.caption) summaryParts.push(plan.caption);
  if (plan.bpm && plan.bpm > 0) summaryParts.push(`${plan.bpm} BPM`);
  if (plan.duration && plan.duration > 0) summaryParts.push(`${plan.duration}s`);
  const summary = summaryParts.join(' · ');

  return (
    <div className="chat-create__plan-card">
      <CollapsibleBlock
        title={t('chatCreate.cardPlanTitle', { defaultValue: '创作计划' })}
        summary={summary}
        icon={<FileText size={12} />}
        defaultExpanded={false}
      >
        <dl className="chat-create__plan-fields">
          {plan.caption && (
            <div className="chat-create__plan-row">
              <dt>{t('chatCreate.caption', { defaultValue: 'Caption' })}</dt>
              <dd>{plan.caption}</dd>
            </div>
          )}
          {plan.bpm > 0 && (
            <div className="chat-create__plan-row">
              <dt>{t('chatCreate.bpm', { defaultValue: 'BPM' })}</dt>
              <dd>{plan.bpm}</dd>
            </div>
          )}
          {plan.duration > 0 && (
            <div className="chat-create__plan-row">
              <dt>{t('chatCreate.duration', { defaultValue: 'Duration' })}</dt>
              <dd>{plan.duration}s</dd>
            </div>
          )}
          {plan.keyscale && (
            <div className="chat-create__plan-row">
              <dt>{t('chatCreate.keyScale', { defaultValue: 'Key' })}</dt>
              <dd>{plan.keyscale}</dd>
            </div>
          )}
          {plan.vocal_language && (
            <div className="chat-create__plan-row">
              <dt>{t('chatCreate.vocalLanguage', { defaultValue: 'Vocal Lang' })}</dt>
              <dd>{plan.vocal_language}</dd>
            </div>
          )}
        </dl>
        {plan.lyrics && (
          <div className="chat-create__plan-lyrics">
            <Markdown
              content={plan.lyrics}
              className="chat-create__card-markdown"
            />
          </div>
        )}
        {plan.reasoning && (
          <div className="chat-create__plan-reasoning">
            <Markdown
              content={plan.reasoning}
              className="chat-create__card-markdown"
            />
          </div>
        )}
      </CollapsibleBlock>
    </div>
  );
};

// ============================================================================
// StatusChip — one-line status indicator (searching / calling subagent)
// ============================================================================

export const StatusChip: React.FC<{ msg: ChatMessage }> = ({ msg }) => {
  const text = msg.content;
  const icon = text.startsWith('🔍') ? (
    <Search size={11} />
  ) : (
    <Music2 size={11} />
  );
  return (
    <div className="chat-create__status-chip">
      <span className="chat-create__status-chip-icon">{icon}</span>
      <span className="chat-create__status-chip-text">{text}</span>
    </div>
  );
};

// ============================================================================
// ChatBubble — normal user/assistant bubble (with askOptions + Markdown)
// ============================================================================

interface ChatBubbleProps {
  msg: ChatMessage;
  isBusy: boolean;
  askCustomInput: string;
  setAskCustomInput: (v: string) => void;
  onAskOptionClick: (option: string) => void;
  onAskCustomSubmit: () => void;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({
  msg,
  isBusy,
  askCustomInput,
  setAskCustomInput,
  onAskOptionClick,
  onAskCustomSubmit,
}) => {
  const { t } = useI18n('acestep');
  const isAssistant = msg.role === 'assistant';

  return (
    <div className={`chat-create__bubble chat-create__bubble--${msg.role}`}>
      <div className="chat-create__bubble-content">
        {/* Streaming with no content yet → typing indicator. */}
        {msg.streaming && msg.content.length === 0 ? (
          <div className="chat-create__typing">
            <span />
            <span />
            <span />
          </div>
        ) : isAssistant ? (
          /* Assistant text → Markdown (lyrics drafts have their own
             LyricsCard renderer, so we no longer fold long explanations
             into a separate "details" card here — that duplicated the
             lyrics card and hid the LLM's reasoning behind a toggle). */
          <div className="chat-create__bubble-text">
            <Markdown
              content={msg.content}
              isStreaming={msg.streaming}
              className="chat-create__bubble-markdown"
            />
          </div>
        ) : (
          /* User text → plain text (preserve original pre-wrap behavior). */
          <div className="chat-create__bubble-text">{msg.content}</div>
        )}

        {/* Inline ask options (assistant only). */}
        {msg.askOptions && msg.askOptions.length > 0 && (
          <div className="chat-create__ask">
            <div className="chat-create__ask-options">
              {msg.askOptions.map((option, idx) => (
                <button
                  key={`${msg.id}-${idx}-${option}`}
                  className={`chat-create__ask-option ${msg.askAnswered ? 'chat-create__ask-option--answered' : ''}`}
                  onClick={() => onAskOptionClick(option)}
                  disabled={msg.askAnswered || isBusy}
                >
                  {option}
                </button>
              ))}
            </div>
            {!msg.askAnswered && (
              <div className="chat-create__ask-custom">
                <input
                  type="text"
                  className="chat-create__ask-custom-input"
                  value={askCustomInput}
                  onChange={(e) => setAskCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      onAskCustomSubmit();
                    }
                  }}
                  placeholder={t('lego.askCustomPlaceholder', {
                    defaultValue: '或者输入你的回答...',
                  })}
                  disabled={isBusy}
                />
                <button
                  className="chat-create__ask-custom-btn"
                  onClick={onAskCustomSubmit}
                  disabled={!askCustomInput.trim() || isBusy}
                >
                  <ArrowUp size={12} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Error badge. */}
        {msg.error && (
          <div className="chat-create__bubble-error">{msg.error}</div>
        )}
      </div>
    </div>
  );
};
