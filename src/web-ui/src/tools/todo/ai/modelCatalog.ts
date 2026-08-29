/**
 * modelCatalog — 策·讨论的轻量模型目录（标准 ModelSelector 数据源）。
 *
 * 通道：plugin_ai_complete 已支持 model 引用（'primary'/'fast'/'rwkv-local'/
 * 'rwkv-local:<模型路径>'/'gguf-local:<GGUF 路径>'/自定义 id）；
 * 不传 = 自动（本地 RWKV 优先，失败回退主模型——保持既有语义）。
 * 目录拼装：内置引用（自动/本地 RWKV/主模型/fast）+ 扫描到的本地 RWKV 模型
 * （models/rwkv 子目录/平铺）+ 本地 GGUF 模型（models/llm、unsloth/HF 缓存、
 * 手动注册目录）+ 启用的自定义文本模型（ai.models，过滤 ai00s 供应商）。
 * 选择持久化：localStorage（UI 偏好，不动 ai.func_agent_models.plugin——
 * 那是设置页管理的共享 slot，写入会互相踩）。
 */
import { invoke } from '@tauri-apps/api/core';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type {
  AIModelConfig,
  DefaultModelsConfig,
} from '@/infrastructure/config/types';
import type { ModelGroup } from '@/component-library';

const STORAGE_KEY = 'ai00x.todo.discussModel';

/** 「自动」引用 id（不传 model——本地 RWKV 优先 + primary 自动回退）。 */
export const MODEL_AUTO = 'auto';

/** 扫描到的本地 RWKV 模型信息（list_rwkv_models 返回结构）。 */
interface RwkvModelInfo {
  id: string;
  model_path: string;
  vocab_path: string;
  size_bytes: number;
  int8: boolean;
  source: string;
}

/** 扫描到的本地 GGUF 模型信息（list_gguf_models 返回结构）。 */
interface GgufModelInfo {
  id: string;
  gguf_path: string;
  size_bytes: number;
  architecture: string;
  context_length: number;
  source: string;
}

/** 读取持久化的选择；缺省 'auto'。 */
export function getDiscussModel(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || MODEL_AUTO;
  } catch {
    return MODEL_AUTO;
  }
}

/** 持久化选择。 */
export function setDiscussModel(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage 不可用（隐私模式等）——仅会话内生效
  }
}

/** 体积人读格式（GB，1 位小数）。 */
function formatSize(bytes: number): string {
  if (!bytes) return '';
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

/** 主模型引用的展示名（default_models.primary 对应的模型名）。 */
function resolvePrimaryLabel(models: AIModelConfig[], ref: string | null | undefined): string | null {
  if (!ref) return null;
  const hit = models.find(
    m => m.id === ref || m.name === ref || m.model_name === ref,
  );
  return hit ? hit.name : null;
}

/** 扫描本地 RWKV 模型（失败静默返回空——非致命增强项）。 */
async function scanRwkvModels(): Promise<RwkvModelInfo[]> {
  try {
    return await invoke<RwkvModelInfo[]>('list_rwkv_models');
  } catch {
    return [];
  }
}

/** 扫描本地 GGUF 模型（含 unsloth/HF 缓存目录兼容）。 */
async function scanGgufModels(): Promise<GgufModelInfo[]> {
  try {
    return await invoke<GgufModelInfo[]>('list_gguf_models');
  } catch {
    return [];
  }
}

const SOURCE_LABEL: Record<string, string> = {
  bundled: '已下载',
  'hf-cache': 'HF 缓存',
  unsloth: 'Unsloth',
  custom: '自定义',
};

/** 拉取讨论用模型目录（分组：内置 + 本地 RWKV + 本地 GGUF + 自定义）。 */
export async function fetchDiscussModelGroups(): Promise<ModelGroup[]> {
  const [models, defaults] = await Promise.all([
    configManager.getConfig<AIModelConfig[]>('ai.models'),
    configManager.getConfig<DefaultModelsConfig>('ai.default_models'),
  ]);
  const list = Array.isArray(models) ? models : [];

  const builtin = [{ id: MODEL_AUTO, name: '自动 · 本地优先' }, { id: 'rwkv-local', name: '本地 RWKV' }];
  const primaryLabel = resolvePrimaryLabel(list, defaults?.primary);
  builtin.push({ id: 'primary', name: primaryLabel ? `主模型 · ${primaryLabel}` : '主模型' });
  if (defaults?.fast) {
    const fastLabel = resolvePrimaryLabel(list, defaults.fast);
    builtin.push({ id: 'fast', name: fastLabel ? `快速 · ${fastLabel}` : '快速模型' });
  }

  const custom = list
    .filter(m => m.enabled && m.capabilities?.includes('text_chat') && m.provider !== 'ai00s')
    .map(m => ({ id: m.id ?? m.name, name: m.name, description: m.model_name }));

  const [rwkv, gguf] = await Promise.all([scanRwkvModels(), scanGgufModels()]);

  const groups: ModelGroup[] = [{ id: 'builtin', name: '内置', models: builtin }];

  // 本地 RWKV 模型（>1 个才展开分组；单模型时「本地 RWKV」内置项已覆盖）
  const rwkvModels = rwkv.map(m => ({
    id: `rwkv-local:${m.model_path}`,
    name: m.id,
    description: [formatSize(m.size_bytes), m.int8 ? 'int8' : 'fp16'].filter(Boolean).join(' · '),
    badge: 'RWKV',
  }));
  if (rwkvModels.length > 1) {
    groups.push({ id: 'rwkv', name: '本地 RWKV', models: rwkvModels });
  }

  // 本地 GGUF 模型（unsloth/HF 缓存/自定义目录扫描结果）
  if (gguf.length) {
    groups.push({
      id: 'gguf',
      name: '本地 GGUF',
      models: gguf.map(m => ({
        id: `gguf-local:${m.gguf_path}`,
        name: m.id,
        description: [
          formatSize(m.size_bytes),
          m.architecture !== 'unknown' ? m.architecture : '',
        ].filter(Boolean).join(' · '),
        badge: SOURCE_LABEL[m.source] ?? m.source,
      })),
    });
  }

  if (custom.length) groups.push({ id: 'custom', name: '自定义', models: custom });
  return groups;
}
