/**
 * FlowChat header.
 * Shows the currently viewed turn and user message.
 * Height matches side panel headers (40px).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, List, Monitor, Eye } from 'lucide-react';
import { Tooltip, IconButton } from '@/component-library';
import { useTranslation } from 'react-i18next';
import { SessionFilesBadge } from './SessionFilesBadge';
import './FlowChatHeader.scss';

export interface FlowChatHeaderTurnSummary {
  turnId: string;
  turnIndex: number;
  title: string;
}

export interface FlowChatHeaderProps {
  /** Current turn index. */
  currentTurn: number;
  /** Total turns. */
  totalTurns: number;
  /** Current user message. */
  currentUserMessage: string;
  /** Whether the header is visible. */
  visible: boolean;
  /** Session ID. */
  sessionId?: string;
  /** Agent type of the current session. */
  agentType?: string;
  /** Whether the wallpaper preview is currently open. */
  isWallpaperPreviewOpen?: boolean;
  /** Toggle wallpaper preview visibility. */
  onToggleWallpaperPreview?: () => void;
  /** Apply wallpaper to desktop. */
  onApplyWallpaper?: () => void;
  /** Ordered turn summaries used by header navigation. */
  turns?: FlowChatHeaderTurnSummary[];
  /** Jump to a specific turn. */
  onJumpToTurn?: (turnId: string) => void;
  /** Jump to the previous turn. */
  onJumpToPreviousTurn?: () => void;
  /** Jump to the next turn. */
  onJumpToNextTurn?: () => void;
}
export const FlowChatHeader: React.FC<FlowChatHeaderProps> = ({
  currentTurn,
  totalTurns,
  currentUserMessage,
  visible,
  sessionId,
  agentType,
  isWallpaperPreviewOpen,
  onToggleWallpaperPreview,
  onApplyWallpaper,
  turns = [],
  onJumpToTurn,
  onJumpToPreviousTurn,
  onJumpToNextTurn,
}) => {
  const { t } = useTranslation('flow-chat');
  const [isTurnListOpen, setIsTurnListOpen] = useState(false);
  const turnListRef = useRef<HTMLDivElement | null>(null);
  const activeTurnItemRef = useRef<HTMLButtonElement | null>(null);

  // Truncate long messages.
  const truncatedMessage = currentUserMessage.length > 50
    ? currentUserMessage.slice(0, 50) + '...'
    : currentUserMessage;
  const turnListTooltip = t('flowChatHeader.turnList', {
    defaultValue: 'Turn list',
  });
  const untitledTurnLabel = t('flowChatHeader.untitledTurn', {
    defaultValue: 'Untitled turn',
  });
  const turnBadgeLabel = t('flowChatHeader.turnBadge', {
    current: currentTurn,
    defaultValue: `Turn ${currentTurn}`,
  });
  const previousTurnDisabled = currentTurn <= 1;
  const nextTurnDisabled = currentTurn <= 0 || currentTurn >= totalTurns;
  const hasTurnNavigation = turns.length > 0 && !!onJumpToTurn;
  const displayTurns = useMemo(() => (
    turns.map(turn => ({
      ...turn,
      title: turn.title.trim() || untitledTurnLabel,
    }))
  ), [turns, untitledTurnLabel]);

  useEffect(() => {
    if (!isTurnListOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!turnListRef.current?.contains(event.target as Node)) {
        setIsTurnListOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsTurnListOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isTurnListOpen]);

  useEffect(() => {
    setIsTurnListOpen(false);
  }, [currentTurn]);

  useEffect(() => {
    if (!isTurnListOpen) return;

    const frameId = requestAnimationFrame(() => {
      activeTurnItemRef.current?.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      });
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [currentTurn, displayTurns.length, isTurnListOpen]);

  const handleToggleTurnList = () => {
    if (!hasTurnNavigation) return;
    setIsTurnListOpen(prev => !prev);
  };

  const handleTurnSelect = (turnId: string) => {
    if (!onJumpToTurn) return;
    onJumpToTurn(turnId);
    setIsTurnListOpen(false);
  };

  const handleToggleWallpaperPreview = () => {
    onToggleWallpaperPreview?.();
    // Also dispatch a custom event for SessionScene to pick up
    window.dispatchEvent(new CustomEvent('wallpaper-preview-toggle'));
  };

  const handleApplyWallpaper = () => {
    onApplyWallpaper?.();
    window.dispatchEvent(new CustomEvent('wallpaper-apply-to-desktop'));
  };

  if (!visible || totalTurns === 0) {
    return null;
  }

  return (
    <div className="flowchat-header">
      <div className="flowchat-header__actions flowchat-header__actions--left">
        <SessionFilesBadge sessionId={sessionId} />
        {agentType === 'Wallpaper' && (
          <>
            <IconButton
              variant="ghost"
              size="xs"
              onClick={handleToggleWallpaperPreview}
              tooltip={isWallpaperPreviewOpen
                ? t('wallpaper.hidePreview', { defaultValue: 'Hide Preview' })
                : t('wallpaper.showPreview', { defaultValue: 'Show Preview' })}
              aria-label={t('wallpaper.showPreview', { defaultValue: 'Show Preview' })}
              data-testid="flowchat-header-wallpaper-preview"
            >
              <Eye size={14} />
            </IconButton>
            <IconButton
              variant="ghost"
              size="xs"
              onClick={handleApplyWallpaper}
              tooltip={t('wallpaper.applyToDesktop', { defaultValue: 'Apply to Desktop' })}
              aria-label={t('wallpaper.applyToDesktop', { defaultValue: 'Apply to Desktop' })}
              data-testid="flowchat-header-wallpaper-apply"
            >
              <Monitor size={14} />
            </IconButton>
          </>
        )}
      </div>

      <Tooltip content={currentUserMessage} placement="bottom">
        <div className="flowchat-header__message">
          <span className="flowchat-header__turn-badge" aria-label={turnBadgeLabel}>
            <span>{turnBadgeLabel}</span>
          </span>
          <span className="flowchat-header__message-text">
            {truncatedMessage}
          </span>
        </div>
      </Tooltip>

      <div className="flowchat-header__actions">
        <div className="flowchat-header__turn-nav" ref={turnListRef}>
          <IconButton
            className={`flowchat-header__turn-nav-button${isTurnListOpen ? ' flowchat-header__turn-nav-button--active' : ''}`}
            variant="ghost"
            size="xs"
            onClick={handleToggleTurnList}
            tooltip={turnListTooltip}
            disabled={!hasTurnNavigation}
            aria-label={turnListTooltip}
            aria-expanded={isTurnListOpen}
            aria-haspopup="dialog"
            data-testid="flowchat-header-turn-list"
          >
            <List size={14} />
          </IconButton>
          <IconButton
            className="flowchat-header__turn-nav-button"
            variant="ghost"
            size="xs"
            onClick={onJumpToPreviousTurn}
            tooltip={t('flowChatHeader.previousTurn', { defaultValue: 'Previous turn' })}
            disabled={previousTurnDisabled || !onJumpToPreviousTurn}
            aria-label={t('flowChatHeader.previousTurn', { defaultValue: 'Previous turn' })}
            data-testid="flowchat-header-turn-prev"
          >
            <ChevronUp size={14} />
          </IconButton>
          <IconButton
            className="flowchat-header__turn-nav-button"
            variant="ghost"
            size="xs"
            onClick={onJumpToNextTurn}
            tooltip={t('flowChatHeader.nextTurn', { defaultValue: 'Next turn' })}
            disabled={nextTurnDisabled || !onJumpToNextTurn}
            aria-label={t('flowChatHeader.nextTurn', { defaultValue: 'Next turn' })}
            data-testid="flowchat-header-turn-next"
          >
            <ChevronDown size={14} />
          </IconButton>

          {isTurnListOpen && hasTurnNavigation && (
            <div className="flowchat-header__turn-list-panel" role="dialog" aria-label={turnListTooltip}>
              <div className="flowchat-header__turn-list-header">
                <span>{turnListTooltip}</span>
                <span>{currentTurn}/{totalTurns}</span>
              </div>
              <div className="flowchat-header__turn-list">
                {displayTurns.map(turn => (
                  <button
                    key={turn.turnId}
                    type="button"
                    className={`flowchat-header__turn-list-item${turn.turnIndex === currentTurn ? ' flowchat-header__turn-list-item--active' : ''}`}
                    onClick={() => handleTurnSelect(turn.turnId)}
                    ref={turn.turnIndex === currentTurn ? activeTurnItemRef : undefined}
                  >
                    <span className="flowchat-header__turn-list-badge">
                      {t('flowChatHeader.turnBadge', {
                        current: turn.turnIndex,
                        defaultValue: `Turn ${turn.turnIndex}`,
                      })}
                    </span>
                    <span className="flowchat-header__turn-list-title">{turn.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

FlowChatHeader.displayName = 'FlowChatHeader';

