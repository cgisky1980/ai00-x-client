import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 面板宽度拖拽（像素制，记忆到 localStorage）。
 *
 * 与 `useResizer`（比例制、只服务编辑器分栏）分工不同：这里用于「固定宽度的
 * 侧栏 / 对话栏」，宽度是绝对像素值，需要：
 * - 指针拖拽（鼠标/触控/触控笔统一走 Pointer Events + setPointerCapture）
 * - 键盘可调（role=separator + ←/→ 或 ↑/↓，Shift 加速，双击/Home 复位）
 * - 越界钳制与重启记忆
 *
 * 返回的 `handleProps` 直接铺到分隔条元素上；`width` 由调用方写进样式
 * （推荐写成 CSS 变量，保持样式表里只有默认值）。
 */

export interface UseResizablePaneOptions {
  /** localStorage 键：记忆宽度 */
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /**
   * 分隔条相对面板的位置：
   * - `'left'`：面板在分隔条右侧（对话栏），向左拖 = 变宽
   * - `'right'`：面板在分隔条左侧（侧边栏），向右拖 = 变宽
   */
  edge: 'left' | 'right';
  /** 键盘单次调整步长（px，默认 16） */
  step?: number;
  /** 分隔条的可访问名称（i18n 文案） */
  label: string;
  /** 关闭拖拽（例如窄窗口下该栏变为浮层） */
  disabled?: boolean;
}

export interface ResizablePaneHandleProps {
  role: 'separator';
  'aria-orientation': 'vertical';
  'aria-label': string;
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
  tabIndex: 0;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}

export interface UseResizablePaneReturn {
  width: number;
  setWidth: (next: number) => void;
  dragging: boolean;
  handleProps: ResizablePaneHandleProps;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function readStoredWidth(storageKey: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function useResizablePane({
  storageKey,
  defaultWidth,
  min,
  max,
  edge,
  step = 16,
  label,
  disabled = false,
}: UseResizablePaneOptions): UseResizablePaneReturn {
  const [width, setWidthState] = useState<number>(() =>
    clamp(readStoredWidth(storageKey, defaultWidth), min, max),
  );
  const [dragging, setDragging] = useState(false);
  /** 拖拽期间的实时宽度（不触发 localStorage 写入，抬高频繁存储的成本）。 */
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const setWidth = useCallback(
    (next: number): void => {
      const clamped = clamp(Math.round(next), min, max);
      widthRef.current = clamped;
      setWidthState(clamped);
      try {
        window.localStorage.setItem(storageKey, String(clamped));
      } catch {
        // 存储不可用（隐私模式等）：只是不记忆，不影响当前会话
      }
    },
    [max, min, storageKey],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (disabled || event.button !== 0) return;
      event.preventDefault();
      const target = event.currentTarget;
      const startX = event.clientX;
      const startWidth = widthRef.current;
      const direction = edge === 'left' ? -1 : 1;
      target.setPointerCapture?.(event.pointerId);
      setDragging(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (moveEvent: PointerEvent): void => {
        const delta = (moveEvent.clientX - startX) * direction;
        const next = clamp(startWidth + delta, min, max);
        widthRef.current = next;
        setWidthState(next);
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        setDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // 只有松手才落盘，避免拖拽过程中每帧写 localStorage
        try {
          window.localStorage.setItem(storageKey, String(Math.round(widthRef.current)));
        } catch {
          // 同上：不记忆不影响功能
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [disabled, edge, max, min, storageKey],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (disabled) return;
      const grow = edge === 'left' ? -1 : 1;
      const stride = event.shiftKey ? step * 4 : step;
      if (event.key === 'ArrowRight') setWidth(widthRef.current + stride * grow);
      else if (event.key === 'ArrowLeft') setWidth(widthRef.current - stride * grow);
      else if (event.key === 'Home') setWidth(defaultWidth);
      else return;
      event.preventDefault();
    },
    [defaultWidth, disabled, edge, setWidth, step],
  );

  const resetWidth = useCallback((): void => setWidth(defaultWidth), [defaultWidth, setWidth]);

  return {
    width,
    setWidth,
    dragging,
    handleProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': label,
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      tabIndex: 0,
      onPointerDown: handlePointerDown,
      onKeyDown: handleKeyDown,
      onDoubleClick: resetWidth,
    },
  };
}

export default useResizablePane;
