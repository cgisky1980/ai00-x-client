// Wallpaper API — frontend API wrapper
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export interface WallpaperProject {
  id: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  projectPath?: string;
}

export interface CreateProjectResult {
  project: WallpaperProject;
  servePath: string;
  projectPath: string;
}

export interface WallpaperServerInfo {
  host: string;
  port: number;
}

export interface GenerateProjectNameResult {
  name: string;
  dirName: string;
}

export interface PublishProjectResult {
  zipPath: string;
  serveUrl: string;
}

export interface CompactWallpaperContextResult {
  compacted: boolean;
  removedTurns: number;
}

export const wallpaperAPI = {
  /** Get wallpaper server info */
  getServerInfo: () =>
    tauriInvoke<WallpaperServerInfo>('get_wallpaper_server_info'),

  /** Write HTML to preview and show on desktop */
  previewWallpaper: (html: string) =>
    tauriInvoke<string>('preview_wallpaper', { request: { html } }),

  /** Save current preview as a project */
  createProject: (name: string) =>
    tauriInvoke<CreateProjectResult>('create_project', { request: { name } }),

  /** List all saved wallpaper projects */
  listProjects: () =>
    tauriInvoke<WallpaperProject[]>('list_projects'),

  /** Delete a wallpaper project */
  deleteProject: (id: string) =>
    tauriInvoke<void>('delete_project', { request: { id } }),

  /** Export a project as zip, returns file path */
  exportProjectZip: (id: string) =>
    tauriInvoke<string>('export_project_zip', { request: { id } }),

  /** Generate a project name and directory slug from a description */
  generateProjectName: (description: string) =>
    tauriInvoke<GenerateProjectNameResult>('generate_wallpaper_project_name', {
      request: { description },
    }),

  /** Create a wallpaper project in the exe's workspaces directory */
  createWorkspaceProject: (name: string, dirName?: string) =>
    tauriInvoke<CreateProjectResult>('create_workspace_wallpaper_project', {
      request: { name, dirName: dirName || '' },
    }),

  /** List wallpaper projects in the exe's workspaces directory */
  listWorkspaceProjects: () =>
    tauriInvoke<WallpaperProject[]>('list_workspace_wallpaper_projects'),

  /** Publish a workspace wallpaper project (copy to serve dir + export zip) */
  publishProject: (dirName: string) =>
    tauriInvoke<PublishProjectResult>('publish_wallpaper_project', {
      request: { dirName },
    }),

  /** Delete a workspace wallpaper project */
  deleteWorkspaceProject: (dirName: string) =>
    tauriInvoke<void>('delete_workspace_wallpaper_project', {
      request: { dirName },
    }),

  /** Apply a wallpaper project to the desktop underlay */
  applyToDesktop: (projectPath: string, options?: { mode?: string; monitorId?: number }) =>
    tauriInvoke<void>('apply_wallpaper_to_desktop', {
      request: {
        projectPath,
        mode: options?.mode ?? null,
        monitorId: options?.monitorId ?? null,
      },
    }),

  /** Compact a wallpaper session's context by removing turns before the second-to-last Write/Edit */
  compactWallpaperContext: (sessionId: string, workspacePath: string) =>
    tauriInvoke<CompactWallpaperContextResult>('compact_wallpaper_context', {
      request: { sessionId, workspacePath },
    }),

  // 壁纸预览独立窗口已于 2026-09-12 移除（留给后期壁纸 agent 重做）。
  // 原 openPreviewWindow / closePreviewWindow / focusPreviewWindow /
  // isPreviewWindowOpen 四个命令与 preview.html 入口一并删除。
};