import { isRemoteWorkspace, type WorkspaceInfo } from '@/shared/types';

function normalizePathForComparison(p: string | undefined | null): string {
  if (!p) return '';
  return p.split('\\').join('/').toLowerCase();
}

export function pathsEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  return normalizePathForComparison(a) === normalizePathForComparison(b);
}

/** 判断工作区是否属于远程（保留给壁纸/工作区 UI 使用） */
export function workspaceMatchesRemote(workspace: WorkspaceInfo): boolean {
  return isRemoteWorkspace(workspace);
}
