import React, { Suspense, lazy, useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { MERMAID_INTERACTIVE_EXAMPLE } from '@/flow_chat/constants/mermaidExamples';
import type { MermaidPanelData, NodeMetadata } from '@/tools/mermaid-editor/types/MermaidPanelTypes';
import { CodeEditor } from '@/tools/editor';
import './MermaidEditorScene.scss';

const MermaidPanel = lazy(() =>
  import('@/tools/mermaid-editor/components').then((m) => ({ default: m.MermaidPanel }))
);
const MermaidErrorBoundary = lazy(() =>
  import('@/tools/mermaid-editor/components').then((m) => ({ default: m.MermaidErrorBoundary }))
);

interface FileTab {
  id: string;
  filePath: string;
  title: string;
  jumpToLine?: number;
}

const MIN_TOP_PX = 160;
const MIN_BOTTOM_PX = 120;
const DEFAULT_TOP_RATIO = 0.55;

const MermaidEditorScene: React.FC = () => {
  const { t } = useI18n('common');
  const { t: tComponents } = useI18n('components');
  const { workspacePath } = useCurrentWorkspace();

  const panelData = useMemo(
    (): MermaidPanelData =>
      ({
        ...MERMAID_INTERACTIVE_EXAMPLE,
        title: t('scenes.mermaidEditor'),
        session_id: 'mermaid-scene-standalone',
        mode: 'interactive',
      }) as MermaidPanelData,
    [t]
  );

  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);

  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  const hasFiles = fileTabs.length > 0;

  // ── resizer ─────────────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [topRatio, setTopRatio] = useState(DEFAULT_TOP_RATIO);
  const isDraggingRef = useRef(false);

  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      if (!containerRef.current || !isDraggingRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const totalH = rect.height;
      const relY = ev.clientY - rect.top;
      const clampedRatio = Math.min(
        Math.max(relY / totalH, MIN_TOP_PX / totalH),
        (totalH - MIN_BOTTOM_PX) / totalH
      );
      setTopRatio(clampedRatio);
    };
    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // Update jumpToLine when re-navigating to the same file at a different line.
  const handleFileNavigateWithLineUpdate = useCallback(
    (filePath: string, line: number, _metadata: NodeMetadata) => {
      const id = filePath;
      setFileTabs((prev) => {
        const existing = prev.find((t) => t.id === id);
        if (existing) {
          return prev.map((t) => (t.id === id ? { ...t, jumpToLine: line } : t));
        }
        const title = filePath.split(/[/\\]/).pop() ?? filePath;
        return [...prev, { id, filePath, title, jumpToLine: line }];
      });
      setActiveFileTabId(id);
    },
    []
  );

  const handleCloseFileTab = useCallback(
    (tabId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setFileTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        const next = prev.filter((t) => t.id !== tabId);
        if (activeFileTabId === tabId) {
          const nextTab = next[Math.min(idx, next.length - 1)];
          setActiveFileTabId(nextTab?.id ?? null);
        }
        return next;
      });
    },
    [activeFileTabId]
  );

  // Collapse bottom pane when all tabs closed.
  useEffect(() => {
    if (fileTabs.length === 0) setActiveFileTabId(null);
  }, [fileTabs]);

  return (
    <div ref={containerRef} className="mermaid-editor-scene">
      {/* ── Top: Mermaid editor ────────────────────────────────────────── */}
      <div
        className="mermaid-editor-scene__top"
        style={hasFiles ? { flex: `0 0 ${(topRatio * 100).toFixed(2)}%` } : undefined}
      >
        <Suspense
          fallback={
            <div className="mermaid-editor-scene__loading">
              {tComponents('flexiblePanel.loading.mermaidPanel')}
            </div>
          }
        >
          <MermaidErrorBoundary>
            <MermaidPanel
              data={panelData}
              onFileNavigate={handleFileNavigateWithLineUpdate}
            />
          </MermaidErrorBoundary>
        </Suspense>
      </div>

      {/* ── Resizer ────────────────────────────────────────────────────── */}
      {hasFiles && (
        <div
          className="mermaid-editor-scene__resizer"
          onMouseDown={handleResizerMouseDown}
          role="separator"
          aria-orientation="horizontal"
        />
      )}

      {/* ── Bottom: file tab pane ──────────────────────────────────────── */}
      {hasFiles && (
        <div className="mermaid-editor-scene__bottom">
          {/* Tab bar */}
          <div className="mermaid-editor-scene__tab-bar">
            {fileTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`mermaid-editor-scene__tab${tab.id === activeFileTabId ? ' is-active' : ''}`}
                onClick={() => setActiveFileTabId(tab.id)}
                title={tab.filePath}
              >
                <span className="mermaid-editor-scene__tab-title">{tab.title}</span>
                <span
                  className="mermaid-editor-scene__tab-close"
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => handleCloseFileTab(tab.id, e)}
                >
                  <X size={11} />
                </span>
              </button>
            ))}
          </div>

          {/* File content */}
          <div className="mermaid-editor-scene__file-content">
            {activeFileTab && (
              <CodeEditor
                key={`${activeFileTab.filePath}:${activeFileTab.jumpToLine}`}
                filePath={activeFileTab.filePath}
                workspacePath={workspacePath}
                fileName={activeFileTab.title}
                readOnly
                showLineNumbers
                showMinimap={false}
                jumpToLine={activeFileTab.jumpToLine}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MermaidEditorScene;
