/**
 * ChatCreateView — LLM-driven conversational music creation.
 *
 * Two-column layout (session list moved to workspace NavPanel):
 *   Left   — chat column (messages + input)
 *   Right  — sidebar (SessionParamsPanel on top, SessionAudioList below)
 *
 * Flow: user describes music → Ai00-X LLM streams a response (with a
 * CreationPlan JSON) → plan appears in right panel → user reviews/edits →
 * one-click generate → DiT synthesizes audio → audio appears in right panel.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Sparkles,
  Loader2,
  ArrowUp,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useAceStepStore } from '../store/acestepStore';
import { ModelSelector } from '@/flow_chat/components/ModelSelector';
import { SessionParamsPanel } from '../components/SessionParamsPanel';
import { SessionAudioList } from '../components/SessionAudioList';
import { LegoFlowPanel } from '../components/LegoFlowPanel';
import { LyricsCard, PlanCard, StatusChip, ChatBubble } from '../components/ChatMessageViews';
import './ChatCreateView.scss';
// Reuse flow_chat ChatInput styles for visual consistency.
import '@/flow_chat/components/ChatInput.scss';

const EMPTY_ARRAY: never[] = [];

const ChatCreateView: React.FC = () => {
  const { t } = useI18n('acestep');
  const [input, setInput] = useState('');
  const [askCustomInput, setAskCustomInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Read from activeSession instead of the old global fields.
  const chatMessages = useAceStepStore((s) => s.activeSession?.chatMessages ?? EMPTY_ARRAY);
  const chatStreaming = useAceStepStore((s) => s.chatStreaming);
  const chatError = useAceStepStore((s) => s.chatError);
  const sendChatMessage = useAceStepStore((s) => s.sendChatMessage);
  const activeSessionId = useAceStepStore((s) => s.activeSessionId);
  // Session mode drives right-sidebar layout: text2music shows params + audio
  // list, lego shows the multi-step flow panel.
  const sessionMode = useAceStepStore((s) => s.activeSession?.mode ?? 'text2music');

  const generationState = useAceStepStore((s) => s.generationState);
  const progress = useAceStepStore((s) => s.progress);
  const error = useAceStepStore((s) => s.error);

  // Plan-ready reminder: the right-side SessionParamsPanel renders its own
  // highlight (pulsing accent border) when `planJustReady` is true. We no
  // longer render an interactive banner in the chat column — the reminder
  // lives entirely in the right panel.
  const planJustReady = useAceStepStore((s) => s.planJustReady);

  const isGenerating =
    generationState === 'generating' || generationState === 'loading-models';
  const isBusy = chatStreaming || isGenerating;

  // Auto-scroll to bottom when new messages arrive or streaming updates.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleSend = async () => {
    if (!input.trim() || isBusy) return;
    const text = input.trim();
    setInput('');
    await sendChatMessage(text);
  };

  // When the user clicks an ask option (inline in the assistant bubble),
  // auto-send it as a user message — EXCEPT "需要修改歌词" which opens the
  // lyrics editor modal instead of sending a chat message (the user wants
  // to revise lyrics with an AI instruction inside the editor, not chat).
  const handleAskOptionClick = async (option: string) => {
    if (isBusy) return;
    if (option === '需要修改歌词') {
      useAceStepStore.getState().setLyricsEditorOpen(true);
      return;
    }
    await sendChatMessage(option);
  };

  // When the user types a custom answer in the "Other" input and submits.
  const handleAskCustomSubmit = async () => {
    const text = askCustomInput.trim();
    if (!text || isBusy) return;
    setAskCustomInput('');
    await sendChatMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-create chat-create--split">
      <div className="chat-create__body">
        {/* Chat column (session list is in workspace NavPanel) */}
        <div className="chat-create__chat">
          {/* Chat error */}
          {chatError && (
            <div className="chat-create__error">
              <span>{chatError}</span>
            </div>
          )}

          {/* Message list */}
          <div className="chat-create__messages">
            {chatMessages.length === 0 && !chatStreaming && (
              <div className="chat-create__empty">
                <div className="chat-create__empty-icon">
                  <Sparkles size={28} />
                </div>
                <p>{t('chatCreate.emptyHint', { defaultValue: 'Describe the music you want to create.' })}</p>
                <div className="chat-create__empty-prompts">
                  {[
                    'Upbeat electronic dance at 128 BPM',
                    'Calm piano melody for studying',
                    'Rock ballad with guitar solo',
                    'Lo-fi hip hop beat, chill vibes',
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      className="chat-create__empty-prompt"
                      onClick={() => setInput(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chatMessages
              .filter((msg) => !msg.hidden)
              .map((msg) => {
                // Dispatch to a specialized renderer based on message kind.
                // Internal/system messages (hidden=true) are already filtered
                // out above so they're fed to the LLM but never shown to the
                // user.
                if (msg.role === 'assistant' && msg.kind === 'lyrics' && msg.content) {
                  return <LyricsCard key={msg.id} msg={msg} />;
                }
                if (msg.role === 'assistant' && msg.hasPlan) {
                  return <PlanCard key={msg.id} msg={msg} />;
                }
                if (msg.role === 'assistant' && msg.kind === 'status') {
                  return <StatusChip key={msg.id} msg={msg} />;
                }
                return (
                  <ChatBubble
                    key={msg.id}
                    msg={msg}
                    isBusy={isBusy}
                    askCustomInput={askCustomInput}
                    setAskCustomInput={setAskCustomInput}
                    onAskOptionClick={handleAskOptionClick}
                    onAskCustomSubmit={handleAskCustomSubmit}
                  />
                );
              })}
            <div ref={messagesEndRef} />
          </div>

          {/* Generation progress */}
          {isGenerating && progress && (
            <div className="chat-create__progress">
              <div className="chat-create__progress-bar">
                <div
                  className="chat-create__progress-fill"
                  style={{
                    width: `${progress.total > 0 ? (progress.step / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className="chat-create__progress-text">
                {progress.stageName} {progress.step}/{progress.total}
              </span>
            </div>
          )}

          {/* Generation error */}
          {error && generationState === 'error' && (
            <div className="chat-create__error">
              <span>{error}</span>
            </div>
          )}

          {/* Input bar — reuses flow_chat ChatInput styles (ai00-x-chat-input)
              for visual consistency. Structure: box > input-area + actions. */}
          <div className="ai00-x-chat-input chat-create__input-bar-wrap">
            <div className="ai00-x-chat-input__box">
              <div className="ai00-x-chat-input__input-area">
                <textarea
                  className="chat-create__input rich-text-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t('chatCreate.placeholder', { defaultValue: 'Describe the music you want...' })}
                  rows={1}
                  disabled={isBusy}
                />
              </div>
              <div className="ai00-x-chat-input__actions">
                <div className="ai00-x-chat-input__actions-left">
                  <ModelSelector currentMode="music" sessionId={activeSessionId || undefined} />
                </div>
                <div className="ai00-x-chat-input__actions-right">
                  <button
                    className="ai00-x-chat-input__send-button"
                    onClick={handleSend}
                    disabled={!input.trim() || isBusy}
                  >
                    {chatStreaming ? (
                      <Loader2 size={11} className="spin" />
                    ) : (
                      <ArrowUp size={11} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right column: params + audio (text2music) OR lego flow panel (lego) */}
        <div className="chat-create__sidebar" ref={sidebarRef}>
          {sessionMode === 'lego' ? (
            <LegoFlowPanel />
          ) : (
            <>
              <SessionParamsPanel highlight={planJustReady} />
              <SessionAudioList />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatCreateView;
