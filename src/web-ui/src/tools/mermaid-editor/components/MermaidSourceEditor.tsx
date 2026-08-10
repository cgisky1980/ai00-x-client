/**
 * Mermaid source editor.
 */

import React, { useCallback, useState } from 'react';
import { MermaidSyntaxHighlighter } from './MermaidSyntaxHighlighter';
import { useI18n } from '@/infrastructure/i18n';
import './MermaidSourceEditor.css';

export interface MermaidSourceEditorProps {
  sourceCode: string;
  onChange: (sourceCode: string) => void;
  className?: string;
}

export const MermaidSourceEditor: React.FC<MermaidSourceEditorProps> = ({
  sourceCode,
  onChange,
  className = ''
}) => {
  const { t } = useI18n('mermaid-editor');
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  
  const stats = React.useMemo(() => {
    const lines = sourceCode.split('\n').length;
    const characters = sourceCode.length;
    const words = sourceCode.trim() ? sourceCode.trim().split(/\s+/).length : 0;
    return { lines, characters, words };
  }, [sourceCode]);

  const handleChange = useCallback((newSourceCode: string) => {
    onChange(newSourceCode);
  }, [onChange]);

  const handleCursorPositionChange = useCallback((line: number, column: number) => {
    setCursorPosition({ line, column });
  }, []);

  return (
    <div className={`mermaid-source-editor ${className}`}>
      <div className="editor-header">
        <h4>{t('editor.sourceTitle')}</h4>
      </div>
      
      <div className="editor-content">
        <MermaidSyntaxHighlighter
          value={sourceCode}
          onChange={handleChange}
          onCursorPositionChange={handleCursorPositionChange}
          placeholder={t('editor.placeholder')}
          showLineNumbers={true}
        />
      </div>
      
      <div className="editor-status-bar">
        <div className="status-left">
          <span className="status-item">
            {stats.lines} {t('editor.lines')} | {stats.characters} {t('editor.characters')} | {stats.words} {t('editor.words')}
          </span>
        </div>
        <div className="status-right">
          <span className="status-item">
            {t('editor.line')} {cursorPosition.line}, {t('editor.column')} {cursorPosition.column}
          </span>
          <span className="status-item">
            Mermaid
          </span>
        </div>
      </div>
    </div>
  );
};