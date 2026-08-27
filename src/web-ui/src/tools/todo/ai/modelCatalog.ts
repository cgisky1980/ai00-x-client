/**
 * modelCatalog — 策·讨论的轻量模型目录（标准 ModelSelector 数据源）。
 *
 * 通道：plugin_ai_complete 已支持 model 引用（'primary'/'fast'/'rwkv-local'/
 * 自定义 id）；不传 = 自动（本地 RWKV 优先，失败回退主模型——保持既有语义）。
 * 目录拼装：内置引用（自动/本地 RWKV/主模型/fast）+ 启用的自定义文本模型
 * （ai.models，过滤 ai00s 供应商——付费目录是 flow_chat ModelSelector 的职责）。
 * 选择持久化：localStorage（UI 偏好，不动 ai.func_agent_models.plugin——
 * 那是设置页管理的共享 slot，写入会互相踩）。
 */
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type {
  AIModelConfig,
  DefaultModelsConfig,
} from '@/infrastructure/config/types';
import type { ModelGroup } from '@/component-library';

const STORAGE_KEY = 'ai00x.todo.discussModel';

/** 「自动」引用 id（不传 model——本地 RWKV 优先 + primary 自动回退）。 */
export const MODEL_AUTO = 'auto';

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

/** 主模型引用的展示名（default_models.primary 对应的模型名）。 */
function resolvePrimaryLabel(models: AIModelConfig[], ref: string | null | undefined): string | null {
  if (!ref) return null;
  const hit = models.find(
    m => m.id === ref || m.name === ref || m.model_name === ref,
  );
  return hit ? hit.name : null;
}

/** 拉取讨论用模型目录（分组：内置引用 + 自定义模型）。 */
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

  const groups: ModelGroup[] = [{ id: 'builtin', name: '内置', models: builtin }];
  if (custom.length) groups.push({ id: 'custom', name: '自定义', models: custom });
  return groups;
}
