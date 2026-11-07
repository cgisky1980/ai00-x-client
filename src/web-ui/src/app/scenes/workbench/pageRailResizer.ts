/**
 * 插件页项目栏宽度拖拽（宿主统一提供）。
 *
 * 工作台插件页遵循宿主定义的结构契约：根 `.ai00-x-wb-layout` + 左栏
 * `.ai00-x-wb-layout__rail` + 主区 `.ai00-x-wb-layout__main`。插件自己的代码
 * 不关心宽度，宽度由宿主在 `__rail` 右侧插一条分隔条并写入 `flex-basis`。
 *
 * 之所以用原生 DOM 而不是 React 组件：`__rail` 由插件渲染在宿主给的容器里，
 * 宿主没法包一层 JSX；这里只做「找到它、插一个手柄、调整它的宽度」。
 * 插件重渲染把手柄冲掉时，MutationObserver 会重新插回去。
 */

const RAIL_SELECTOR = '.ai00-x-wb-layout__rail';
const HANDLE_CLASS = 'ai00-x-workbench-scene__page-resizer';

export interface PageRailResizerOptions {
  /** 插件页挂载容器（宿主 `__host`） */
  host: HTMLElement;
  /** localStorage 键：记忆宽度 */
  storageKey: string;
  /** 分隔条的可访问名称 */
  label: string;
  defaultWidth?: number;
  min?: number;
  max?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function readWidth(storageKey: string, fallback: number, min: number, max: number): number {
  try {
    const parsed = Number.parseInt(window.localStorage.getItem(storageKey) ?? '', 10);
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
  } catch {
    return fallback;
  }
}

export function attachPageRailResizer({
  host,
  storageKey,
  label,
  defaultWidth = 220,
  min = 168,
  max = 420,
}: PageRailResizerOptions): () => void {
  let rail: HTMLElement | null = null;
  let handle: HTMLDivElement | null = null;
  let width = readWidth(storageKey, defaultWidth, min, max);
  let disposed = false;

  const persist = (): void => {
    try {
      window.localStorage.setItem(storageKey, String(Math.round(width)));
    } catch {
      // 存储不可用：不记忆不影响当前会话
    }
  };

  const applyWidth = (): void => {
    if (!rail) return;
    // min-width: 0 必须显式给：rail 是 flex item，默认 min-width: auto 时
    // 内容的最小宽度（工程名 + 「已应用」徽标）会把宽度顶住，拖拽看起来没反应。
    rail.style.minWidth = '0';
    rail.style.flex = `0 0 ${width}px`;
    handle?.setAttribute('aria-valuenow', String(Math.round(width)));
  };

  const setWidth = (next: number): void => {
    width = clamp(Math.round(next), min, max);
    applyWidth();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !rail || !handle) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    handle.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: PointerEvent): void => {
      setWidth(startWidth + (moveEvent.clientX - startX));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      handle?.classList.remove('is-dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persist();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const stride = event.shiftKey ? 64 : 16;
    if (event.key === 'ArrowRight') setWidth(width + stride);
    else if (event.key === 'ArrowLeft') setWidth(width - stride);
    else if (event.key === 'Home') setWidth(defaultWidth);
    else return;
    event.preventDefault();
    persist();
  };

  const resetWidth = (): void => {
    setWidth(defaultWidth);
    persist();
  };

  const createHandle = (target: HTMLElement): HTMLDivElement => {
    const element = document.createElement('div');
    element.className = HANDLE_CLASS;
    element.setAttribute('role', 'separator');
    element.setAttribute('aria-orientation', 'vertical');
    element.setAttribute('aria-label', label);
    element.setAttribute('aria-valuemin', String(min));
    element.setAttribute('aria-valuemax', String(max));
    element.tabIndex = 0;
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('dblclick', resetWidth);
    target.insertAdjacentElement('afterend', element);
    return element;
  };

  /** 保证「当前 rail 有一个与之相邻的手柄」，插件重渲染后自动补回。 */
  const sync = (): void => {
    if (disposed) return;
    const nextRail = host.querySelector<HTMLElement>(RAIL_SELECTOR);
    if (!nextRail) {
      if (handle?.isConnected) handle.remove();
      handle = null;
      rail = null;
      return;
    }
    if (nextRail === rail && handle?.isConnected) {
      applyWidth();
      return;
    }
    if (handle?.isConnected) handle.remove();
    rail = nextRail;
    handle = createHandle(nextRail);
    applyWidth();
  };

  const observer = new MutationObserver(() => sync());
  observer.observe(host, { childList: true, subtree: true });
  sync();

  return () => {
    disposed = true;
    observer.disconnect();
    if (handle?.isConnected) handle.remove();
    handle = null;
    rail = null;
  };
}
