// Window API — 标准应用窗口的统一开窗通路
//
// 窗口属性（URL / 尺寸 / decorations / 是否置顶 / 是否进任务栏）由 Rust 侧注册表
// 锁死（`src/apps/desktop/src/window_registry.rs`，源自
// `packages/shared/app-windows.json`）。前端只能按 AppWindowId 请求开窗，
// 无法自定义窗口属性——这是刻意的，避免任意字符串建窗带来的注入面。
//
// 覆盖范围仅「标准应用窗口」。overlay / underlays / loader / preview 这类特殊窗口
// 各有独立通路，不走这里。
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { APP_WINDOW_REGISTRY, type AppWindowDef, type AppWindowId } from './windowRegistry';

export const WindowAPI = {
  /** 打开窗口；已打开则取消最小化并聚焦复用（不重复建窗） */
  open: (id: AppWindowId) => tauriInvoke<void>('open_app_window', { id }),

  /** 关闭窗口（未打开则静默成功） */
  close: (id: AppWindowId) => tauriInvoke<void>('close_app_window', { id }),

  /** 聚焦窗口（未打开则静默成功；需要「没有就开」请用 open） */
  focus: (id: AppWindowId) => tauriInvoke<void>('focus_app_window', { id }),

  /** 窗口是否已打开 */
  isOpen: (id: AppWindowId) => tauriInvoke<boolean>('is_app_window_open', { id }),

  /** 注册表里的展示信息（标题等）。窗口真实属性以 Rust 侧为准 */
  def: (id: AppWindowId): AppWindowDef => APP_WINDOW_REGISTRY[id],
};

export type { AppWindowDef, AppWindowId };
