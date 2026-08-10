/**
 * Floating mini chat — circular button in bottom-right that expands to an
 * always-expanded ToolbarMode-style conversation panel with FlowChat.
 * Used in non-agent scenes only; agent scene uses centered ChatInput.
 *
 * When opened the button disappears and the panel springs into view;
 * closing reverses the animation and restores the button.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  X,
  Check,
  Square,
  ArrowUp,
  ChevronDown,
  Plus
} from 'lucide-react';
import { flowChatStore } from '../../flow_chat/store/FlowChatStore';
import { syncSessionToModernStore } from '../../flow_chat/services/storeSync';
import { useToolbarModeContext } from '../../flow_chat/components/toolbar-mode/ToolbarModeContext';
import type { FlowChatState } from '../../flow_chat/types/flow-chat';
import { compareSessionsForDisplay } from '../../flow_chat/utils/sessionOrdering';
import { ModernFlowChatContainer } from '../../flow_chat/components/modern/ModernFlowChatContainer';
import { Tooltip, Input } from '@/component-library';
import './FloatingMiniChat.scss';

export const FloatingMiniChat: React.FC = () => {
  const { t } = useTranslation('flow-chat');
  const { toolbarState } = useToolbarModeContext();

  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() =>
    flowChatStore.getState()
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const sessionPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = flowChatStore.subscribe((state) => {
      setFlowChatState(state);
    });
    return () => unsubscribe();
  }, []);

  const sessionTitle = useMemo(() => {
    const activeSession = flowChatState.activeSessionId
      ? flowChatState.sessions.get(flowChatState.activeSessionId)
      : undefined;
    return activeSession?.title || t('session.new');
  }, [flowChatState, t]);

  const sessions = useMemo(() => {
    return Array.from(flowChatState.sessions.values())
      .sort(compareSessionsForDisplay)
      .slice(0, 10);
  }, [flowChatState]);

  const currentStreamState = useMemo(() => {
    const activeSession = flowChatState.activeSessionId
      ? flowChatState.sessions.get(flowChatState.activeSessionId)
      : undefined;

    if (!activeSession || !activeSession.dialogTurns || activeSession.dialogTurns.length === 0) {
      return { isStreaming: false };
    }

    const lastTurn = activeSession.dialogTurns[activeSession.dialogTurns.length - 1];
    const isStreaming =
      lastTurn.status === 'processing' ||
      lastTurn.status === 'finishing' ||
      lastTurn.status === 'image_analyzing';
    return { isStreaming };
  }, [flowChatState]);

  const handleOpen = useCallback(() => {
    // Sync the active session into modernFlowChatStore so the panel shows
    // up-to-date content (it may have been streaming while the panel was closed).
    const state = flowChatStore.getState();
    if (state.activeSessionId) {
      syncSessionToModernStore(state.activeSessionId);
    }
    setIsOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setShowSessionPicker(false);
  }, []);

  const handleSwitchSession = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    e.preventDefault();
    flowChatStore.switchSession(sessionId);
    syncSessionToModernStore(sessionId);
    setShowSessionPicker(false);
  }, []);

  const handleCancel = useCallback(() => {
    window.dispatchEvent(new CustomEvent('toolbar-cancel-task'));
  }, []);

  const handleConfirm = useCallback(() => {
    if (toolbarState.pendingToolId) {
      window.dispatchEvent(
        new CustomEvent('toolbar-tool-confirm', { detail: { toolId: toolbarState.pendingToolId } })
      );
    }
  }, [toolbarState.pendingToolId]);

  const handleReject = useCallback(() => {
    if (toolbarState.pendingToolId) {
      window.dispatchEvent(
        new CustomEvent('toolbar-tool-reject', { detail: { toolId: toolbarState.pendingToolId } })
      );
    }
  }, [toolbarState.pendingToolId]);

  const handleCreateSession = useCallback(() => {
    window.dispatchEvent(new CustomEvent('toolbar-create-session'));
  }, []);

  const handleSendMessage = useCallback(() => {
    const message = inputValue.trim();
    if (message) {
      window.dispatchEvent(
        new CustomEvent('toolbar-send-message', {
          detail: { message, sessionId: flowChatState.activeSessionId }
        })
      );
      setInputValue('');
    }
  }, [inputValue, flowChatState.activeSessionId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (showSessionPicker) {
          setShowSessionPicker(false);
        } else {
          handleClose();
        }
      }
    },
    [handleSendMessage, showSessionPicker, handleClose]
  );

  // Close session picker when clicking outside it
  useEffect(() => {
    if (!isOpen || !showSessionPicker) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (sessionPickerRef.current?.contains(target)) return;
      if (target.closest?.('.ai00-x-fmc__title-btn')) return;
      setShowSessionPicker(false);
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, showSessionPicker]);

  const panelClassName = [
    'ai00-x-fmc__panel',
    isOpen && 'ai00-x-fmc__panel--open',
    currentStreamState.isStreaming && 'ai00-x-fmc__panel--processing',
    toolbarState.hasError && 'ai00-x-fmc__panel--error',
    toolbarState.hasPendingConfirmation && 'ai00-x-fmc__panel--confirm'
  ]
    .filter(Boolean)
    .join(' ');

  // Detect overlay mode so the mini chat can be marked as no-penetrate
  // for the Rust overlay thread's mouse-hit-testing.
  const isOverlayMode = typeof window !== 'undefined' && '__TAURI__' in window;

  return (
    <div
      className={`ai00-x-fmc ${isOpen ? 'ai00-x-fmc--open' : ''}`}
      {...(isOverlayMode ? { 'data-no-penetrate': 'true' } : {})}
    >
      {/* Fullscreen backdrop to catch outside clicks */}
      {isOpen && (
        <div
          className="ai00-x-fmc__backdrop no-penetrate"
          data-no-penetrate="true"
          onMouseDown={handleClose}
        />
      )}

      {/* Circular trigger button — hidden when panel is open */}
      <button
        type="button"
        className="ai00-x-fmc__button"
        onClick={handleOpen}
        aria-label={t('toolCards.toolbar.startNewChat')}
      >
        <MessageSquare size={20} />
      </button>

      {/* Expanded panel */}
      <div ref={panelRef} className={`${panelClassName} no-penetrate`} data-no-penetrate="true">
        {/* Header */}
        <div className="ai00-x-fmc__header">
          <Tooltip content={t('session.new')}>
            <button type="button" className="ai00-x-fmc__header-btn" onClick={handleCreateSession}>
              <Plus size={14} />
            </button>
          </Tooltip>

          <div className="ai00-x-fmc__title-wrapper">
            <Tooltip content={t('session.switchSession')}>
              <button
                type="button"
                className="ai00-x-fmc__title-btn"
                onClick={() => setShowSessionPicker(!showSessionPicker)}
              >
                <span className="ai00-x-fmc__title-text">{sessionTitle}</span>
                <ChevronDown
                  size={12}
                  className={`ai00-x-fmc__title-chevron ${showSessionPicker ? 'ai00-x-fmc__title-chevron--open' : ''}`}
                />
              </button>
            </Tooltip>

            {showSessionPicker && (
              <div
                className="ai00-x-fmc__session-dropdown"
                ref={sessionPickerRef}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {sessions.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    className={`ai00-x-fmc__session-item ${
                      session.sessionId === flowChatState.activeSessionId
                        ? 'ai00-x-fmc__session-item--active'
                        : ''
                    }`}
                    onMouseDown={(e) => handleSwitchSession(e, session.sessionId)}
                  >
                    {session.title || t('session.new')}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Confirm / reject controls inline in header */}
          {toolbarState.hasPendingConfirmation && (
            <>
              <Tooltip content={t('toolCards.common.confirm')}>
                <button type="button" className="ai00-x-fmc__header-btn ai00-x-fmc__header-btn--confirm" onClick={handleConfirm}>
                  <Check size={14} />
                </button>
              </Tooltip>
              <Tooltip content={t('toolCards.common.cancel')}>
                <button type="button" className="ai00-x-fmc__header-btn ai00-x-fmc__header-btn--reject" onClick={handleReject}>
                  <X size={14} />
                </button>
              </Tooltip>
            </>
          )}

          {currentStreamState.isStreaming && !toolbarState.hasPendingConfirmation && (
            <Tooltip content={t('input.stop')}>
              <button type="button" className="ai00-x-fmc__header-btn ai00-x-fmc__header-btn--stop" onClick={handleCancel}>
                <Square size={12} />
              </button>
            </Tooltip>
          )}

          <Tooltip content={t('planner.cancel')}>
            <button type="button" className="ai00-x-fmc__header-btn ai00-x-fmc__header-btn--close" onClick={handleClose}>
              <X size={14} />
            </button>
          </Tooltip>
        </div>

        {/* FlowChat body — only mounted while the panel is open to avoid
            running a second VirtualMessageList and store sync in the background
            while the agent is actively streaming in another scene. */}
        <div className="ai00-x-fmc__body">
          {isOpen && <ModernFlowChatContainer />}
        </div>

        {/* Input bar */}
        <div className="ai00-x-fmc__input-bar">
          <Input
            variant="filled"
            inputSize="small"
            className="ai00-x-fmc__input-wrapper"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              currentStreamState.isStreaming
                ? t('toolCards.toolbar.aiProcessing')
                : t('toolCards.toolbar.inputMessage')
            }
            disabled={currentStreamState.isStreaming}
          />
          {currentStreamState.isStreaming ? (
            <Tooltip content={t('input.stop')}>
              <button
                type="button"
                className="ai00-x-fmc__input-btn ai00-x-fmc__input-btn--stop"
                onClick={handleCancel}
              >
                <Square size={14} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip content={t('input.send')}>
              <button
                type="button"
                className="ai00-x-fmc__input-btn ai00-x-fmc__input-btn--send"
                onClick={handleSendMessage}
                disabled={!inputValue.trim()}
              >
                <ArrowUp size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
};

export default FloatingMiniChat;
