/**
 * SVG interaction hook.
 * Centralizes Mermaid SVG click and hover behaviors.
 *
 * Features:
 * - Node clicks (edit mode opens editor, view mode navigates)
 * - Edge clicks
 * - Hover effects
 * - Tooltip display
 * - Base style application
 */

import { useCallback, useRef, useEffect } from 'react';
import { getRuntimeColors } from '../theme/mermaidTheme';
import { createLogger } from '@/shared/utils/logger';
import type { NodeMetadata, TooltipData } from '../types/MermaidPanelTypes';

const log = createLogger('useSvgInteraction');

// ==================== Types ====================

export interface NodeInfo {
  id: string;
  text: string;
}

export interface EdgeInfo {
  id: string;
  text: string;
  fromNode?: string;
  toNode?: string;
}

export interface SvgInteractionOptions {
  /** Source code for parsing connections. */
  sourceCode: string;
  /** Edit mode: open editor; otherwise navigate to file. */
  isEditMode?: boolean;
  /** Node metadata for navigation and tooltips. */
  nodeMetadata?: Record<string, NodeMetadata>;
  /** Enable tooltips. */
  enableTooltips?: boolean;
  /** Node click callback in edit mode. */
  onNodeClick?: (node: NodeInfo, event: MouseEvent) => void;
  /** Edge click callback in edit mode. */
  onEdgeClick?: (edge: EdgeInfo, event: MouseEvent) => void;
  /** Tooltip show callback. */
  onTooltipShow?: (data: TooltipData, position: { x: number; y: number }, nodeId: string) => void;
  /** Tooltip position update callback. */
  onTooltipUpdate?: (position: { x: number; y: number }) => void;
  /** Tooltip hide callback (supports delay). */
  onTooltipHide?: (immediate?: boolean) => void;
  /** Ignore clicks after dragging. */
  hasDragged?: boolean;
  /** Reset drag state callback. */
  resetDragState?: () => void;
  /**
   * Override the default file navigation behavior (which dispatches agent-create-tab).
   * Receives the resolved file path, line number, and the full node metadata.
   * When provided, the default fileTabManager call is skipped entirely.
   */
  onFileNavigate?: (filePath: string, line: number, metadata: NodeMetadata) => void;
}

export interface SvgInteractionReturn {
  /** Attach interaction handlers to SVG. */
  setupInteraction: (svgElement: SVGElement) => () => void;
  /** Apply base styles. */
  applyBaseStyles: (svgElement: SVGElement) => void;
}

// ==================== Utilities ====================

/** Extract connections from source code. */
function extractConnectionsFromSource(sourceCode: string) {
  const connections: Array<{ from: string; to: string; label?: string }> = [];
  const lines = sourceCode.split('\n');

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('//') || trimmedLine.startsWith('%%')) {
      continue;
    }

    const connectionPatterns = [
      /([A-Za-z0-9_\u4e00-\u9fff]+)\s*-->\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_\u4e00-\u9fff]+)/,
      /([A-Za-z0-9_\u4e00-\u9fff]+)\s*->\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_\u4e00-\u9fff]+)/,
      /([A-Za-z0-9_\u4e00-\u9fff]+)\s*---\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_\u4e00-\u9fff]+)/,
      /([A-Za-z0-9_\u4e00-\u9fff]+)\s*-\.->\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_\u4e00-\u9fff]+)/,
      /([A-Za-z0-9_\u4e00-\u9fff]+)\s*==>\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_\u4e00-\u9fff]+)/,
      /([A-Za-z0-9_\u4e00-\u9fff]+)\s*-->\s*([A-Za-z0-9_\u4e00-\u9fff]+)/,
      /([A-Za-z0-9_\u4e00-\u9fff]+)\s*->\s*([A-Za-z0-9_\u4e00-\u9fff]+)/,
      /([A-Za-z0-9_\u4e00-\u9fff]+)\s*---\s*([A-Za-z0-9_\u4e00-\u9fff]+)/,
    ];

    for (const pattern of connectionPatterns) {
      const match = trimmedLine.match(pattern);
      if (match) {
        if (match.length === 4) {
          connections.push({
            from: match[1].trim(),
            to: match[3].trim(),
            label: match[2]?.trim() || '',
          });
        } else if (match.length === 3) {
          connections.push({
            from: match[1].trim(),
            to: match[2].trim(),
            label: '',
          });
        }
        break;
      }
    }
  }

  return connections;
}

