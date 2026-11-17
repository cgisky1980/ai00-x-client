/**
 * 模型组合（Agent Model Profile）——按阶段分配模型。
 *
 * 为什么需要：单一「主模型」无法表达「强云规划 + 本地执行 + 低价云评审 +
 * 强云兜底」。组合把五个阶段各绑一个模型引用，既支持本地/云端混合，
 * 也支持同一云端的高低价格模型混合。
 *
 * 阶段 → 真实落点（不是提示词口号）：
 * - plan     编排者主会话模型（dshSession.selectModel）
 * - execute  local_code_worker.md 的 model
 * - review   review_worker.md 的 model（只读证据评审工人）
 * - fallback code_worker.md 的 model（云端兜底）
 * - research research_worker.md 的 model
 *
 * 持久化：localStorage（纯 UI 偏好，与 discussModel 同口径）。组合只影响
 * 之后新建的会话与工人；已建立的会话不被静默改写。
 */

import { invoke } from '@tauri-apps/api/core';
import { dshEngine, dshSession, dshWorkers } from '@/infrastructure/api/service-api/DshAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { fetchAi00sModels } from '@/infrastructure/config/services/ai00sTier';
import type { AIModelConfig } from '@/infrastructure/config/types';

export type AgentStage = 'plan' | 'execute' | 'review' | 'fallback' | 'research';

export const AGENT_STAGES: AgentStage[] = ['plan', 'execute', 'review', 'fallback', 'research'];

export const AGENT_STAGE_LABELS: Record<AgentStage, string> = {
  plan: '规划 / 编排',
  execute: '执行（默认云端小模型）',
  review: '子任务评审',
  fallback: '失败兜底',
  research: '调研 / 查证',
};

export const AGENT_STAGE_HINTS: Record<AgentStage, string> = {
  plan: '主会话模型：拆解任务、写计划书、做集成终审与高风险判断',
  execute: 'local_code_worker：真实写码改文件跑命令；默认云端（服务器默认模型 / 智能路由），选「本地优先（RWKV）」才走本地',
  review: 'review_worker：读证据与 diff 判定通过 / 打回（严格模式与高风险必经）',
  fallback: 'code_worker：本地两次失败或需要云端直接修正时接手',
  research: 'research_worker：只读调查，可走本地或低价云',
};

export interface AgentModelProfile {
  id: string;
  name: string;
  models: Record<AgentStage, string>;
  /** 内置组合不可删除，但可另存为新组合。 */
  builtin?: boolean;
}

const PROFILES_KEY = 'ai00x.agent.modelProfiles.v1';
const ACTIVE_KEY = 'ai00x.agent.activeProfile.v1';

export const MODEL_REMOTE = 'ai00-api';
export const MODEL_RWKV = 'rwkv-local';
export const MODEL_AUTO = 'ai00-auto';
/**
 * 内置组合里的云端落点一律交给服务器决定（2026-11-17 起不再在客户端钉模型 id）：
 * - `ai00-api`：网关主模型槽，跟随服务端 `/ai00-s/api/ai/models` 里 `is_default`
 *   标注的默认模型（选择器自动绑定），换模型/下架模型只改服务器；
 * - `ai00-auto`：智能路由，按任务复杂度在已绑定模型间选档。
 */

/** 内置组合：覆盖本地/云端混合与云端高低价混合。 */
export const BUILTIN_PROFILES: AgentModelProfile[] = [
  {
    id: 'balanced',
    name: '均衡混合',
    builtin: true,
    // 执行走智能路由：本地 RWKV 3B 实测写不出合格文件（乱码），
    // 只会在证据门被判 needs-review 后多绕一轮云审。
    models: {
      plan: MODEL_REMOTE,
      execute: MODEL_AUTO,
      review: MODEL_REMOTE,
      fallback: MODEL_REMOTE,
      research: MODEL_AUTO,
    },
  },
  {
    id: 'local-first',
    name: '本地优先（RWKV）',
    builtin: true,
    models: {
      plan: MODEL_REMOTE,
      execute: MODEL_RWKV,
      review: MODEL_REMOTE,
      fallback: MODEL_REMOTE,
      research: MODEL_AUTO,
    },
  },
  {
    id: 'quality',
    name: '质量优先',
    builtin: true,
    models: {
      plan: MODEL_REMOTE,
      execute: MODEL_REMOTE,
      review: MODEL_REMOTE,
      fallback: MODEL_REMOTE,
      research: MODEL_AUTO,
    },
  },
];

