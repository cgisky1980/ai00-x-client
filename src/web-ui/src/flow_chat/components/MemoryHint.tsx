import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from '@/component-library';
import { flowChatStore } from '../store/FlowChatStore';
import type { MemoryHintState } from '../types/flow-chat';
import './MemoryHint.scss';

export const MemoryHint: React.FC = () => {
  const { t } = useTranslation();
  const [hint, setHint] = useState<MemoryHintState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const autoCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = flowChatStore.subscribe((state) => {
      setHint(state.memoryHint);
    });
    setHint(flowChatStore.getState().memoryHint);
    return unsub;
  }, []);

  useEffect(() => {
    if (!hint?.visible) {
      setExpanded(false);
      if (autoCollapseTimer.current) {
        clearTimeout(autoCollapseTimer.current);
        autoCollapseTimer.current = null;
      }
      return;
    }
    setExpanded(true);
    autoCollapseTimer.current = setTimeout(() => {
      setExpanded(false);
    }, 4000);

    return () => {
      if (autoCollapseTimer.current) {
        clearTimeout(autoCollapseTimer.current);
        autoCollapseTimer.current = null;
      }
    };
  }, [hint?.visible, hint?.count]);

  const handleToggle = useCallback(() => {
    setExpanded(prev => !prev);
    if (autoCollapseTimer.current) {
      clearTimeout(autoCollapseTimer.current);
      autoCollapseTimer.current = null;
    }
  }, []);

  const handleDismiss = useCallback(() => {
    flowChatStore.setMemoryHint({ visible: false, count: 0 });
  }, []);

  if (!hint?.visible) return null;

  const label = hint.count === 1
    ? t('flow-chat.memoryHint.collapsed_one')
    : t('flow-chat.memoryHint.collapsed', { count: hint.count });

  return (
    <div className={`memory-hint${expanded ? ' memory-hint--expanded' : ''}`}>
      <button
        className="memory-hint__toggle"
        onClick={handleToggle}
        aria-expanded={expanded}
        aria-label={expanded ? t('flow-chat.memoryHint.collapse') : t('flow-chat.memoryHint.expand')}
      >
        <span className="memory-hint__label">{label}</span>
        <span className="memory-hint__chevron">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && hint.displayPrompt && (
        <div className="memory-hint__content">
          <div className="memory-hint__text">
            <MarkdownRenderer content={hint.displayPrompt} />
          </div>
          <button className="memory-hint__dismiss" onClick={handleDismiss} aria-label={t('flow-chat.memoryHint.dismiss')}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
};
