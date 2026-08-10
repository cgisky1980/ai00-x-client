/**
 * SessionSwitcher — vertical session list for the left sidebar.
 *
 * Shows all sessions as a scrollable list. Click to switch, double-click to
 * rename, hover to reveal delete. A "new session" button sits at the top.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, Trash2, Check, X, MessageSquareText } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useAceStepStore } from '../store/acestepStore';
import { SessionModePicker } from './SessionModePicker';
import type { SessionMode } from '../types';
import './SessionSwitcher.scss';

export interface SessionSwitcherProps {
  /** Optional filter string (case-insensitive substring match on title). */
  filter?: string;
}

export const SessionSwitcher: React.FC<SessionSwitcherProps> = ({ filter }) => {
  const { t } = useI18n('acestep');
  const allSessions = useAceStepStore((s) => s.sessions);
  const activeSessionId = useAceStepStore((s) => s.activeSessionId);
  const createSession = useAceStepStore((s) => s.createSession);
  const switchSession = useAceStepStore((s) => s.switchSession);
  const deleteSession = useAceStepStore((s) => s.deleteSession);
  const renameSession = useAceStepStore((s) => s.renameSession);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [modePickerOpen, setModePickerOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Filter sessions by title (case-insensitive).
  const trimmedFilter = filter?.trim().toLowerCase();
  const sessions = trimmedFilter
    ? allSessions.filter((s) => s.title.toLowerCase().includes(trimmedFilter))
    : allSessions;

  // Focus rename input when entering rename mode.
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const handleStartRename = useCallback((id: string, currentTitle: string) => {
    setRenamingId(id);
    setRenameValue(currentTitle);
  }, []);

  const handleConfirmRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && renamingId) {
      renameSession(renamingId, trimmed);
    }
    setRenamingId(null);
  }, [renameValue, renamingId, renameSession]);

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirmRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setRenamingId(null);
    }
  };

  const handleNew = () => {
    setModePickerOpen(true);
  };

  const handleModeSelect = (mode: SessionMode) => {
    setModePickerOpen(false);
    createSession(mode);
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteSession(id);
  };

  const handleSelect = (id: string) => {
    if (id !== activeSessionId) {
      switchSession(id);
    }
  };

  return (
    <div className="session-switcher">
      <div className="session-switcher__header">
        <span className="session-switcher__title">
          <MessageSquareText size={14} />
          {t('chatCreate.sessions', { defaultValue: 'Sessions' })}
        </span>
        <button
          className="session-switcher__new-btn"
          onClick={handleNew}
          title={t('chatCreate.newSession', { defaultValue: 'New session' })}
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="session-switcher__list">
        {sessions.length === 0 ? (
          <div className="session-switcher__empty">
            {t('chatCreate.noSessions', { defaultValue: 'No sessions yet' })}
          </div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className={`session-switcher__item${s.id === activeSessionId ? ' is-active' : ''}`}
              onClick={() => handleSelect(s.id)}
              onDoubleClick={() => handleStartRename(s.id, s.title)}
              title={t('chatCreate.switchSession', { defaultValue: 'Click to switch, double-click to rename' })}
            >
              {renamingId === s.id ? (
                <div className="session-switcher__rename" onClick={(e) => e.stopPropagation()}>
                  <input
                    ref={renameInputRef}
                    className="session-switcher__rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={handleConfirmRename}
                  />
                  <button
                    className="session-switcher__rename-confirm"
                    onClick={handleConfirmRename}
                    title={t('common.done', { defaultValue: 'Done' })}
                  >
                    <Check size={12} />
                  </button>
                  <button
                    className="session-switcher__rename-cancel"
                    onClick={() => setRenamingId(null)}
                    title={t('common.cancel', { defaultValue: 'Cancel' })}
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <>
                  <span className="session-switcher__item-label">{s.title}</span>
                  <button
                    className="session-switcher__item-delete"
                    onClick={(e) => handleDelete(e, s.id)}
                    title={t('chatCreate.deleteSession', { defaultValue: 'Delete session' })}
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <SessionModePicker
        open={modePickerOpen}
        onSelect={handleModeSelect}
        onCancel={() => setModePickerOpen(false)}
      />
    </div>
  );
};