function readProfiles(): AgentModelProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProfileLike).map(normalizeProfile);
  } catch {
    return [];
  }
}

function isProfileLike(value: unknown): value is AgentModelProfile {
  return Boolean(value) && typeof value === 'object' && typeof (value as AgentModelProfile).id === 'string';
}

function normalizeProfile(profile: AgentModelProfile): AgentModelProfile {
  const models = {} as Record<AgentStage, string>;
  for (const stage of AGENT_STAGES) {
    const raw = profile.models?.[stage];
    models[stage] = typeof raw === 'string' && raw.trim() ? raw.trim() : MODEL_AUTO;
  }
  return {
    id: profile.id,
    name: profile.name?.trim() || profile.id,
    models,
    ...(profile.builtin ? { builtin: true } : {}),
  };
}

/** 全部组合：内置 + 用户自定义（同 id 时用户版本优先）。 */
export function listProfiles(): AgentModelProfile[] {
  const custom = readProfiles();
  const customIds = new Set(custom.map(p => p.id));
  return [...BUILTIN_PROFILES.filter(p => !customIds.has(p.id)), ...custom];
}

export function getProfile(id: string | null | undefined): AgentModelProfile | null {
  if (!id) return null;
  return listProfiles().find(p => p.id === id) ?? null;
}

/** 保存（新增或覆盖）一个自定义组合。 */
export function saveProfile(profile: AgentModelProfile): AgentModelProfile {
  const normalized = normalizeProfile({ ...profile, id: profile.id || genProfileId() });
  const next = readProfiles().filter(p => p.id !== normalized.id);
  next.push(normalized);
  localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
  return normalized;
}

/** 删除自定义组合；内置组合不可删除。 */
export function deleteProfile(id: string): void {
  if (BUILTIN_PROFILES.some(p => p.id === id)) return;
  const next = readProfiles().filter(p => p.id !== id);
  localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
  if (getActiveProfileId() === id) setActiveProfileId(null);
}

export function getActiveProfileId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function setActiveProfileId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // 隐私模式等：仅本次会话内生效
  }
}

/** 当前生效组合；没有则回落到「均衡混合」。 */
export function getActiveProfile(): AgentModelProfile {
  return getProfile(getActiveProfileId()) ?? BUILTIN_PROFILES[0];
}

function genProfileId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 引擎只接受这些模型引用（会话 model 切换的安全集合）。 */
export function isEngineModelRef(ref: string): boolean {
  return (
    ref === MODEL_REMOTE ||
    ref === MODEL_RWKV ||
    ref === MODEL_AUTO ||
    ref.startsWith('ai00s:') ||
    ref.startsWith('gguf-local:')
  );
}

export interface AgentModelOption {
  value: string;
  label: string;
  group: '本地' | 'Ai00-API' | '自动' | '自定义';
  /** 积分倍率（Ai00-API 模型返回时展示，便于挑低价云）。 */
  multiplier?: number;
}

