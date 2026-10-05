/**
 * 应用窗口注册表（唯一来源）
 *
 * 由 `scripts/generate-app-windows.cjs` 从 `packages/shared/app-windows.json` 自动生成。
 * 禁止手动修改本文件；新增/调整窗口请编辑 JSON 源文件后运行
 * `pnpm run generate-app-windows`。
 * Rust 侧对应 `src/apps/desktop/src/window_registry.rs`。
 *
 * 窗口的真实属性（尺寸 / URL / decorations / 是否置顶）以 Rust 侧注册表为准，
 * 本表只用于前端类型约束与展示信息（如标题）。
 */

export type AppWindowId = 'community' | 'music' | 'tasks'

export interface AppWindowDef {
  id: AppWindowId
  /** Tauri 窗口 label */
  label: string
  /** 原生标题栏标题 */
  title: string
  /** `dist/main` 下的页面名 */
  page: string
  width: number
  height: number
}

export const APP_WINDOW_REGISTRY: Record<AppWindowId, AppWindowDef> = {
  'community': {
    id: 'community',
    label: 'community',
    title: '社区',
    page: 'community',
    width: 1100,
    height: 720,
  },
  'music': {
    id: 'music',
    label: 'music',
    title: '乐',
    page: 'music',
    width: 1000,
    height: 680,
  },
  'tasks': {
    id: 'tasks',
    label: 'tasks',
    title: '策',
    page: 'tasks',
    width: 900,
    height: 640,
  },
}

export const APP_WINDOW_IDS: readonly AppWindowId[] = ['community', 'music', 'tasks']
