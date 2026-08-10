/**
 * Pan and zoom hook.
 * Centralizes SVG container zoom and drag behavior.
 *
 * Features:
 * - Mouse wheel zoom (centered on cursor)
 * - Mouse drag panning
 * - Zoom controls (in, out, reset)
 * - Prevent drag vs click conflicts
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';

export interface PanZoomState {
  scale: number;
  translateX: number;
  translateY: number;
}

export interface PanZoomOptions {
  /** Minimum scale, default 0.1. */
  minScale?: number;
  /** Maximum scale, default 5. */
  maxScale?: number;
  /** Zoom step factor, default 1.2. */
  scaleFactor?: number;
  /** Enable wheel zoom, default true. */
  enableWheelZoom?: boolean;
  /** Enable drag panning, default true. */
  enableDrag?: boolean;
  /** Drag distance threshold (px) before considered a drag, default 5. */
  dragThreshold?: number;
  /** Zoom change callback. */
  onZoomChange?: (zoomLevel: number) => void;
}

export interface PanZoomControls {
  /** Zoom in. */
  zoomIn: () => void;
  /** Zoom out. */
  zoomOut: () => void;
  /** Reset view. */
  resetView: () => void;
  /** Fit content into container: auto zoom and center. */
  fitToContainer: (contentWidth: number, contentHeight: number) => void;
  /** Get current zoom percentage. */
  getZoomLevel: () => number;
  /** Set scale directly. */
  setScale: (scale: number) => void;
}

export interface PanZoomHandlers {
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseUp: () => void;
  onDoubleClick: () => void;
}

export interface UsePanZoomReturn {
  /** Current transform state. */
  transform: PanZoomState;
  /** Whether dragging is active. */
  isDragging: boolean;
  /** Whether a drag just finished (used to suppress clicks). */
  hasDragged: boolean;
  /** Event handlers. */
  handlers: PanZoomHandlers;
  /** Control helpers. */
  controls: PanZoomControls;
  /** Container ref for wheel events. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Reset drag state manually. */
  resetDragState: () => void;
}