/** Extract node id from element attributes. */
function extractNodeId(element: Element): string {
  const dataId = element.getAttribute('data-id');
  if (dataId) return dataId;
  
  const id = element.id;
  if (id?.includes('flowchart-')) {
    const match = id.match(/flowchart-([A-Za-z0-9_]+)/);
    return match?.[1] || id;
  }
  if (id && (id.includes('subGraph') || id.includes('sg-') || id.includes('cluster'))) {
    const match = id.match(/(?:subGraph|sg-|cluster)([A-Za-z0-9_]+)/);
    return match?.[1] || id;
  }
  return id || 'unknown';
}

/** Extract node label text. */
function extractNodeText(element: Element): string {
  let textElement = element.querySelector('text, tspan, span, div, p, foreignObject text, .nodeLabel');
  
  if (!textElement || !textElement.textContent?.trim()) {
    textElement = element.querySelector('.label, .subgraph-title, .cluster-label, .cluster text');
  }
  
  return textElement?.textContent?.trim() || extractNodeId(element);
}

/** Detect subgraph/cluster elements. */
function isSubgraphElement(element: Element): boolean {
  return element.classList.contains('cluster') ||
    element.id.includes('cluster') ||
    element.id.includes('subGraph') ||
    element.classList.contains('subgraph');
}

// ==================== Hook ====================

