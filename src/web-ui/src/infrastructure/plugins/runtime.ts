/**
 * Overlay plugin runtime (injected / ESM form).
 *
 * Loads enabled plugins that declare `module` hooks for the overlay layer
 * (`overlay:mount` on the full-screen plugin layer, `overlay:island` inside
 * the DynamicIsland extension slot), dynamically imports their ESM entry
 * (versioned URL to bust module cache after reinstall) and calls
 * `activate(ctx)`. Reacts to the `plugins-changed` event for hot-plug
 * (install/uninstall/enable/disable take effect live).
 *
 * After the initial load completes, an `app:startup` event is emitted on the
 * plugin bus (P0 lifecycle hook).
 *
 * Plugin DOM that marks itself `.no-penetrate` automatically gains mouse
 * capture via the overlay mouse-through mechanism.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  EMBEDDED_SERVER_PORT,
  isModuleHook,
  type PluginContext,
  type PluginInfo,
  type PluginStorage,
  type PluginsChangedEvent,
} from "@ai00-x/shared";

/** Hooks served by this runtime: hook id -> container selector. */
const HOOK_CONTAINERS: Record<string, string> = {
  "overlay:mount": "#ai00-plugin-layer",
  "overlay:island": "#ai00-island-slot",
};

interface ActivePlugin {
  pluginId: string;
  hook: string;
  installedAt: number;
  cleanup: (() => void) | null;
  container: HTMLElement;
}

/** key: `${pluginId}::${hookId}` */
const active = new Map<string, ActivePlugin>();

// ---------------------------------------------------------------------------
// Shared window-level plugin event bus
// ---------------------------------------------------------------------------

type BusListener = (data?: unknown) => void;
const busListeners = new Map<string, Set<BusListener>>();