export function usePanZoom(options: PanZoomOptions = {}): UsePanZoomReturn {
  const {
    minScale = 0.1,
    maxScale = 5,
    scaleFactor = 1.2,
    enableWheelZoom = true,
    enableDrag = true,
    dragThreshold = 5,
    onZoomChange,
  } = options;

  const [transform, setTransform] = useState<PanZoomState>({
    scale: 1,
    translateX: 0,
    translateY: 0,
  });

  const [isDragging, setIsDragging] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const dragStartPosRef = useRef({ x: 0, y: 0 });
  const hasDraggedRef = useRef(false);

  // ==================== Controls ====================
  
  const zoomIn = useCallback(() => {
    setTransform(prev => {
      const newScale = Math.min(maxScale, prev.scale * scaleFactor);
      return { ...prev, scale: newScale };
    });
  }, [maxScale, scaleFactor]);

  const zoomOut = useCallback(() => {
    setTransform(prev => {
      const newScale = Math.max(minScale, prev.scale / scaleFactor);
      return { ...prev, scale: newScale };
    });
  }, [minScale, scaleFactor]);

  const resetView = useCallback(() => {
    setTransform({ scale: 1, translateX: 0, translateY: 0 });
  }, []);

  /**
   * Fit content into the container with auto zoom and centering.
   * @param contentWidth Original SVG content width.
   * @param contentHeight Original SVG content height.
   */
  const fitToContainer = useCallback((contentWidth: number, contentHeight: number) => {
    const container = containerRef.current;
    if (!container || contentWidth <= 0 || contentHeight <= 0) return;
    
    const rect = container.getBoundingClientRect();
    const containerWidth = rect.width;
    const containerHeight = rect.height;
    
    // Compute fit scale with padding (90%).
    const padding = 0.9;
    const scaleX = (containerWidth * padding) / contentWidth;
    const scaleY = (containerHeight * padding) / contentHeight;
    
    // Use the smaller scale to keep content fully visible.
    // Clamp to 1.5x to avoid over-scaling small diagrams.
    const newScale = Math.min(scaleX, scaleY, 1.5);
    // Do not go below the minimum scale.
    const clampedScale = Math.max(minScale, Math.min(maxScale, newScale));
    
    // Compute centered position.
    const scaledWidth = contentWidth * clampedScale;
    const scaledHeight = contentHeight * clampedScale;
    const translateX = (containerWidth - scaledWidth) / 2;
    const translateY = (containerHeight - scaledHeight) / 2;
    
    setTransform({
      scale: clampedScale,
      translateX,
      translateY,
    });
  }, [minScale, maxScale]);

  const getZoomLevel = useCallback(() => {
    return Math.round(transform.scale * 100);
  }, [transform.scale]);

  const setScale = useCallback((scale: number) => {
    const clampedScale = Math.max(minScale, Math.min(maxScale, scale));
    setTransform(prev => ({ ...prev, scale: clampedScale }));
  }, [minScale, maxScale]);

  const resetDragState = useCallback(() => {
    hasDraggedRef.current = false;
    setHasDragged(false);
  }, []);

  // ==================== Drag handling ====================

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!enableDrag) return;
    
    // Skip drag when interacting with nodes or edges.
    const target = e.target as Element;
    const isInteractiveElement = target.closest(
      'g[id*="flowchart-"], .node, g[class*="node"], ' +
      '.edgeLabel, path[id*="L_"], g.edgePath, ' +
      'g[id*="subGraph"], .subgraph, g[class*="cluster"], .cluster, ' +
      '.interactive-node'
    );
    
    if (isInteractiveElement) {
      // Reset drag state to allow click handling.
      hasDraggedRef.current = false;
      setHasDragged(false);
      return;
    }
    
    // Support left and middle button drag.
    if (e.button === 0 || e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      
      setIsDragging(true);
      hasDraggedRef.current = false;
      dragStartPosRef.current = { x: e.clientX, y: e.clientY };
      dragStartRef.current = {
        x: e.clientX - transform.translateX,
        y: e.clientY - transform.translateY,
      };
    }
  }, [enableDrag, transform.translateX, transform.translateY]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    // Compute drag distance.
    const deltaX = e.clientX - dragStartPosRef.current.x;
    const deltaY = e.clientY - dragStartPosRef.current.y;
    const dragDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    // Treat as drag only after threshold.
    if (dragDistance > dragThreshold) {
      hasDraggedRef.current = true;
      setHasDragged(true);
    }
    
    setTransform(prev => ({
      ...prev,
      translateX: e.clientX - dragStartRef.current.x,
      translateY: e.clientY - dragStartRef.current.y,
    }));
  }, [isDragging, dragThreshold]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    
    // Delay reset so click handlers can check drag state.
    if (hasDraggedRef.current) {
      setTimeout(() => {
        hasDraggedRef.current = false;
        setHasDragged(false);
      }, 50);
    }
  }, []);

  // Double-click reset callback (overridable by consumer).
  const handleDoubleClick = useCallback(() => {
    resetView();
  }, [resetView]);
  // ==================== Global mouse events ====================

  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      
      const deltaX = e.clientX - dragStartPosRef.current.x;
      const deltaY = e.clientY - dragStartPosRef.current.y;
      const dragDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      
      if (dragDistance > dragThreshold) {
        hasDraggedRef.current = true;
        setHasDragged(true);
      }
      
      setTransform(prev => ({
        ...prev,
        translateX: e.clientX - dragStartRef.current.x,
        translateY: e.clientY - dragStartRef.current.y,
      }));
    };

    const handleGlobalMouseUp = () => {
      setIsDragging(false);
      
      if (hasDraggedRef.current) {
        setTimeout(() => {
          hasDraggedRef.current = false;
          setHasDragged(false);
        }, 50);
      }
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging, dragThreshold]);

  // ==================== Wheel zoom ====================

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enableWheelZoom) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      
      const rect = container.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const zoomFactor = e.deltaY > 0 ? 1 / scaleFactor : scaleFactor;
      
      setTransform(prev => {
        const newScale = Math.max(minScale, Math.min(maxScale, prev.scale * zoomFactor));
        const scaleRatio = newScale / prev.scale;
        
        // Zoom around the cursor position.
        const newTranslateX = centerX + (prev.translateX - centerX) * scaleRatio + (mouseX - centerX) * (1 - scaleRatio);
        const newTranslateY = centerY + (prev.translateY - centerY) * scaleRatio + (mouseY - centerY) * (1 - scaleRatio);
        
        return {
          scale: newScale,
          translateX: newTranslateX,
          translateY: newTranslateY,
        };
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [enableWheelZoom, minScale, maxScale, scaleFactor]);

  // ==================== Zoom change notification ====================

  useEffect(() => {
    if (onZoomChange) {
      onZoomChange(Math.round(transform.scale * 100));
    }
  }, [transform.scale, onZoomChange]);

  // ==================== Return ====================

  const handlers = useMemo<PanZoomHandlers>(() => ({
    onMouseDown: handleMouseDown,
    onMouseMove: handleMouseMove,
    onMouseUp: handleMouseUp,
    onDoubleClick: handleDoubleClick,
  }), [handleMouseDown, handleMouseMove, handleMouseUp, handleDoubleClick]);

  const controls = useMemo<PanZoomControls>(() => ({
    zoomIn,
    zoomOut,
    resetView,
    fitToContainer,
    getZoomLevel,
    setScale,
  }), [zoomIn, zoomOut, resetView, fitToContainer, getZoomLevel, setScale]);

  return {
    transform,
    isDragging,
    hasDragged,
    handlers,
    controls,
    containerRef,
    resetDragState,
  };
}
