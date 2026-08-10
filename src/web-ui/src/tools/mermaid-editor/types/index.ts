/**
 * Mermaid editor type definitions.
 */

export * from './MermaidPanelTypes';
import type { NodeMetadata } from './MermaidPanelTypes';

export interface MermaidEditorProps {
  initialSourceCode?: string;
  onSave?: (sourceCode: string) => Promise<void>;
  onExport?: (format: string, data: string) => Promise<void>;
  className?: string;
  /** Initial mode that sets the default editor state. */
  mode?: 'editor' | 'interactive';
  /** Node metadata for navigation and tooltips. */
  nodeMetadata?: Record<string, NodeMetadata>;
  /** Whether to show tooltips. */
  enableTooltips?: boolean;
  /**
   * Override default file navigation on node click.
   * When provided, this is called instead of dispatching agent-create-tab.
   */
  onFileNavigate?: (filePath: string, line: number, metadata: NodeMetadata) => void;
}

export interface MermaidEditorState {
  sourceCode: string;
  isDirty: boolean;
  showSourceEditor: boolean;
  showComponentLibrary: boolean;
  isLoading: boolean;
  error: string | null;
}

export type LayoutMode = 'preview-only' | 'source-only' | 'library-only' | 'source-library';

export interface MermaidComponent {
  id: string;
  name: string;
  category: string;
  code: string;
  description?: string;
  icon?: string;
}

export interface MermaidComponentCategory {
  id: string;
  name: string;
  components: MermaidComponent[];
}

export interface MermaidEditorEvents {
  onSave?: (sourceCode: string) => Promise<void>;
  onExport?: (format: string, data: string) => Promise<void>;
  onSourceChange?: (sourceCode: string) => void;
  onComponentAdd?: (component: MermaidComponent) => void;
}

export interface MermaidQuickTemplate {
  id: string;
  name: string;
  description: string;
  diagramType: string;
  sourceCode: string;
}

export interface MermaidNodeTemplate {
  id: string;
  name: string;
  type: string;
  icon: string;
  defaultLabel: string;
}

export interface MermaidEdgeTemplate {
  id: string;
  name: string;
  type: string;
  arrow: string;
  icon: string;
}
