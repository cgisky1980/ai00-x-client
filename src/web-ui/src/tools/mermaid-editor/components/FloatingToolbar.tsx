import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { usePortalContainer } from '@/infrastructure/contexts/PortalContainerContext';
import { Tooltip } from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import './FloatingToolbar.scss';

export interface FloatingToolbarProps {
  isVisible: boolean;
  position: { x: number; y: number };
  type: 'node' | 'edge';
  data: {
    id: string;
    text: string;
    fromNode?: string;
    toNode?: string;
  };
  onSave: (data: any) => void;
  onDelete: () => void;
  onClose: () => void;
}

export const FloatingToolbar: React.FC<FloatingToolbarProps> = ({
  isVisible,
  position,
  type,
  data,
  onSave,
  onDelete,
  onClose
}) => {
  const { t } = useI18n('mermaid-editor');
  const [text, setText] = useState(data.text);
  const [fromNode, setFromNode] = useState(data.fromNode || '');
  const [toNode, setToNode] = useState(data.toNode || '');
  const inputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(data.text);
    setFromNode(data.fromNode || '');
    setToNode(data.toNode || '');
  }, [data]);

  useEffect(() => {
    if (isVisible && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isVisible]);

  const handleSave = useCallback(() => {
    if (type === 'node') {
      onSave({ id: data.id, text });
    } else {
      onSave({ id: data.id, text, fromNode, toNode });
    }
    onClose();
  }, [type, data.id, text, fromNode, toNode, onSave, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Only stop Enter/Escape to preserve text shortcuts.
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }, [handleSave, onClose]);

  const handleDelete = useCallback(() => {
    onDelete();
    onClose();
  }, [onDelete, onClose]);

  const portalContainer = usePortalContainer();
  const portalTarget = portalContainer ?? document.body;

  if (!isVisible) return null;

  const portalContent = (
    <>
      <div
        ref={toolbarRef}
        className="floating-toolbar"
        data-type={type}
        style={{
          left: Math.max(0, Math.min(position.x, window.innerWidth - (type === 'edge' ? 400 : 300))),
          top: Math.max(0, Math.min(position.y, window.innerHeight - 100)),
          position: 'absolute',
          zIndex: 2000
        }}
        onClick={(e) => {
          // Stop clicks on the container without blocking text selection.
          if (e.target === e.currentTarget) {
            e.stopPropagation();
          }
        }}
      >
      <div className="toolbar-content">
        {type === 'node' ? (
          <div className="toolbar-row">
            <span className="toolbar-label">{t('floatingToolbar.node')} [{data.id}]:</span>
            <input
              ref={inputRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('floatingToolbar.nodeTextPlaceholder')}
              className="toolbar-input"
            />
          </div>
        ) : (
          <>
            <div className="toolbar-row">
              <span className="toolbar-label">{t('floatingToolbar.connection')}:</span>
              <input
                type="text"
                value={fromNode}
                onChange={(e) => setFromNode(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('floatingToolbar.startNodePlaceholder')}
                className="toolbar-input node-input"
              />
              <span className="toolbar-arrow">→</span>
              <input
                type="text"
                value={toNode}
                onChange={(e) => setToNode(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('floatingToolbar.targetNodePlaceholder')}
                className="toolbar-input node-input"
              />
            </div>
            <div className="toolbar-row">
              <span className="toolbar-label">{t('floatingToolbar.text')}:</span>
              <input
                ref={inputRef}
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('floatingToolbar.connectionTextPlaceholder')}
                className="toolbar-input"
              />
            </div>
          </>
        )}
        
        <div className="toolbar-buttons">
          <Tooltip content={t('floatingToolbar.saveEnter')} placement="top">
            <button 
              className="toolbar-btn save" 
              onClick={handleSave}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip content={t('floatingToolbar.delete')} placement="top">
            <button 
              className="toolbar-btn delete" 
              onClick={handleDelete}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip content={t('floatingToolbar.cancelEsc')} placement="top">
            <button 
              className="toolbar-btn cancel" 
              onClick={onClose}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>
      </div>
    </>
  );

  return createPortal(portalContent, portalTarget);
};
