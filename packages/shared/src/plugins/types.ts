/**
 * Desktop plugin system shared types.
 *
 * Manifest schema and hook registry are documented in
 * `client/参考/插件系统设计`（Hook 权威清单）.
 */

/**
 * Hook entry configuration. The carrying form is decided by the hook id
 * (host-defined authoritative list), NOT by the manifest — plugins only
 * provide the matching entry field. Legacy manifests with an explicit
 * `kind` field still parse (the field is ignored).
 */
export type HookConfig = IframeHookConfig | ModuleHookConfig

/** Sandboxed iframe hook entry (HTML path inside the plugin package). */
export interface IframeHookConfig {
  /** Entry HTML path relative to the plugin package root. */
  path: string
  /** Suggested grid width in cells (underlay:widget only). */
  width?: number
  /** Suggested grid height in cells (underlay:widget only). */
  height?: number
  /** Whether the widget can be resized (underlay:widget only). */
  resizable?: boolean
}

/** Injected ESM module hook entry. */
export interface ModuleHookConfig {
  /** Module path relative to the plugin package root. */
  module: string
}

/** Type guard: hook config carries a module entry. */
export function isModuleHook(cfg: HookConfig | undefined): cfg is ModuleHookConfig {
  return typeof (cfg as ModuleHookConfig | undefined)?.module === 'string'
}

/** Type guard: hook config carries an iframe entry. */
export function isIframeHook(cfg: HookConfig | undefined): cfg is IframeHookConfig {
  return typeof (cfg as IframeHookConfig | undefined)?.path === 'string'
}

/** Plugin manifest (`manifest.json` at package root). */
export interface PluginManifest {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  icon?: string
  minAi00xVersion?: string
  homepage?: string
  repository?: string
  /** Hook id -> hook config. */
  hooks: Record<string, HookConfig>
}

/** Plugin info returned by the `get_plugins` command. */
export interface PluginInfo {
  manifest: PluginManifest
  enabled: boolean
  /** Install timestamp (ms). Used as module cache-busting version. */
  installedAt: number
}

/** Payload of the `plugins-changed` event. */
export interface PluginsChangedEvent {
  action: 'installed' | 'uninstalled' | 'enabled' | 'disabled'
  pluginId: string
}

/** Window-intra plugin event bus (provided via PluginContext). */
export interface PluginBus {
  on(event: string, cb: (data?: unknown) => void): () => void
  emit(event: string, data?: unknown): void
}

/**
 * Unified per-plugin data storage, persisted at
 * `{dataDir}/Ai00-X/plugins-data/{pluginId}/{key}.json`.
 * Shared by both carrying forms (module via ctx.storage, iframe via the
 * PluginWidget postMessage protocol). Uninstalling keeps the data.
 */
export interface PluginStorage {
  /** Read a value; resolves null when the key does not exist. */
  get(key: string): Promise<unknown>
  /** Write any JSON-serializable value. */
  set(key: string, value: unknown): Promise<void>
  /** Remove a key (missing key is a no-op). */
  remove(key: string): Promise<void>
  /** List all keys of this plugin. */
  keys(): Promise<string[]>
  /** Clear all stored data of this plugin. */
  clear(): Promise<void>
}

/** Host context passed to injected plugin modules. */
export interface PluginContext {
  pluginId: string
  /** The hook this module instance is mounted on. */
  hook: string
  bus: PluginBus
  /** Mount plugin DOM into the hook's container element. */
  mount(el: HTMLElement): void
  /** Passthrough of Tauri invoke (full-trust model). */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  /** Unified plugin data storage (scope fixed to this plugin). */
  storage: PluginStorage
  theme: { mode: string }
}

/** Module interface injected plugins must export. */
export interface PluginModule {
  activate(ctx: PluginContext): void | (() => void)
  deactivate?(): void
}
