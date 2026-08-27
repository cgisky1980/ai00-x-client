/**
 * workspace — 委托执行的 cwd 解析（志 = 项目：项目有根，行在项目里做）。
 *
 * 解析链（高 → 低）：
 *   1. 关联志的 workspaceDir（goalId 顺藤摸瓜）
 *   2. 全局默认工作区（用户选过一次后 localStorage 持久化）
 *   3. null（不传 cwd——dsh 引擎默认目录，行为同旧版）
 *
 * 默认工作区不自动创建路径：首次委托时弹目录选择让用户挑（挑过不再问），
 * 用户取消则本次不带 cwd。志的目录在立志/志卡上显式选择，不做猜测。
 */
const DEFAULT_WS_KEY = 'ai00x.todo.defaultWorkspace';

import type { TodoData } from '../api/types';

/** 读取全局默认工作区（null = 尚未设置）。 */
export function getDefaultWorkspace(): string | null {
  try {
    return localStorage.getItem(DEFAULT_WS_KEY) || null;
  } catch {
    return null;
  }
}

/** 持久化全局默认工作区。 */
export function setDefaultWorkspace(dir: string): void {
  try {
    localStorage.setItem(DEFAULT_WS_KEY, dir);
  } catch {
    // localStorage 不可用——仅本次生效
  }
}

/**
 * 按解析链取委托 cwd：志目录 > 默认工作区 > null。
 * @param data todo 数据（找 goalId → workspaceDir）
 * @param goalId 行卡关联的志（可空）
 */
export function resolveDelegateCwd(data: TodoData, goalId: string | null): string | null {
  if (goalId) {
    const goal = data.goals.find(g => g.id === goalId);
    if (goal?.workspaceDir?.trim()) return goal.workspaceDir;
  }
  return getDefaultWorkspace();
}

/**
 * 原生目录选择（plugin-dialog——不依赖 dsh 引擎；dsh 的 host.pickDirectory
 * 在引擎未启动时静默失败返回 null，UI 无反应——勿用）。
 * 取消返回 null。
 */
export async function pickWorkspaceDir(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked === 'string') return picked;
  return null;
}
