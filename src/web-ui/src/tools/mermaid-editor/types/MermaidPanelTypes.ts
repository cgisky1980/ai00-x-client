/**
 * Mermaid panel types for editor and interactive modes.
 */

export interface MermaidPanelData {
  mermaid_code: string;
  title: string;
  session_id?: string;
  mode: 'editor' | 'interactive';
  allow_mode_switch: boolean; // Allow switching between modes.
  editor_config?: {
    readonly: boolean;
    show_preview: boolean;
    auto_format: boolean;
  };
  interactive_config?: {
    node_metadata: Record<string, NodeMetadata>;
    highlights: HighlightState;
    enable_navigation: boolean;
    enable_tooltips: boolean;
  };
}

export interface NodeMetadata {
  node_type?: 'file' | 'directory';
  file_path: string;
  line_number?: number; // Optional for directories.
  label: string;
  description: string;
  tooltip: string;
  category: 'entry' | 'process' | 'decision' | 'error' | 'exit';
  trace_id?: string;
  // Runtime log data, updated dynamically.
  log_data?: Record<string, any>;
}

export interface HighlightState {
  executed: string[]; // IDs of executed nodes.
  failed: string[]; // IDs of failed nodes.
  current: string | null; // Currently executing node ID.
  warnings?: string[]; // IDs of warning nodes.
}

export interface TooltipData {
  title: string; // Node title.
  file_location: string; // File: src/auth/login.rs:45, Dir: src/auth/
  description: string;
  node_type?: 'file' | 'directory';
  trace_id?: string; // Example: TRACE_LOGIN_001
  captured_vars?: string[]; // Example: ['username', 'request_id']
  log_data?: any;
}

export interface MermaidInteractiveToolInput {
  action: 'render' | 'update_highlights' | 'switch_mode';

  // Render a new interactive panel.
  render_data?: {
    mermaid_code: string;
    title: string;
    mode: 'interactive';
    session_id: string;
    node_metadata: Record<string, NodeMetadata>;
    highlights: HighlightState;
    options: {
      allow_mode_switch: boolean;
      enable_navigation: boolean;
      position: 'left' | 'right' | 'center';
    };
  };

  // Update highlights without re-rendering.
  update_data?: {
    session_id: string;
    highlights: HighlightState;
    update_metadata?: Record<string, Partial<NodeMetadata>>;
  };

  // Switch between editor and interactive mode.
  switch_data?: {
    session_id: string;
    target_mode: 'editor' | 'interactive';
  };
}

export interface MermaidInteractiveToolOutput {
  success: boolean;
  panel_id: string;
  action: string;
  message: string;
  panel_info?: {
    position: string;
    mode: string;
    node_count: number;
  };
}
