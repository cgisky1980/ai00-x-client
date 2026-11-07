/**
 * Workbench registry (frontend side).
 *
 * A workbench is a plugin that declares `manifest.workbench` plus a module
 * `scene:page` hook — it owns a full scene page reachable from the left nav.
 * The Rust side validates the declaration on install; this module only
 * derives the list and keeps it in sync with the `plugins-changed` event.
 *
 * See `client/参考/2026-11-06-工作台体系计划.md`.
 */

import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isModuleHook, type PluginInfo } from "@ai00-x/shared";

const SCENE_HOOK_ID = "scene:page";
const SCENE_PREFIX = "workbench:";

export interface WorkbenchEntry {
  /** Workbench id from the manifest (`workbench.id`). */
  id: string;
  /** Owning plugin id. */
  pluginId: string;
  /** Display title for the left nav. */
  title: string;
  /** Plugin description (home card summary). */
  description?: string;
  /** Plugin version (home card meta). */
  version: string;
  /** Plugin author (home card meta; falls back to pluginId). */
  author?: string;
  /** Icon path inside the plugin package (served by the embedded server). */
  icon?: string;
  /** Reserved data dir name (defaults to `id`). */
  dataDir: string;
  /** Declared agent tool names (declaration only). */
  agentTools: string[];
  bindsSession: boolean;
  /** 这一类工作台自己的 agent.md（宿主写入工作台总目录 `AGENTS.md`）。 */
  agentInstructions?: string;
  /** 空会话示例任务（最多 3 条；点击只填入输入框）。 */
  starterPrompts?: string[];
  /** Module entry of the `scene:page` hook (relative to the package). */
  modulePath: string;
  /** Install timestamp, used as the module cache-busting version. */
  installedAt: number;
}

export function workbenchSceneId(workbenchId: string): string {
  return `${SCENE_PREFIX}${workbenchId}`;
}

/** Extract the workbench id from a `workbench:{id}` scene id. */
export function parseWorkbenchSceneId(sceneId: string): string | null {
  return sceneId.startsWith(SCENE_PREFIX)
    ? sceneId.slice(SCENE_PREFIX.length)
    : null;
}

function toEntry(plugin: PluginInfo): WorkbenchEntry | null {
  const wb = plugin.manifest.workbench;
  if (!wb || !wb.id || !wb.title) return null;
  const hook = plugin.manifest.hooks?.[SCENE_HOOK_ID];
  if (!isModuleHook(hook)) return null;
  return {
    id: wb.id,
    pluginId: plugin.manifest.id,
    title: wb.title,
    description: plugin.manifest.description,
    version: plugin.manifest.version,
    author: plugin.manifest.author,
    icon: plugin.manifest.icon,
    dataDir: wb.dataDir ?? wb.id,
    agentTools: wb.agentTools ?? [],
    bindsSession: wb.bindsSession ?? false,
    agentInstructions: wb.agentInstructions,
    starterPrompts: (wb.starterPrompts ?? []).filter(p => typeof p === 'string' && p.trim()).slice(0, 3),
    modulePath: hook.module,
    installedAt: plugin.installedAt,
  };
}

let entries: WorkbenchEntry[] = [];
const subscribers = new Set<() => void>();
let initPromise: Promise<void> | null = null;

function setEntries(next: WorkbenchEntry[]): void {
  entries = next;
  subscribers.forEach((fn) => fn());
}

async function refresh(): Promise<void> {
  const plugins = await invoke<PluginInfo[]>("get_plugins");
  const next: WorkbenchEntry[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const entry = toEntry(plugin);
    if (entry) next.push(entry);
  }
  next.sort((a, b) => a.title.localeCompare(b.title));
  setEntries(next);
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Idempotent: loads once and subscribes to `plugins-changed`. */
export function initWorkbenchRegistry(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        await refresh();
      } catch {
        // Plugin system unavailable (e.g. web-only build) — keep empty.
        setEntries([]);
      }
      void listen("plugins-changed", () => {
        void refresh().catch(() => {});
      });
    })();
  }
  return initPromise;
}

/** Enabled workbenches, kept in sync with install/uninstall/enable/disable. */
export function useWorkbenches(): WorkbenchEntry[] {
  useEffect(() => {
    void initWorkbenchRegistry();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => entries,
    () => entries,
  );
}

/** Look up a workbench by id (returns undefined until the registry loads). */
export function useWorkbench(workbenchId: string | null): WorkbenchEntry | undefined {
  const all = useWorkbenches();
  return workbenchId ? all.find((w) => w.id === workbenchId) : undefined;
}

/** Synchronous lookup against the last loaded snapshot (for scene labels). */
export function getWorkbenchById(workbenchId: string): WorkbenchEntry | undefined {
  return entries.find((w) => w.id === workbenchId);
}
