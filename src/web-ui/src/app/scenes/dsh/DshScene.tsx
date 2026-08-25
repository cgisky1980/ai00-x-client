import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, CircleStop, Plus, RefreshCw, Send, User, Wrench } from 'lucide-react';
import { Button } from '@/component-library';
import { useDshChat } from './hooks/useDshChat';
import type { DshMessage } from '@/infrastructure/api/service-api/DshAPI';
import './DshScene.scss';

/** 消息气泡（用户/助手）。 */
const MessageBubble: React.FC<{ message: DshMessage }> = ({ message }) => {
  const { t } = useTranslation('scenes/dsh');
  const isUser = message.role === 'user';
  return (
    <div className={`ai00-x-dsh-scene__msg ${isUser ? 'is-user' : 'is-assistant'}`}>
      <div className="ai00-x-dsh-scene__msg-avatar">
        {isUser ? <User size={13} /> : <Bot size={13} />}
      </div>
      <div className="ai00-x-dsh-scene__msg-body">
        {message.reasoning && (
          <details className="ai00-x-dsh-scene__msg-reasoning">
            <summary>{t('chat.reasoning')}</summary>
            <div>{message.reasoning}</div>
          </details>
        )}
        {message.toolCalls.map(tc => (
          <details key={tc.id} className="ai00-x-dsh-scene__msg-tool">
            <summary>
              <Wrench size={11} />
              <span>{tc.name}</span>
            </summary>
            <pre>{tc.arguments}</pre>
          </details>
        ))}
        {message.text && (
          <div className={`ai00-x-dsh-scene__msg-text${message.streaming ? ' is-streaming' : ''}`}>
            {message.text}
          </div>
        )}
        {message.streaming && !message.text && (
          <div className="ai00-x-dsh-scene__msg-pending">{t('chat.thinking')}</div>
        )}
        {message.error && (
          <div className="ai00-x-dsh-scene__msg-error">{message.error}</div>
        )}
      </div>
    </div>
  );
};

/** dsh Agent 场景：自有 UI 直连 dsh sidecar（不用 dsh 自带 Web UI）。 */
const DshScene: React.FC = () => {
  const { t } = useTranslation('scenes/dsh');
  const {
    phase,
    wsConnected,
    sessions,
    sessionsLoading,
    currentSessionId,
    messages,
    sending,
    error,
    openSession,
    newSession,
    send,
    stop,
    refreshSessions,
  } = useDshChat();

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新消息自动滚底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    send(text);
  };

  const phaseLabel = (() => {
    switch (phase?.phase) {
      case 'installing':
        return t('status.installing', { stage: phase.stage ?? '' });
      case 'failed':
        return t('status.failed', { error: phase.error ?? '' });
      case 'running':
        return t('status.running');
      case 'ready':
        return t('status.ready');
      default:
        return t('status.starting');
    }
  })();

  return (
    <div className="ai00-x-dsh-scene">
      <aside className="ai00-x-dsh-scene__sidebar">
        <div className="ai00-x-dsh-scene__sidebar-header">
          <span className="ai00-x-dsh-scene__sidebar-title">{t('sessions.title')}</span>
          <Button variant="ghost" size="small" onClick={newSession} aria-label={t('sessions.new')}>
            <Plus size={14} />
          </Button>
        </div>
        <div className="ai00-x-dsh-scene__session-list">
          {sessionsLoading && (
            <div className="ai00-x-dsh-scene__session-empty">{t('sessions.loading')}</div>
          )}
          {!sessionsLoading && sessions.length === 0 && (
            <div className="ai00-x-dsh-scene__session-empty">{t('sessions.empty')}</div>
          )}
          {sessions.map(s => (
            <button
              key={s.sessionId}
              type="button"
              className={`ai00-x-dsh-scene__session-item${
                s.sessionId === currentSessionId ? ' is-active' : ''
              }`}
              onClick={() => openSession(s.sessionId)}
            >
              <span className="ai00-x-dsh-scene__session-name">
                {s.projections?.values?.title ?? s.sessionId.slice(8, 16)}
              </span>
              <span className="ai00-x-dsh-scene__session-meta">
                {s.running && <span className="ai00-x-dsh-scene__dot" />}
                {new Date(s.updatedAt).toLocaleTimeString()}
              </span>
            </button>
          ))}
        </div>
        <div className="ai00-x-dsh-scene__sidebar-footer">
          <span
            className={`ai00-x-dsh-scene__ws-dot${wsConnected ? ' is-on' : ''}`}
            title={wsConnected ? t('status.wsOn') : t('status.wsOff')}
          />
          <span className="ai00-x-dsh-scene__phase">{phaseLabel}</span>
          <Button variant="ghost" size="small" onClick={refreshSessions} aria-label={t('sessions.refresh')}>
            <RefreshCw size={12} />
          </Button>
        </div>
      </aside>

      <section className="ai00-x-dsh-scene__main">
        {!currentSessionId ? (
          <div className="ai00-x-dsh-scene__placeholder">
            <Bot size={32} />
            <p>{t('chat.placeholder')}</p>
            <Button variant="primary" size="small" onClick={newSession}>
              <Plus size={14} />
              {t('sessions.new')}
            </Button>
          </div>
        ) : (
          <>
            <div className="ai00-x-dsh-scene__messages" ref={scrollRef}>
              {messages.length === 0 && (
                <div className="ai00-x-dsh-scene__messages-empty">{t('chat.empty')}</div>
              )}
              {messages.map(m => (
                <MessageBubble key={m.id} message={m} />
              ))}
            </div>
            {error && <div className="ai00-x-dsh-scene__error">{error}</div>}
            <div className="ai00-x-dsh-scene__composer">
              <textarea
                className="ai00-x-dsh-scene__input"
                value={input}
                placeholder={t('chat.inputPlaceholder')}
                rows={2}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <div className="ai00-x-dsh-scene__composer-actions">
                {sending ? (
                  <Button variant="secondary" size="small" onClick={stop}>
                    <CircleStop size={14} />
                    {t('chat.stop')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="small"
                    onClick={handleSend}
                    disabled={!input.trim()}
                  >
                    <Send size={14} />
                    {t('chat.send')}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
};

export default DshScene;
