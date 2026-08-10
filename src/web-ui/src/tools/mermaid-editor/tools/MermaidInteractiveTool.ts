/**
 * Backend tool for interactive Mermaid panels.
 */

import { MermaidInteractiveToolInput, MermaidInteractiveToolOutput, MermaidPanelData, NodeMetadata, HighlightState } from '../types/MermaidPanelTypes';

export class MermaidInteractiveTool {
  private static instance: MermaidInteractiveTool;
  private panels: Map<string, MermaidPanelData> = new Map();

  static getInstance(): MermaidInteractiveTool {
    if (!MermaidInteractiveTool.instance) {
      MermaidInteractiveTool.instance = new MermaidInteractiveTool();
    }
    return MermaidInteractiveTool.instance;
  }

  async handle(input: MermaidInteractiveToolInput): Promise<MermaidInteractiveToolOutput> {
    try {
      switch (input.action) {
        case 'render':
          return await this.handleRender(input.render_data!);
        case 'update_highlights':
          return await this.handleUpdateHighlights(input.update_data!);
        case 'switch_mode':
          return await this.handleSwitchMode(input.switch_data!);
        default:
          throw new Error(`Unknown action: ${input.action}`);
      }
    } catch (error) {
      return {
        success: false,
        panel_id: '',
        action: input.action,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async handleRender(data: {
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
  }): Promise<MermaidInteractiveToolOutput> {
    const panelId = `mermaid-interactive-${data.session_id}`;
    const panelData: MermaidPanelData = {
      mermaid_code: data.mermaid_code,
      title: data.title,
      session_id: data.session_id,
      mode: 'interactive',
      allow_mode_switch: data.options.allow_mode_switch,
      interactive_config: {
        node_metadata: data.node_metadata,
        highlights: data.highlights,
        enable_navigation: data.options.enable_navigation,
        enable_tooltips: true
      }
    };
    this.panels.set(panelId, panelData);
    await this.triggerPanelCreation(panelData, data.options.position);
    return {
      success: true,
      panel_id: panelId,
      action: 'render',
      message: 'Interactive Mermaid diagram opened',
      panel_info: {
        position: data.options.position,
        mode: 'interactive',
        node_count: Object.keys(data.node_metadata).length
      }
    };
  }

  private async handleUpdateHighlights(data: {
    session_id: string;
    highlights: HighlightState;
    update_metadata?: Record<string, Partial<NodeMetadata>>;
  }): Promise<MermaidInteractiveToolOutput> {
    const panelId = `mermaid-interactive-${data.session_id}`;
    const panelData = this.panels.get(panelId);

    if (!panelData) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    if (panelData.interactive_config) {
      panelData.interactive_config.highlights = data.highlights;
      if (data.update_metadata) {
        Object.keys(data.update_metadata).forEach(nodeId => {
          if (panelData.interactive_config!.node_metadata[nodeId]) {
            Object.assign(
              panelData.interactive_config!.node_metadata[nodeId],
              data.update_metadata![nodeId]
            );
          }
        });
      }
    }
    await this.triggerPanelUpdate(panelId, {
      highlights: data.highlights,
      update_metadata: data.update_metadata
    });
    return {
      success: true,
      panel_id: panelId,
      action: 'update_highlights',
      message: 'Highlights updated successfully'
    };
  }

  private async handleSwitchMode(data: {
    session_id: string;
    target_mode: 'editor' | 'interactive';
  }): Promise<MermaidInteractiveToolOutput> {
    const panelId = `mermaid-interactive-${data.session_id}`;
    const panelData = this.panels.get(panelId);

    if (!panelData) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    if (data.target_mode === 'interactive' && !panelData.interactive_config?.node_metadata) {
      throw new Error('Interactive mode requires node metadata');
    }

    panelData.mode = data.target_mode;
    await this.triggerModeSwitch(panelId, data.target_mode);
    return {
      success: true,
      panel_id: panelId,
      action: 'switch_mode',
      message: `Mode switched to ${data.target_mode}`
    };
  }

  private async triggerPanelCreation(panelData: MermaidPanelData, position: string): Promise<void> {
    const event = new CustomEvent('agent-create-tab', {
      detail: {
        type: 'mermaid-panel',
        title: panelData.title,
        data: panelData,
        position
      }
    });
    
    window.dispatchEvent(event);
  }

  private async triggerPanelUpdate(panelId: string, updateData: any): Promise<void> {
    const event = new CustomEvent('mermaid-panel-update', {
      detail: {
        panel_id: panelId,
        update_data: updateData
      }
    });
    
    window.dispatchEvent(event);
  }

  private async triggerModeSwitch(panelId: string, targetMode: string): Promise<void> {
    const event = new CustomEvent('mermaid-panel-mode-switch', {
      detail: {
        panel_id: panelId,
        target_mode: targetMode
      }
    });
    
    window.dispatchEvent(event);
  }

  getPanelData(panelId: string): MermaidPanelData | undefined {
    return this.panels.get(panelId);
  }

  getAllPanels(): Map<string, MermaidPanelData> {
    return new Map(this.panels);
  }

  removePanel(panelId: string): boolean {
    return this.panels.delete(panelId);
  }

  clearAllPanels(): void {
    this.panels.clear();
  }
}

export const mermaidInteractiveTool = MermaidInteractiveTool.getInstance();
