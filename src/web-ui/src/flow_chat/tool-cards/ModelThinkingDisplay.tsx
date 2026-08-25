/**
 * Model thinking display component.
 * Thin shell over design-system ThinkingPanel (v0.15 AI suite): rendering
 * goes through the standard control, while flow-chat keeps its
 * virtual-scroll height contract, typewriter streaming, char-count label,
 * capped scroll area with fade gradients and auto-collapse semantics.
 *
 * Default expanded while this is still the active last step.
 * If the component mounts after later content already appeared
 * (for example after a parent remount), start collapsed directly
 * to avoid a visible expand-then-collapse flash.
 * Applies typewriter effect during streaming.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { FlowThinkingItem } from '../types/flow-chat';
import { useTypewriter } from '../hooks/useTypewriter';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { Markdown } from '@/component-library/components/Markdown/Markdown';
import { ThinkingPanel } from '@/component-library';
import './ModelThinkingDisplay.scss';

interface ModelThinkingDisplayProps {
  thinkingItem: FlowThinkingItem;
  /** Whether this is the last item in the current round. */
  isLastItem?: boolean;
}

export const ModelThinkingDisplay: React.FC<ModelThinkingDisplayProps> = ({ thinkingItem, isLastItem = true }) => {
  const { t } = useTranslation('flow-chat');
  const { content, isStreaming, status } = thinkingItem;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const isActive = isStreaming || status === 'streaming';
  const displayContent = useTypewriter(content, isActive);

  const [isExpanded, setIsExpanded] = useState(isLastItem);
  const userToggledRef = useRef(false);
  const { applyExpandedState } = useToolCardHeightContract({
    toolId: thinkingItem.id,
    toolName: 'thinking',
    getCardHeight: () => {
      const contentScrollHeight = contentRef.current?.scrollHeight ?? null;
      const wrapperHeight = wrapperRef.current?.getBoundingClientRect().height ?? null;
      return contentScrollHeight ?? wrapperHeight;
    },
  });

  // Auto-collapse once later content appears (unless the user toggled).
  useEffect(() => {
    if (userToggledRef.current) return;
    if (!isLastItem && isExpanded) {
      applyExpandedState(isExpanded, false, setIsExpanded, {
        reason: 'auto',
      });
    }
  }, [applyExpandedState, isExpanded, isLastItem]);

  // Auto-scroll to bottom while content grows.
  useEffect(() => {
    if (isExpanded && contentRef.current) {
      const el = contentRef.current;
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap < 80) {
        requestAnimationFrame(() => {
          if (contentRef.current) {
            contentRef.current.scrollTop = contentRef.current.scrollHeight;
          }
        });
      }
    }
  }, [displayContent, isExpanded]);

  // Scroll-state detection for fade gradients.
  const [scrollState, setScrollState] = useState({ hasScroll: false, atTop: true, atBottom: true });

  const checkScrollState = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    setScrollState({
      hasScroll: el.scrollHeight > el.clientHeight,
      atTop: el.scrollTop <= 5,
      atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 5,
    });
  }, []);

  useEffect(() => {
    if (isExpanded) {
      const timer = setTimeout(checkScrollState, 50);
      return () => clearTimeout(timer);
    }
  }, [isExpanded, checkScrollState]);

  const contentLengthText = useMemo(() => {
    if (!content || content.length === 0) return t('toolCards.think.thinkingComplete');
    return t('toolCards.think.thinkingCharacters', { count: content.length });
  }, [content, t]);

  const handleToggle = useCallback((nextExpanded: boolean) => {
    userToggledRef.current = true;
    applyExpandedState(isExpanded, nextExpanded, setIsExpanded);
  }, [applyExpandedState, isExpanded]);

  const headerLabel = isExpanded
    ? (isActive ? t('toolCards.think.thinking') : t('toolCards.think.thinkingProcess'))
    : contentLengthText;

  const renderedContent = isActive ? displayContent : content;

  return (
    <div
      ref={wrapperRef}
      data-tool-card-id={thinkingItem.id}
      className={`flow-thinking-item ${isExpanded ? 'expanded' : 'collapsed'}${isActive ? ' streaming' : ''}`}
    >
      <ThinkingPanel
        phase={isActive ? 'thinking' : 'done'}
        open={isExpanded}
        onToggle={handleToggle}
        label={headerLabel}
        cursor={false}
        className="flow-thinking-item__panel"
      >
        <div
          className={`thinking-content-wrapper ${scrollState.hasScroll ? 'has-scroll' : ''} ${scrollState.atTop ? 'at-top' : ''} ${scrollState.atBottom ? 'at-bottom' : ''}`}
        >
          <div
            ref={contentRef}
            className="thinking-content expanded"
            onScroll={checkScrollState}
          >
            <Markdown
              content={renderedContent}
              isStreaming={isActive}
              className="thinking-markdown"
            />
          </div>
        </div>
      </ThinkingPanel>
    </div>
  );
};
