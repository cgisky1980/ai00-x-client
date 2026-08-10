/**
 * Mermaid panel - unified container component
 *
 * Refactor notes:
 * - Use MermaidEditor only, and control click behavior via isEditMode
 * - Edit mode: clicking a node opens the editor (enabled via the edit button)
 * - View mode: clicking a node navigates to a file (default behavior)
 */

import React, { useCallback } from 'react';
import { MermaidEditor } from './MermaidEditor';
import { useI18n } from '@/infrastructure/i18n';
import type { MermaidPanelData, NodeMetadata } from '../types/MermaidPanelTypes';
import './MermaidPanel.scss';

export interface MermaidPanelProps {
  data: MermaidPanelData;
  onDataChange?: (data: MermaidPanelData) => void;
  onInteraction?: (action: string, payload: string) => Promise<void>;
  className?: string;
  /** Override default file navigation on node click. */
  onFileNavigate?: (filePath: string, line: number, metadata: NodeMetadata) => void;
}

export const MermaidPanel: React.FC<MermaidPanelProps> = ({
  data,
  onDataChange,
  onInteraction,
  className = '',
  onFileNavigate,
}) => {
  const { t } = useI18n('mermaid-editor');
  
  const handleEditorSave = useCallback(async (sourceCode: string) => {
    const updatedData = { ...data, mermaid_code: sourceCode };
    onDataChange?.(updatedData);
    await onInteraction?.('save', JSON.stringify({ sourceCode, sessionId: data.session_id }));
  }, [data, onDataChange, onInteraction]);

  const handleEditorExport = useCallback(async (format: string, exportData: string) => {
    await onInteraction?.('export', JSON.stringify({
      format,
      data: exportData,
      fileName: t('panel.diagramName'),
    }));
  }, [onInteraction, t]);

  return (
    <div className={`mermaid-panel ${className}`}>
      <MermaidEditor
        initialSourceCode={data.mermaid_code}
        onSave={handleEditorSave}
        onExport={handleEditorExport}
        className="mermaid-panel-editor"
        mode={data.mode}
        nodeMetadata={data.interactive_config?.node_metadata}
        enableTooltips={data.interactive_config?.enable_tooltips ?? true}
        onFileNavigate={onFileNavigate}
      />
    </div>
  );
};
