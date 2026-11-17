/**
 * useWorkbenchTabs — 工作台中间区标签状态（每个工作台独立一份）。
 *
 * - 首页标签固定为 `home`，不进状态、不可关闭。
 * - 文件标签按绝对路径去重，最多 8 个，超出淘汰最久未激活的。
 * - 子代理的子会话不进中区（用户要求：看子代理过程不离开当前对话），
 *   由对话里的子代理卡就地展开，所以这里只维护文件标签。
 * - 状态按 scope（工作台 id）记忆到 localStorage，重载后恢复。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const HOME_TAB_KEY = 'home';
const FILE_TAB_PREFIX = 'file:';
const MAX_FILE_TABS = 8;

export interface WorkbenchFileTab {
  key: string;
  path: string;
  title: string;
}

interface PersistedTabs {
  paths: string[];
  activeKey: string;
}

function storageKey(scope: string): string {
  return `workbench.tabs.${scope || 'default'}`;
}

/** 从路径取文件名（跨 Windows/POSIX 分隔符）。 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function fileKey(path: string): string {
  return `${FILE_TAB_PREFIX}${path}`;
}

function readPersisted(scope: string): PersistedTabs {
  try {
    const raw = window.localStorage.getItem(storageKey(scope));
    if (!raw) return { paths: [], activeKey: HOME_TAB_KEY };
    const parsed = JSON.parse(raw) as Partial<PersistedTabs>;
    const paths = Array.isArray(parsed.paths)
      ? parsed.paths.filter((path): path is string => typeof path === 'string' && path.length > 0)
      : [];
    const activeKey = typeof parsed.activeKey === 'string' ? parsed.activeKey : HOME_TAB_KEY;
    return { paths, activeKey };
  } catch {
    return { paths: [], activeKey: HOME_TAB_KEY };
  }
}

/** activeKey 在当前标签集合里是否有效（首页永远有效）。 */
function isKnownTab(key: string, paths: string[]): boolean {
  if (key === HOME_TAB_KEY) return true;
  if (key.startsWith(FILE_TAB_PREFIX)) return paths.includes(key.slice(FILE_TAB_PREFIX.length));
  return false;
}

export interface UseWorkbenchTabsResult {
  /** 文件标签（不含首页）。 */
  fileTabs: WorkbenchFileTab[];
  activeKey: string;
  setActiveKey: (key: string) => void;
  /** 打开（或激活）一个文件标签。 */
  openFile: (path: string) => void;
  /** 关闭一个标签；关闭当前标签时回到首页。 */
  closeTab: (key: string) => void;
  /** 回到首页并清空所有标签（切任务/切项目时用）。 */
  reset: () => void;
}

export function useWorkbenchTabs(scope: string): UseWorkbenchTabsResult {
  const [paths, setPaths] = useState<string[]>(() => readPersisted(scope).paths);
  const [activeKey, setActiveKeyState] = useState<string>(() => {
    const stored = readPersisted(scope);
    return isKnownTab(stored.activeKey, stored.paths) ? stored.activeKey : HOME_TAB_KEY;
  });
  /** 最近激活顺序（淘汰最久未用的标签）。 */
  const orderRef = useRef<string[]>(paths);
  const scopeRef = useRef(scope);

  // 切换工作台 / 切换任务：换成该 scope 的记忆
  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    const stored = readPersisted(scope);
    setPaths(stored.paths);
    orderRef.current = stored.paths;
    setActiveKeyState(
      isKnownTab(stored.activeKey, stored.paths) ? stored.activeKey : HOME_TAB_KEY,
    );
  }, [scope]);

  // 落盘（含 activeKey）
  useEffect(() => {
    try {
      window.localStorage.setItem(
        storageKey(scope),
        JSON.stringify({ paths, activeKey } satisfies PersistedTabs),
      );
    } catch {
      // 存储不可用只是不记忆，不影响使用
    }
  }, [paths, activeKey, scope]);

  const setActiveKey = useCallback((key: string): void => {
    setActiveKeyState(key);
    if (key !== HOME_TAB_KEY) {
      orderRef.current = [...orderRef.current.filter(item => item !== key), key];
    }
  }, []);

  const openFile = useCallback((path: string): void => {
    const nextPath = path.trim();
    if (!nextPath) return;
    setPaths(prev => {
      if (prev.includes(nextPath)) return prev;
      const next = [...prev, nextPath];
      return next.length > MAX_FILE_TABS ? next.slice(next.length - MAX_FILE_TABS) : next;
    });
    setActiveKeyState(fileKey(nextPath));
  }, []);

  const closeTab = useCallback((key: string): void => {
    if (key.startsWith(FILE_TAB_PREFIX)) {
      const path = key.slice(FILE_TAB_PREFIX.length);
      setPaths(prev => prev.filter(item => item !== path));
    }
    orderRef.current = orderRef.current.filter(item => item !== key);
    setActiveKeyState(current => (current === key ? HOME_TAB_KEY : current));
  }, []);

  const reset = useCallback((): void => {
    setPaths([]);
    orderRef.current = [];
    setActiveKeyState(HOME_TAB_KEY);
  }, []);

  const fileTabs = useMemo(
    () =>
      paths.map(path => ({
        key: fileKey(path),
        path,
        title: baseName(path),
      })),
    [paths],
  );

  return {
    fileTabs,
    activeKey,
    setActiveKey,
    openFile,
    closeTab,
    reset,
  };
}

/** 页面里按 activeKey 取当前文件路径（首页返回 null）。 */
export function activeFilePath(activeKey: string): string | null {
  return activeKey.startsWith(FILE_TAB_PREFIX) ? activeKey.slice(FILE_TAB_PREFIX.length) : null;
}