/** 弹窗里的模型候选：本地 + 自动 + Ai00-API 子模型 + 用户自定义 API。 */
export async function loadAgentModelOptions(): Promise<AgentModelOption[]> {
  const options: AgentModelOption[] = [
    { value: MODEL_RWKV, label: '本地 RWKV', group: '本地' },
    { value: MODEL_AUTO, label: '自动路由（本地优先，失败升级）', group: '自动' },
    { value: MODEL_REMOTE, label: 'Ai00-API 主模型', group: 'Ai00-API' },
  ];

  try {
    const remote = await fetchAi00sModels();
    for (const model of remote) {
      options.push({
        value: `ai00s:${model.id}`,
        label: model.displayName || model.id,
        group: 'Ai00-API',
        ...(typeof model.multiplier === 'number' ? { multiplier: model.multiplier } : {}),
      });
    }
  } catch {
    // 未登录 / 离线：保留主模型入口即可
  }

  try {
    const models = (await configManager.getConfig<AIModelConfig[]>('ai.models')) ?? [];
    for (const model of models) {
      if (!model.enabled || !model.id) continue;
      const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
      if (!capabilities.includes('text_chat')) continue;
      if (options.some(o => o.value === model.id)) continue;
      options.push({ value: model.id, label: model.name || model.model_name || model.id, group: '自定义' });
    }
  } catch {
    // 配置暂不可用：不影响其它候选
  }

  return options;
}

export interface ApplyProfileResult {
  /** 工人模型是否改动（改动后需引擎重启才装载新 preset）。 */
  workersChanged: boolean;
  /** 有会话正在跑，未自动重启引擎。 */
  restartRequired: boolean;
  /** 主会话模型是否已切换。 */
  sessionSwitched: boolean;
}

/**
 * 应用组合：
 * 1. Rust 侧改写四个工人 md 的 model（缺文件先按默认播种）并重建编排 patch；
 * 2. 把 plan 模型切到当前会话；
 * 3. 工人模型有改动且引擎空闲时自动重启以装载新 preset；有会话在跑则只提示。
 */
export async function applyModelProfile(
  profile: AgentModelProfile,
  options: { sessionId?: string | null } = {},
): Promise<ApplyProfileResult> {
  setActiveProfileId(profile.id);

  let workersChanged = false;
  try {
    workersChanged = await invoke<boolean>('dsh_workers_apply_models', {
      execute: profile.models.execute,
      review: profile.models.review,
      fallback: profile.models.fallback,
      research: profile.models.research,
    });
  } catch {
    // Rust 侧不可用（旧版本/独立宿主）：保留组合偏好，不阻断主会话切换
  }

  let sessionSwitched = false;
  if (options.sessionId && isEngineModelRef(profile.models.plan)) {
    try {
      await dshSession.selectModel(options.sessionId, 'ai00-x', profile.models.plan);
      sessionSwitched = true;
    } catch {
      // 会话已结束 / 引擎不可达：不阻断组合保存
    }
  }

  if (!workersChanged) {
    return { workersChanged, restartRequired: false, sessionSwitched };
  }

  // 引擎在跑才需要重启；有会话运行中时不打断，交由用户稍后重启
  try {
    const status = await dshEngine.status();
    if (status.phase.phase !== 'running') {
      return { workersChanged, restartRequired: false, sessionSwitched };
    }
    const { items } = await dshSession.list();
    if (items.some(item => item.running)) {
      return { workersChanged, restartRequired: true, sessionSwitched };
    }
    await dshEngine.restart();
    return { workersChanged, restartRequired: false, sessionSwitched };
  } catch {
    return { workersChanged, restartRequired: true, sessionSwitched };
  }
}

/** 供设置页/调试使用：读取工人当前模型，确认组合是否已装载。 */
export async function readWorkerModels(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const worker of await dshWorkers.list()) {
    result[worker.name] = worker.model;
  }
  return result;
}

/** 本地模型目录是否就绪（用于组合里提示本地执行是否真能用）。 */
export async function isLocalModelReady(): Promise<boolean> {
  try {
    const catalog = await invoke<Array<{ key: string; downloaded: boolean }>>('rwkv_builtin_catalog');
    return catalog.some(entry => entry.key === 'rwkv-3b' && entry.downloaded);
  } catch {
    return false;
  }
}