function onBusEvent(event: string, cb: BusListener): () => void {
  let set = busListeners.get(event);
  if (!set) {
    set = new Set();
    busListeners.set(event, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

function emitBusEvent(event: string, data?: unknown): void {
  busListeners.get(event)?.forEach((cb) => {
    try {
      cb(data);
    } catch (e) {
      console.error(`[plugin-runtime] bus listener error on '${event}':`, e);
    }
  });
}

/**
 * Host-side access to the shared plugin bus (e.g. the workbench scene
 * exchanging `workbench:active-project` / `workbench:project-written` with
 * the mounted plugin page). Plugins use `ctx.bus`; host code uses these.
 */
export { onBusEvent, emitBusEvent };

// ---------------------------------------------------------------------------
// Load / unload
// ---------------------------------------------------------------------------

function themeMode(): string {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Build the unified storage facade scoped to a plugin id. */
function makePluginStorage(pluginId: string): PluginStorage {
  return {
    get: async (key) =>
      await invoke<unknown>("plugin_data_get", { pluginId, key }),
    set: async (key, value) => {
      await invoke("plugin_data_set", { pluginId, key, value });
    },
    remove: async (key) => {
      await invoke("plugin_data_remove", { pluginId, key });
    },
    keys: async () => await invoke<string[]>("plugin_data_keys", { pluginId }),
    clear: async () => {
      await invoke("plugin_data_clear", { pluginId });
    },
  };
}

/** Build the plugin context handed to `activate(ctx)`. */
function createPluginContext(
  pluginId: string,
  hookId: string,
  container: HTMLElement,
): PluginContext {
  return {
    pluginId,
    hook: hookId,
    bus: { on: onBusEvent, emit: emitBusEvent },
    mount: (el: HTMLElement) => {
      container.appendChild(el);
    },
    invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
    storage: makePluginStorage(pluginId),
    theme: { mode: themeMode() },
  };
}

/** URL of a plugin module entry (versioned to bust the module cache). */
function pluginModuleUrl(
  pluginId: string,
  modulePath: string,
  installedAt: number,
): string {
  return `http://127.0.0.1:${EMBEDDED_SERVER_PORT}/plugins/${pluginId}/${modulePath.replace(/^\/+/, "")}?v=${installedAt}`;
}

async function loadHookModule(
  plugin: PluginInfo,
  hookId: string,
  modulePath: string,
): Promise<void> {
  const key = `${plugin.manifest.id}::${hookId}`;
  if (active.has(key)) return;

  const layerEl = document.querySelector<HTMLElement>(HOOK_CONTAINERS[hookId]);
  if (!layerEl) return; // hook container not present in this window

  const container = document.createElement("div");
  container.dataset.pluginId = plugin.manifest.id;
  container.dataset.hook = hookId;
  container.className = "ai00-plugin-container";
  layerEl.appendChild(container);

  const ctx: PluginContext = createPluginContext(
    plugin.manifest.id,
    hookId,
    container,
  );

  const url = pluginModuleUrl(
    plugin.manifest.id,
    modulePath,
    plugin.installedAt,
  );

  try {
    const mod = (await import(/* @vite-ignore */ url)) as {
      activate?: unknown;
      deactivate?: unknown;
      default?: { activate?: unknown; deactivate?: unknown };
    };
    const impl =
      typeof mod.activate === "function"
        ? mod
        : typeof mod.default?.activate === "function"
          ? mod.default
          : null;
    if (!impl) {
      throw new Error("module does not export activate(ctx)");
    }

    const activate = impl.activate as (ctx: PluginContext) => unknown;
    const cleanupOrVoid = activate(ctx);
    const deactivate = impl.deactivate as (() => void) | undefined;
    const cleanup: (() => void) | null =
      typeof cleanupOrVoid === "function"
        ? (cleanupOrVoid as () => void)
        : typeof deactivate === "function"
          ? deactivate
          : null;

    active.set(key, {
      pluginId: plugin.manifest.id,
      hook: hookId,
      installedAt: plugin.installedAt,
      cleanup,
      container,
    });
    console.log(`[plugin-runtime] activated ${plugin.manifest.id} on ${hookId}`);
  } catch (e) {
    console.error(`[plugin-runtime] failed to activate plugin '${plugin.manifest.id}' on ${hookId}:`, e);
    container.remove();
  }
}

function unloadHookModule(key: string): void {
  const entry = active.get(key);
  if (!entry) return;
  active.delete(key);
  try {
    entry.cleanup?.();
  } catch (e) {
    console.error(`[plugin-runtime] cleanup error for '${key}':`, e);
  }
  entry.container.remove();
  console.log(`[plugin-runtime] deactivated ${key}`);
}

/** Handle for a mounted `scene:page`; `dispose()` unmounts the page. */
export interface ScenePageHandle {
  dispose: () => void;
  /** True when the module failed to load or export `activate`. */
  failed: boolean;
}

/**
 * Mount a plugin's `scene:page` hook into a host element owned by React.
 *
 * Overlay hooks discover their container from the DOM (`HOOK_CONTAINERS`);
 * scene pages cannot — the workbench scene decides when to mount, so the
 * caller passes the host element in. Everything else (context shape, module
 * URL cache-busting, activate/deactivate contract) is shared with overlay
 * hooks, so plugins use exactly one protocol.
 */
export async function mountScenePage(
  pluginId: string,
  modulePath: string,
  installedAt: number,
  host: HTMLElement,
): Promise<ScenePageHandle> {
  const container = document.createElement("div");
  container.dataset.pluginId = pluginId;
  container.dataset.hook = "scene:page";
  container.className = "ai00-plugin-container";
  host.appendChild(container);

  const dispose = (cleanup: (() => void) | null) => {
    try {
      cleanup?.();
    } catch (e) {
      console.error(`[plugin-runtime] cleanup error for '${pluginId}::scene:page':`, e);
    }
    container.remove();
  };

  try {
    const url = pluginModuleUrl(pluginId, modulePath, installedAt);
    const mod = (await import(/* @vite-ignore */ url)) as {
      activate?: unknown;
      deactivate?: unknown;
      default?: { activate?: unknown; deactivate?: unknown };
    };
    const impl =
      typeof mod.activate === "function"
        ? mod
        : typeof mod.default?.activate === "function"
          ? mod.default
          : null;
    if (!impl) {
      throw new Error("module does not export activate(ctx)");
    }
    const ctx = createPluginContext(pluginId, "scene:page", container);
    const result = (impl.activate as (c: PluginContext) => unknown)(ctx);
    const deactivate = impl.deactivate as (() => void) | undefined;
    const cleanup: (() => void) | null =
      typeof result === "function"
        ? (result as () => void)
        : typeof deactivate === "function"
          ? deactivate
          : null;
    console.log(`[plugin-runtime] mounted scene page for ${pluginId}`);
    return { dispose: () => dispose(cleanup), failed: false };
  } catch (e) {
    console.error(
      `[plugin-runtime] failed to mount scene page for '${pluginId}':`,
      e,
    );
    container.remove();
    return { dispose: () => {}, failed: true };
  }
}

/** Collect the module hooks a plugin declares for this runtime. */
function pluginHookIds(plugin: PluginInfo): string[] {
  return Object.keys(HOOK_CONTAINERS).filter((hookId) =>
    isModuleHook(plugin.manifest.hooks?.[hookId]),
  );
}

// ---------------------------------------------------------------------------
// Refresh / hot-plug
// ---------------------------------------------------------------------------

let refreshChain: Promise<void> = Promise.resolve();

async function refreshAll(): Promise<void> {
  let plugins: PluginInfo[];
  try {
    plugins = await invoke<PluginInfo[]>("get_plugins");
  } catch {
    return; // plugin system unavailable in this build
  }

  const enabled = plugins.filter((p) => p.enabled);
  // Desired set: `${id}::${hook}` -> { plugin, hookId, modulePath, installedAt }
  const desired = new Map<
    string,
    { plugin: PluginInfo; hookId: string; modulePath: string }
  >();
  for (const plugin of enabled) {
    for (const hookId of pluginHookIds(plugin)) {
      const hook = plugin.manifest.hooks[hookId];
      if (isModuleHook(hook)) {
        desired.set(`${plugin.manifest.id}::${hookId}`, {
          plugin,
          hookId,
          modulePath: hook.module,
        });
      }
    }
  }

  // Unload stale entries (disabled / uninstalled / old version)
  for (const key of [...active.keys()]) {
    const entry = active.get(key);
    if (!entry) continue;
    const want = desired.get(key);
    if (!want || want.plugin.installedAt !== entry.installedAt) {
      unloadHookModule(key);
    }
  }

  // Load new entries
  for (const [key, { plugin, hookId, modulePath }] of desired) {
    if (!active.has(key)) {
      await loadHookModule(plugin, hookId, modulePath);
    }
  }
}

/**
 * Initialize the overlay plugin runtime. Discovers hook containers from the
 * DOM (see HOOK_CONTAINERS). Returns a disposer.
 */
export function initPluginRuntime(): () => void {
  // Serialize refreshes to avoid concurrent load/unload races
  refreshChain = refreshChain
    .then(() => refreshAll())
    .then(() => {
      // P0 lifecycle hook: notify plugins that startup finished
      emitBusEvent("app:startup");
    });

  let unlisten: (() => void) | null = null;
  listen<PluginsChangedEvent>("plugins-changed", () => {
    refreshChain = refreshChain.then(() => refreshAll());
  }).then((fn) => {
    unlisten = fn;
  });

  return () => {
    unlisten?.();
    for (const key of [...active.keys()]) {
      unloadHookModule(key);
    }
  };
}