export function useSvgInteraction(options: SvgInteractionOptions): SvgInteractionReturn {
  const { 
    sourceCode, 
    isEditMode = true,
    nodeMetadata,
    enableTooltips = false,
    onNodeClick, 
    onEdgeClick, 
    onTooltipShow,
    onTooltipUpdate,
    onTooltipHide,
    hasDragged, 
    resetDragState,
    onFileNavigate,
  } = options;
  
  // Store callbacks in refs to avoid stale closures.
  const onNodeClickRef = useRef(onNodeClick);
  const onEdgeClickRef = useRef(onEdgeClick);
  const onTooltipShowRef = useRef(onTooltipShow);
  const onTooltipUpdateRef = useRef(onTooltipUpdate);
  const onTooltipHideRef = useRef(onTooltipHide);
  const hasDraggedRef = useRef(hasDragged);
  const isEditModeRef = useRef(isEditMode);
  const nodeMetadataRef = useRef(nodeMetadata);
  const onFileNavigateRef = useRef(onFileNavigate);
  
  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
    onEdgeClickRef.current = onEdgeClick;
    onTooltipShowRef.current = onTooltipShow;
    onTooltipUpdateRef.current = onTooltipUpdate;
    onTooltipHideRef.current = onTooltipHide;
    hasDraggedRef.current = hasDragged;
    isEditModeRef.current = isEditMode;
    onFileNavigateRef.current = onFileNavigate;
    nodeMetadataRef.current = nodeMetadata;
  });

  /** Check whether an element has user-defined styles. */
  const hasCustomStyle = (element: SVGElement): boolean => {
    const fill = element.getAttribute('fill');
    const style = element.getAttribute('style');
    
    if (style && (style.includes('fill') || style.includes('stroke'))) {
      return true;
    }
    
    // Treat non-default Mermaid colors as custom.
    const defaultFills = ['#ececff', '#9370db', 'none', '', '#f9f9f9', '#ffffff', '#fff'];
    if (fill && !defaultFills.includes(fill.toLowerCase())) {
      return true;
    }
    
    return false;
  };

  /** Apply base styles while preserving custom styles. */
  const applyBaseStyles = useCallback((svgElement: SVGElement) => {
    const colors = getRuntimeColors();
    
    const nodes = svgElement.querySelectorAll(
      'g[id*="flowchart-"], .node, g[id*="subGraph"], .subgraph, ' +
      'g[class*="subgraph"], g[id*="sg-"], g[class*="cluster"], .cluster, ' +
      'g[id*="cluster"], g[data-id], rect[class*="cluster"]'
    );
    
    nodes.forEach((node) => {
      const element = node as HTMLElement;
      const isSubgraph = isSubgraphElement(element);
      
      const shapes = element.querySelectorAll(':scope > rect, :scope > circle, :scope > ellipse, :scope > polygon, :scope > path');
      shapes.forEach((shape) => {
        const shapeEl = shape as SVGElement;
        
        if (hasCustomStyle(shapeEl)) {
          shapeEl.style.transition = 'all 0.2s ease';
          return;
        }
        
        if (isSubgraph) {
          shapeEl.style.fill = colors.cluster.fill;
          shapeEl.style.stroke = colors.cluster.stroke;
          shapeEl.style.strokeDasharray = colors.cluster.dashArray;
          shapeEl.style.strokeWidth = '1px';
        } else {
          shapeEl.style.fill = colors.node.fill;
          shapeEl.style.stroke = colors.node.stroke;
          shapeEl.style.strokeDasharray = colors.node.dashArray;
          shapeEl.style.strokeWidth = '1.5px';
        }
        shapeEl.style.transition = 'all 0.2s ease';
      });
      
      const rects = element.querySelectorAll(':scope > rect');
      rects.forEach((rect) => {
        const rectEl = rect as SVGElement;
        if (!rectEl.getAttribute('rx')) {
          rectEl.setAttribute('rx', isSubgraph ? '8' : '6');
          rectEl.setAttribute('ry', isSubgraph ? '8' : '6');
        }
      });
    });
    
    const edgeLabels = svgElement.querySelectorAll('.edgeLabel, g.edgeLabel');
    edgeLabels.forEach((label) => {
      const rects = label.querySelectorAll('rect');
      rects.forEach((rect) => {
        const rectEl = rect as SVGElement;
        rectEl.style.fill = colors.edgeLabel.fill;
        rectEl.style.stroke = colors.edgeLabel.stroke;
        rectEl.style.strokeWidth = '1px';
        rectEl.style.strokeDasharray = '3 2';
        rectEl.style.transition = 'all 0.2s ease';
        rectEl.setAttribute('rx', '4');
        rectEl.setAttribute('ry', '4');
      });
      
      const texts = label.querySelectorAll('text, tspan, span');
      texts.forEach((text) => {
        if (text instanceof SVGElement) {
          text.style.fill = colors.text.secondary;
        } else if (text instanceof HTMLElement) {
          text.style.color = colors.text.secondary;
        }
      });
    });
    
    const edgePaths = svgElement.querySelectorAll('.edgePath path, path[id*="L_"]');
    edgePaths.forEach((path) => {
      const pathEl = path as SVGElement;
      pathEl.style.stroke = colors.edge.stroke;
      pathEl.style.strokeWidth = '1.5px';
      pathEl.style.strokeLinecap = 'round';
      pathEl.style.strokeLinejoin = 'round';
      pathEl.style.transition = 'all 0.2s ease';
    });
  }, []);

  /** Attach interaction handlers. */
  const setupInteraction = useCallback((svgElement: SVGElement): () => void => {
    const cleanupFunctions: (() => void)[] = [];
    const colors = getRuntimeColors();

    const handleClick = async (event: MouseEvent) => {
      if (hasDraggedRef.current) {
        resetDragState?.();
        return;
      }
      
      const target = event.target as Element;
      const svgRect = svgElement.getBoundingClientRect();
      
      const enhancedEvent = {
        clientX: event.clientX,
        clientY: event.clientY,
        pageX: event.pageX || event.clientX,
        pageY: event.pageY || event.clientY,
        svgRect,
        stopPropagation: () => event.stopPropagation(),
        preventDefault: () => event.preventDefault(),
        target: event.target,
        currentTarget: event.currentTarget,
      } as any;

      const nodeElement = target.closest(
        'g[id*="flowchart-"], .node, g[class*="node"], g[id*="subGraph"], .subgraph, ' +
        'g[class*="subgraph"], g[id*="sg-"], g[class*="cluster"], .cluster, g[id*="cluster"], g[data-id]'
      );
      
      if (nodeElement) {
        const nodeId = extractNodeId(nodeElement);
        const nodeText = extractNodeText(nodeElement);
        event.stopPropagation();
        
        if (isEditModeRef.current && onNodeClickRef.current) {
          onNodeClickRef.current({ id: nodeId, text: nodeText }, enhancedEvent);
          return;
        }
        
        const metadata = nodeMetadataRef.current?.[nodeId];
        if (metadata?.file_path) {
          try {
            if (onFileNavigateRef.current) {
              onFileNavigateRef.current(metadata.file_path, metadata.line_number || 1, metadata);
            } else if (metadata.node_type === 'directory') {
              const { appManager } = await import('@/app/services/AppManager');
              const { globalEventBus } = await import('@/infrastructure/event-bus/EventBus');
              
              appManager.updateLayout({
                leftPanelActiveTab: 'files',
                leftPanelCollapsed: false
              });
              
              globalEventBus.emit('file-explorer:navigate', { 
                path: metadata.file_path,
                scrollIntoView: true
              });
            } else {
              const targetLine = metadata.line_number || 1;
              const { fileTabManager } = await import('@/shared/services/FileTabManager');
              fileTabManager.openFileAndJump(metadata.file_path, targetLine, 1, {
                splitView: true,
                targetGroup: 'secondary',
              });
            }
          } catch (err) {
            log.error('Operation failed', { nodeId, metadata, error: err });
          }
        }
        return;
      }

      if (isEditModeRef.current) {
        const pathElement = target.closest('path[id*="L_"]') || 
          (target.tagName === 'path' && (target as Element).id.includes('L_') ? target : null);
        const edgeLabelElement = target.closest('.edgeLabel');
        
        if ((pathElement || edgeLabelElement) && onEdgeClickRef.current) {
          let fromNode = '';
          let toNode = '';
          let edgeText = '';
          
          if (pathElement?.id) {
            const pathMatch = pathElement.id.match(/L_([^_]+)_([^_]+)_\d+/);
            if (pathMatch) {
              [, fromNode, toNode] = pathMatch;
            }
          }
          
          if (edgeLabelElement && !fromNode && !toNode) {
            edgeText = target.textContent?.trim() || '';
            const connections = extractConnectionsFromSource(sourceCode);
            const match = connections.find(conn => conn.label === edgeText);
            if (match) {
              fromNode = match.from;
              toNode = match.to;
            }
          }
          
          if (fromNode && toNode) {
            const connections = extractConnectionsFromSource(sourceCode);
            const conn = connections.find(c => c.from === fromNode && c.to === toNode);
            if (conn?.label) edgeText = conn.label;
          }
          
          if (!edgeText && edgeLabelElement) {
            edgeText = target.textContent?.trim() || '';
          }
          
          event.stopPropagation();
          onEdgeClickRef.current({
            id: (fromNode && toNode) ? `${fromNode}-${toNode}` : 'unknown',
            text: edgeText,
            fromNode,
            toNode,
          }, enhancedEvent);
        }
      }
    };

    svgElement.addEventListener('click', handleClick);
    cleanupFunctions.push(() => svgElement.removeEventListener('click', handleClick));

    const nodes = svgElement.querySelectorAll(
      'g[id*="flowchart-"], .node, g[id*="subGraph"], .subgraph, ' +
      'g[class*="subgraph"], g[id*="sg-"], g[class*="cluster"], .cluster, g[id*="cluster"], g[data-id]'
    );
    
    let tooltipShowTimeout: ReturnType<typeof setTimeout> | null = null;
    let currentTooltipNodeId: string | null = null;
    
    const TOOLTIP_SHOW_DELAY = 150;
    
    nodes.forEach((node) => {
      const element = node as HTMLElement;
      const nodeId = extractNodeId(element);
      
      // Editable nodes are always interactive; view mode requires metadata.
      const getMetadata = () => nodeMetadataRef.current?.[nodeId];
      const isInteractive = () => isEditModeRef.current || !!getMetadata();
      
      if (!isInteractive()) {
        element.style.cursor = 'default';
        element.style.pointerEvents = 'none';
        return;
      }
      
      element.style.cursor = 'pointer';
      element.style.transition = 'all 0.2s ease';
      
      const handleMouseEnter = (e: MouseEvent) => {
        const currentColors = getRuntimeColors();
        const isSubgraph = isSubgraphElement(element);
        const metadata = getMetadata();
        
        const shapes = element.querySelectorAll(':scope > rect, :scope > circle, :scope > ellipse, :scope > polygon, :scope > path');
        shapes.forEach((shape) => {
          const shapeEl = shape as SVGElement;
          
          if (!shapeEl.hasAttribute('data-original-fill')) {
            const computedFill = shapeEl.style.fill || shapeEl.getAttribute('fill') || '';
            const computedStroke = shapeEl.style.stroke || shapeEl.getAttribute('stroke') || '';
            if (computedFill) shapeEl.setAttribute('data-original-fill', computedFill);
            if (computedStroke) shapeEl.setAttribute('data-original-stroke', computedStroke);
          }
          
          shapeEl.style.stroke = currentColors.highlight.stroke;
          shapeEl.style.strokeWidth = isSubgraph ? '1.5px' : '2px';
          shapeEl.style.strokeDasharray = 'none';
          shapeEl.style.filter = currentColors.highlight.glow;
        });
        
        const texts = element.querySelectorAll(':scope > text, :scope > tspan, .nodeLabel');
        texts.forEach((text) => {
          const textEl = text as SVGElement;
          if (!textEl.hasAttribute('data-original-fill')) {
            const computedFill = textEl.style.fill || textEl.getAttribute('fill') || '';
            if (computedFill) textEl.setAttribute('data-original-fill', computedFill);
          }
          textEl.style.fill = currentColors.text.highlight;
          textEl.style.fontWeight = '600';
        });
        
        if (enableTooltips && metadata && onTooltipShowRef.current) {
          if (tooltipShowTimeout) {
            clearTimeout(tooltipShowTimeout);
          }
          
          tooltipShowTimeout = setTimeout(() => {
            currentTooltipNodeId = nodeId;
            
            let fileLocation = '';
            if (metadata.file_path) {
              if (metadata.node_type === 'directory') {
                fileLocation = metadata.file_path;
              } else if (metadata.line_number) {
                fileLocation = `${metadata.file_path}:${metadata.line_number}`;
              } else {
                fileLocation = metadata.file_path;
              }
            }
            
            onTooltipShowRef.current?.({
              title: metadata.label || extractNodeText(element),
              file_location: fileLocation,
              description: metadata.description || '',
              node_type: metadata.node_type,
              trace_id: metadata.trace_id,
              captured_vars: metadata.log_data ? Object.keys(metadata.log_data) : undefined,
              log_data: metadata.log_data,
            }, {
              x: e.clientX,
              y: e.clientY,
            }, nodeId);
          }, TOOLTIP_SHOW_DELAY);
        }
      };
      
      const handleMouseMove = (e: MouseEvent) => {
        if (currentTooltipNodeId === nodeId && onTooltipUpdateRef.current) {
          onTooltipUpdateRef.current({
            x: e.clientX,
            y: e.clientY,
          });
        }
      };
      
      const handleMouseLeave = () => {
        const currentColors = getRuntimeColors();
        const isSubgraph = isSubgraphElement(element);
        
        const shapes = element.querySelectorAll(':scope > rect, :scope > circle, :scope > ellipse, :scope > polygon, :scope > path');
        shapes.forEach((shape) => {
          const shapeEl = shape as SVGElement;
          
          const originalFill = shapeEl.getAttribute('data-original-fill');
          const originalStroke = shapeEl.getAttribute('data-original-stroke');
          
          if (originalFill !== null || originalStroke !== null) {
            if (originalFill) shapeEl.style.fill = originalFill;
            if (originalStroke) shapeEl.style.stroke = originalStroke;
          } else {
            if (isSubgraph) {
              shapeEl.style.fill = currentColors.cluster.fill;
              shapeEl.style.stroke = currentColors.cluster.stroke;
              shapeEl.style.strokeDasharray = currentColors.cluster.dashArray;
              shapeEl.style.strokeWidth = '1px';
            } else {
              shapeEl.style.fill = currentColors.node.fill;
              shapeEl.style.stroke = currentColors.node.stroke;
              shapeEl.style.strokeDasharray = currentColors.node.dashArray;
              shapeEl.style.strokeWidth = '1.5px';
            }
          }
          shapeEl.style.filter = '';
        });
        
        // Restore text styles.
        const texts = element.querySelectorAll(':scope > text, :scope > tspan, .nodeLabel');
        texts.forEach((text) => {
          const textEl = text as SVGElement;
          const originalFill = textEl.getAttribute('data-original-fill');
          if (originalFill) {
            textEl.style.fill = originalFill;
          }
          textEl.style.fontWeight = '';
        });
        
        const foreignTexts = element.querySelectorAll('foreignObject span, foreignObject p, foreignObject div');
        foreignTexts.forEach((text) => {
          const textEl = text as HTMLElement;
          const originalColor = textEl.getAttribute('data-original-color');
          if (originalColor) {
            textEl.style.color = originalColor;
          }
        });
        
        if (tooltipShowTimeout) {
          clearTimeout(tooltipShowTimeout);
          tooltipShowTimeout = null;
        }
        currentTooltipNodeId = null;
        onTooltipHideRef.current?.();
      };
      
      element.addEventListener('mouseenter', handleMouseEnter as EventListener);
      element.addEventListener('mousemove', handleMouseMove as EventListener);
      element.addEventListener('mouseleave', handleMouseLeave);
      cleanupFunctions.push(() => {
        element.removeEventListener('mouseenter', handleMouseEnter as EventListener);
        element.removeEventListener('mousemove', handleMouseMove as EventListener);
        element.removeEventListener('mouseleave', handleMouseLeave);
      });
    });
    
    cleanupFunctions.push(() => {
      if (tooltipShowTimeout) clearTimeout(tooltipShowTimeout);
    });
    
    if (isEditModeRef.current) {
      const edgeLabels = svgElement.querySelectorAll('.edgeLabel, g.edgeLabel');
      edgeLabels.forEach((label) => {
        const element = label as HTMLElement;
        element.style.cursor = 'pointer';
        element.style.transition = 'all 0.2s ease';
        
        const handleMouseEnter = () => {
          const currentColors = getRuntimeColors();
          const rects = element.querySelectorAll('rect');
          rects.forEach((rect) => {
            const rectEl = rect as SVGElement;
            rectEl.style.stroke = currentColors.highlight.stroke;
            rectEl.style.strokeWidth = '1.5px';
            rectEl.style.strokeDasharray = 'none';
            rectEl.style.filter = currentColors.highlight.glow;
          });
          
          const texts = element.querySelectorAll('text, tspan');
          texts.forEach((text) => {
            const textEl = text as SVGElement;
            textEl.style.fill = currentColors.text.highlight;
            textEl.style.fontWeight = '600';
          });
        };
        
        const handleMouseLeave = () => {
          const currentColors = getRuntimeColors();
          const rects = element.querySelectorAll('rect');
          rects.forEach((rect) => {
            const rectEl = rect as SVGElement;
            rectEl.style.fill = currentColors.edgeLabel.fill;
            rectEl.style.stroke = currentColors.edgeLabel.stroke;
            rectEl.style.strokeWidth = '1px';
            rectEl.style.strokeDasharray = '3 2';
            rectEl.style.filter = '';
          });
          
          const texts = element.querySelectorAll('text, tspan');
          texts.forEach((text) => {
            const textEl = text as SVGElement;
            textEl.style.fill = currentColors.text.secondary;
            textEl.style.fontWeight = '';
          });
        };
        
        element.addEventListener('mouseenter', handleMouseEnter);
        element.addEventListener('mouseleave', handleMouseLeave);
        cleanupFunctions.push(() => {
          element.removeEventListener('mouseenter', handleMouseEnter);
          element.removeEventListener('mouseleave', handleMouseLeave);
        });
      });
      
      const edges = svgElement.querySelectorAll('path[id*="L_"], .edgePath path');
      edges.forEach((edge) => {
        const element = edge as SVGElement;
        element.style.cursor = 'pointer';
        element.style.transition = 'all 0.2s ease';
        
        const originalStroke = element.style.stroke || element.getAttribute('stroke') || colors.edge.stroke;
        const originalStrokeWidth = element.style.strokeWidth || element.getAttribute('stroke-width') || '1.5px';
        
        const handleMouseEnter = () => {
          const currentColors = getRuntimeColors();
          element.style.stroke = currentColors.highlight.stroke;
          element.style.strokeWidth = '2px';
          element.style.filter = currentColors.highlight.glow;
        };
        
        const handleMouseLeave = () => {
          element.style.stroke = originalStroke;
          element.style.strokeWidth = originalStrokeWidth;
          element.style.filter = '';
        };
        
        element.addEventListener('mouseenter', handleMouseEnter);
        element.addEventListener('mouseleave', handleMouseLeave);
        cleanupFunctions.push(() => {
          element.removeEventListener('mouseenter', handleMouseEnter);
          element.removeEventListener('mouseleave', handleMouseLeave);
        });
      });
    } else {
      const edgeLabels = svgElement.querySelectorAll('.edgeLabel, g.edgeLabel');
      edgeLabels.forEach((label) => {
        const element = label as HTMLElement;
        element.style.pointerEvents = 'none';
      });
      
      const edges = svgElement.querySelectorAll('path[id*="L_"], .edgePath path');
      edges.forEach((edge) => {
        const element = edge as SVGElement;
        element.style.pointerEvents = 'none';
      });
    }

    return () => {
      cleanupFunctions.forEach(cleanup => cleanup());
    };
  }, [sourceCode, enableTooltips, resetDragState]);

  return {
    setupInteraction,
    applyBaseStyles,
  };
}
