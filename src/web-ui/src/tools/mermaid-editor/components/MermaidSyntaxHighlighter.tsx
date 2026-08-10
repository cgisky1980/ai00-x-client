/**
 * Mermaid syntax highlighter built on Monaco.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { monacoInitManager } from '@/tools/editor/services/MonacoInitManager';
import { useTheme, themeService, monacoThemeSync } from '@/infrastructure/theme';

export interface MermaidSyntaxHighlighterProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
  showLineNumbers?: boolean;
  onCursorPositionChange?: (line: number, column: number) => void;
}

export const MermaidSyntaxHighlighter: React.FC<MermaidSyntaxHighlighterProps> = ({
  value,
  onChange,
  placeholder = 'graph TD\n  A[Start] --> B[End]',
  className = '',
  readOnly = false,
  showLineNumbers = true,
  onCursorPositionChange
}) => {
  const { theme: appTheme } = useTheme();

  const monacoThemeId = useMemo(() => {
    const t = appTheme ?? themeService.getCurrentTheme();
    return t ? monacoThemeSync.getTargetMonacoThemeId(t) : 'ai00-x-dark';
  }, [appTheme]);

  const [isReady, setIsReady] = useState(monacoInitManager.isInitialized());
  const [initError, setInitError] = useState<string | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const cursorListenerRef = useRef<Monaco.IDisposable | null>(null);
  const modelPathRef = useRef(`inmemory://mermaid-editor/${Date.now()}-${Math.random().toString(36).slice(2)}/diagram.mmd`);

  useEffect(() => {
    let cancelled = false;

    const initializeMonaco = async () => {
      try {
        await monacoInitManager.initialize();
        if (!cancelled) {
          setIsReady(true);
        }
      } catch (error) {
        if (!cancelled) {
          setInitError(String(error));
        }
      }
    };

    if (!isReady) {
      void initializeMonaco();
    }

    return () => {
      cancelled = true;
      cursorListenerRef.current?.dispose();
      cursorListenerRef.current = null;
      editorRef.current = null;
    };
  }, [isReady]);

  const handleBeforeMount = useCallback((monaco: typeof Monaco) => {
    const t = appTheme ?? themeService.getCurrentTheme();
    if (t) {
      monacoThemeSync.registerThemesForEditorInstance(monaco, t);
    }
  }, [appTheme]);

  useEffect(() => {
    const t = appTheme ?? themeService.getCurrentTheme();
    const m = monacoInitManager.getMonaco();
    if (!t || !m) {
      return;
    }
    monacoThemeSync.registerThemesForEditorInstance(m, t);
    m.editor.setTheme(monacoThemeSync.getTargetMonacoThemeId(t));
  }, [appTheme]);

  const options = useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>(() => ({
    readOnly,
    lineNumbers: showLineNumbers ? 'on' : 'off',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    wordWrap: 'on',
    fontSize: 14,
    lineHeight: 21,
    tabSize: 2,
    insertSpaces: true,
    fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
    glyphMargin: false,
    folding: false,
    renderLineHighlight: 'line',
    roundedSelection: false,
    padding: { top: 16, bottom: 16 },
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
    },
    placeholder,
  }), [placeholder, readOnly, showLineNumbers]);

  const handleChange = useCallback((nextValue: string | undefined) => {
    onChange(nextValue ?? '');
  }, [onChange]);

  const handleMount = useCallback((
    editor: Monaco.editor.IStandaloneCodeEditor
  ) => {
    editorRef.current = editor;
    void monacoInitManager.initialize();

    cursorListenerRef.current?.dispose();
    cursorListenerRef.current = editor.onDidChangeCursorPosition((event) => {
      onCursorPositionChange?.(event.position.lineNumber, event.position.column);
    });

    const position = editor.getPosition();
    if (position) {
      onCursorPositionChange?.(position.lineNumber, position.column);
    }
  }, [onCursorPositionChange]);

  if (initError) {
    return (
      <div className={className} style={{ width: '100%', height: '100%' }}>
        <div style={{ padding: '16px', color: 'var(--color-danger-500, #ff6b6b)' }}>
          {initError}
        </div>
      </div>
    );
  }

  if (!isReady) {
    return <div className={className} style={{ width: '100%', height: '100%' }} />;
  }

  return (
    <div className={className} style={{ width: '100%', height: '100%' }}>
      <Editor
        path={modelPathRef.current}
        language="mermaid"
        theme={monacoThemeId}
        value={value}
        onChange={handleChange}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        options={options}
        loading=""
        height="100%"
      />
    </div>
  );
};