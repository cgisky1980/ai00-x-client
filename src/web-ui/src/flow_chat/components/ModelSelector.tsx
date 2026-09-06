/**
 * Model selector component.
 * Shows the active model and allows quick switching.
 *
 * Config linkage:
 * - Auto mode: smart router classifies request complexity into R0-R3 tiers
 *   (local rwkv-local for R0/R1, fast mid-tier for R2, primary flagship for R3)
 * - Selecting a model updates the primary model config
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Cpu, ChevronDown, ChevronRight, Check, Sparkles, Lock, Rocket, Coins } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { getProviderDisplayName } from '@/infrastructure/config/services/modelConfigs';
import { getGgufModelDisplayName } from '@/infrastructure/config/services/modelClass';
import {
  isAi00sModel,
  fetchUserTier,
  setCachedTier,
  fetchAi00sModels,
  canAccessModel,
  fetchUserPlanInfo,
  setCachedUserPlan,
  isFreeTier,
  getFreeQuotaStatus,
  isModelSelectable,
  type Ai00sModelInfo,
  type UserPlanInfo,
} from '@/infrastructure/config/services/ai00sTier';
import { getEffectiveReasoningMode, isReasoningVisiblyEnabled } from '@/infrastructure/config/utils/reasoning';
import { globalEventBus } from '@/infrastructure/event-bus';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { Tooltip, Popover, PopoverTrigger, PopoverContent, Switch } from '@/component-library';
import { FlowChatStore } from '../store/FlowChatStore';
import { createLogger } from '@/shared/utils/logger';
import { UpgradeDialog } from './UpgradeDialog';
import './ModelSelector.scss';

const log = createLogger('ModelSelector');

interface ModelSelectorProps {
  currentMode: string;
  className?: string;
  sessionId?: string;
  currentTokens?: number;
  maxTokens?: number;
  /**
   * 受控模式（策窗口等局部会话复用同一控件）：
   * 传入 controlledValue 后，选中只回调 onControlledSelect（引用值域与列表一致），
   * 不写 ai.default_models / agent_models 等全局配置。
   */
  controlledValue?: string | null;
  onControlledSelect?: (ref: string) => void;
}

interface ModelInfo {
  id: string;
  configName: string;
  modelName: string;
  providerName: string;
  provider: string;
  contextWindow?: number;
  enableThinking?: boolean;
  reasoningEffort?: string;
}

const formatContextWindow = (contextWindow?: number): string | null => {
  if (!contextWindow) return null;
  return `${Math.round(contextWindow / 1000)}k`;
};

const buildModelMetaText = (model: Pick<ModelInfo, 'providerName' | 'contextWindow'>): string => {
  const parts = [model.providerName];
  const contextWindow = formatContextWindow(model.contextWindow);
  if (contextWindow) {
    parts.push(contextWindow);
  }
  return parts.join(' · ');
};

const buildResolvedModelTooltipText = (
  modelName: string | undefined,
  model: Pick<ModelInfo, 'providerName' | 'contextWindow'> | null | undefined,
  fallback: string
): string => {
  if (!model) return fallback;
  const parts = [];
  if (modelName) {
    parts.push(modelName);
  }
  const metaText = buildModelMetaText(model);
  if (metaText) {
    parts.push(metaText);
  }
  return parts.join(' · ') || fallback;
};

const buildAutoModelInfo = (
  t: (key: string) => string,
): ModelInfo => ({
  id: 'auto',
  configName: t('modelSelector.autoModel'),
  modelName: t('modelSelector.autoModel'),
  providerName: t('modelSelector.autoModelDesc'),
  provider: 'auto',
});

/// 倍率视图：格式化消耗倍率（0.77 → "0.77x"，1 → "1x"）
const formatMultiplier = (multiplier: number): string =>
  `${parseFloat(multiplier.toFixed(2))}x`;

/// 倍率视图：格式化积分余额（千分位，最多 2 位小数）
const formatCredits = (n: number): string =>
  n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/// Phase 5.1: 格式化免费模型剩余额度文本
///
/// 返回值：
/// - unlimited / unknown: '' (不显示)
/// - available: "今日剩余 N 次 / M tokens"
/// - exhausted: "今日额度已用完"
const formatFreeQuotaText = (
  model: Ai00sModelInfo,
  t: (key: string, opts?: Record<string, unknown>) => string
): string => {
  if (!model.isUpstreamFree || !model.freeQuota) return '';
  const status = getFreeQuotaStatus(model.freeQuota);
  if (status === 'unlimited' || status === 'unknown') return '';
  if (status === 'exhausted') {
    return t('modelSelector.freeQuota.exhausted');
  }
  const { remaining_count, remaining_tokens } = model.freeQuota;
  const parts: string[] = [];
  if (remaining_count !== undefined && remaining_count >= 0) {
    parts.push(t('modelSelector.freeQuota.remainingCount', { count: remaining_count }));
  }
  if (remaining_tokens !== undefined && remaining_tokens >= 0) {
    const tokensText = remaining_tokens >= 1000
      ? `${Math.round(remaining_tokens / 1000)}K`
      : `${remaining_tokens}`;
    parts.push(t('modelSelector.freeQuota.remainingTokens', { tokens: tokensText }));
  }
  return parts.length > 0 ? parts.join(' · ') : '';
};

/// Phase 5.1: 模态标签简写（LLM/LMM/Image/Video）
const formatModalityLabel = (modality?: string | null): string => {
  if (!modality) return '';
  const upper = modality.toUpperCase();
  if (['LLM', 'LMM', 'IMAGE', 'VIDEO', 'EMBEDDING'].includes(upper)) {
    return upper;
  }
  return '';
};

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  currentMode,
  className = '',
  sessionId,
  currentTokens = 0,
  maxTokens = 0,
  controlledValue,
  onControlledSelect,
}) => {
  const { t } = useTranslation('flow-chat');
  // 受控模式（策窗口复用）：选择只回调，不写全局配置
  const isControlled = !!onControlledSelect;
  // 本地激活模型槽位（loadConfigData 会写入，故前置声明避免 use-before-define）
  const [localActiveSlotKey, setLocalActiveSlotKey] = useState('rwkv-7b');
  const [allModels, setAllModels] = useState<AIModelConfig[]>([]);
  const [defaultModels, setDefaultModels] = useState<Record<string, string>>({});
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [userTier, setUserTier] = useState<string | null>(null);
  const [userPlan, setUserPlan] = useState<UserPlanInfo | null>(null);
  const [ai00ApiModels, setAi00ApiModels] = useState<Ai00sModelInfo[]>([]);
  const [upgradeDialog, setUpgradeDialog] = useState<{ modelName: string; requiredTier: string } | null>(null);
  // 自动路由（ai.router）：自动模式下展示 R0-R3 档位对应模型，可点选修改（写全局配置，与设置页同源）
  const [routerTierModels, setRouterTierModels] = useState<Record<string, string>>({});
  const [routerEnabled, setRouterEnabled] = useState(false);
  const [tierEditor, setTierEditor] = useState<string | null>(null);
  // 本地模型目录（就绪/进度/解析路径，来自 Rust 内置目录：RWKV 3B/7B/13B + Qwen3.8 27B）
  const [localCatalog, setLocalCatalog] = useState<Record<string, {
    ready: boolean; progress: number | null;
    resolvedModelPath?: string; resolvedVocabPath?: string; resolvedGgufPath?: string;
  }>>({});
  const localDownloadPollRef = useRef<number | null>(null);

  const autoSelectedRef = useRef(false);

  /** 拉取本地模型内置目录（RWKV 3B/7B/13B + Qwen3.8 27B）的就绪状态与可用路径。 */
  const refreshLocalCatalog = useCallback(async () => {
    try {
      const [rwkvCat, ggufCat] = await Promise.all([
        invoke<{
          key: string; downloaded: boolean;
          resolved_model_path?: string; resolved_vocab_path?: string;
        }[]>('rwkv_builtin_catalog'),
        invoke<{ key: string; downloaded: boolean; resolved_path?: string }[]>('gguf_builtin_catalog'),
      ]);
      setLocalCatalog(prev => {
        const next = { ...prev };
        for (const e of rwkvCat) {
          next[e.key] = {
            ready: e.downloaded,
            progress: e.downloaded ? null : (prev[e.key]?.progress ?? null),
            resolvedModelPath: e.resolved_model_path,
            resolvedVocabPath: e.resolved_vocab_path,
          };
        }
        // 内置 GGUF 目录当前仅 Qwen3.8-27B 一项，映射到本地槽位 key
        for (const e of ggufCat) {
          next['qwen3.8-27b'] = {
            ready: e.downloaded,
            progress: e.downloaded ? null : (prev['qwen3.8-27b']?.progress ?? null),
            resolvedGgufPath: e.resolved_path,
          };
        }
        return next;
      });
    } catch (error) {
      log.warn('Failed to load local model catalog', error);
    }
  }, []);

  /** 触发本地模型下载并轮询进度（复用通用下载链路：断点/多源回退）。 */
  const startLocalDownload = useCallback(async (slotKey: string) => {
    try {
      let taskIds: string[] = [];
      if (slotKey.startsWith('rwkv')) {
        taskIds = await invoke<string[]>('rwkv_builtin_download', { key: slotKey });
      } else {
        taskIds = [await invoke<string>('gguf_builtin_download', { key: 'Qwen3.8-27B-UD-Q4_K_M' })];
      }
      setLocalCatalog(prev => ({
        ...prev,
        [slotKey]: { ready: prev[slotKey]?.ready ?? false, progress: 0 },
      }));
      if (localDownloadPollRef.current) window.clearInterval(localDownloadPollRef.current);
      localDownloadPollRef.current = window.setInterval(async () => {
        try {
          let finished = 0;
          let ratioSum = 0;
          for (const taskId of taskIds) {
            const p = await invoke<{ status: string; progress: number; total: number } | null>('get_download_progress', { taskId });
            if (!p) { finished += 1; continue; }
            if (p.status === 'Completed' || p.status === 'Failed') finished += 1;
            if (p.total > 0) ratioSum += p.progress / p.total;
          }
          const pct = Math.round((ratioSum / taskIds.length) * 100);
          setLocalCatalog(prev => ({
            ...prev,
            [slotKey]: { ready: prev[slotKey]?.ready ?? false, progress: Math.min(100, pct) },
          }));
          if (finished >= taskIds.length) {
            if (localDownloadPollRef.current) {
              window.clearInterval(localDownloadPollRef.current);
              localDownloadPollRef.current = null;
            }
            await refreshLocalCatalog();
          }
        } catch {
          // 单轮轮询失败忽略，下一轮重试
        }
      }, 1000);
    } catch (error) {
      log.warn('Failed to start local model download', { slotKey, error });
    }
  }, [refreshLocalCatalog]);

  const loadConfigData = useCallback(async () => {
    try {
      const [models, defaultModelsData, agentModelsData, routerCfg, localActive] = await Promise.all([
        configManager.getConfig<AIModelConfig[]>('ai.models') || [],
        configManager.getConfig<any>('ai.default_models') || {},
        configManager.getConfig<Record<string, string>>('ai.agent_models') || {},
        configManager.getConfig<any>('ai.router') || {},
        configManager.getConfig<string>('ai.local_active') || 'rwkv-7b',
      ]);

      setAllModels(models);
      setDefaultModels(defaultModelsData);
      setAgentModels(agentModelsData);
      setRouterTierModels(routerCfg.tier_models || {});
      setRouterEnabled(!!routerCfg.enabled);
      setLocalActiveSlotKey(localActive);

      log.debug('Configuration loaded', {
        modelsCount: models.length
      });
    } catch (error) {
      log.error('Failed to load configuration', error);
    }

    // Phase 5.1: 优先用 fetchUserPlanInfo 获取新体系套餐信息（free/basic/pro/flagship）
    // 失败时降级到旧的 fetchUserTier（向后兼容 free/cheap/expensive）
    try {
      const plan = await fetchUserPlanInfo();
      if (plan) {
        setUserPlan(plan);
        setUserTier(plan.planTier);
        setCachedTier(plan.planTier);
        setCachedUserPlan(plan);
      } else {
        // 降级：Tauri 环境获取 auth_info
        const authInfo = await invoke<{ plan_tier?: string | null } | null>('get_auth_info');
        if (authInfo?.plan_tier) {
          setUserTier(authInfo.plan_tier);
          setCachedTier(authInfo.plan_tier);
        } else {
          const tier = await fetchUserTier();
          if (tier) {
            setUserTier(tier);
          }
        }
      }
    } catch {
      const tier = await fetchUserTier();
      if (tier) {
        setUserTier(tier);
      }
    }

    // 拉取 Ai00-API 模型列表（带定价倍率 + 限流）
    try {
      const apiModels = await fetchAi00sModels();
      setAi00ApiModels(apiModels);
    } catch (err) {
      log.warn('Failed to fetch Ai00-API models', err);
    }
  }, []);

  useEffect(() => {
    loadConfigData();
    void refreshLocalCatalog();

    const handleConfigUpdate = () => {
      log.debug('Configuration update detected, reloading');
      loadConfigData();
    };

    globalEventBus.on('mode:config:updated', handleConfigUpdate);

    const unsubscribe = configManager.onConfigChange((path) => {
      if (path.startsWith('ai.')) {
        log.debug('AI configuration changed', { path });
        loadConfigData();
      }
    });

    return () => {
      globalEventBus.off('mode:config:updated', handleConfigUpdate);
      unsubscribe();
      if (localDownloadPollRef.current) {
        window.clearInterval(localDownloadPollRef.current);
        localDownloadPollRef.current = null;
      }
    };
  }, [loadConfigData, refreshLocalCatalog]);

  // 受控模式的 primary 来自调用方；非受控来自全局配置
  const primaryModelId = isControlled ? (controlledValue ?? null) : (defaultModels.primary || null);

  const currentModel = useMemo((): ModelInfo | null => {
    if (isControlled) {
      const ref = primaryModelId;
      if (!ref || ref === 'auto') return buildAutoModelInfo(t);
      const model = allModels.find(m => m.id === ref);
      if (!model) return buildAutoModelInfo(t);
      return {
        id: ref,
        configName: model.name,
        modelName: model.model_name,
        providerName: getProviderDisplayName(model),
        provider: model.provider,
        contextWindow: model.context_window,
        enableThinking: isReasoningVisiblyEnabled(getEffectiveReasoningMode(model)),
        reasoningEffort: model.reasoning_effort,
      };
    }

    const configuredModelId = agentModels[currentMode] || 'auto';

    if (configuredModelId === 'auto') {
      if (primaryModelId) {
        const model = allModels.find(m => m.id === primaryModelId);
        if (model) {
          return {
            id: 'auto',
            configName: t('modelSelector.autoModel'),
            modelName: model.model_name,
            providerName: getProviderDisplayName(model),
            provider: model.provider,
            contextWindow: model.context_window,
            enableThinking: isReasoningVisiblyEnabled(getEffectiveReasoningMode(model)),
            reasoningEffort: model.reasoning_effort,
          };
        }
      }
      return buildAutoModelInfo(t);
    }

    const model = allModels.find(m => m.id === configuredModelId);
    if (!model) return buildAutoModelInfo(t);

    return {
      id: model.id || '',
      configName: model.name,
      modelName: model.model_name,
      providerName: getProviderDisplayName(model),
      provider: model.provider,
      contextWindow: model.context_window,
      enableThinking: isReasoningVisiblyEnabled(getEffectiveReasoningMode(model)),
      reasoningEffort: model.reasoning_effort,
    };
  }, [allModels, currentMode, agentModels, primaryModelId, isControlled, t]);

  const availableModels = useMemo((): ModelInfo[] => {
    return allModels
      .filter(m => {
        if (!m.enabled) return false;
        const capabilities = Array.isArray(m.capabilities) ? m.capabilities : [];
        return capabilities.includes('text_chat');
      })
      .map(m => ({
        id: m.id || '',
        configName: m.name,
        modelName: m.model_name,
        providerName: getProviderDisplayName(m),
        provider: m.provider,
        contextWindow: m.context_window,
        enableThinking: isReasoningVisiblyEnabled(getEffectiveReasoningMode(m)),
        reasoningEffort: m.reasoning_effort,
      }));
  }, [allModels]);

  /// 非 ai00s 的全部模型（本地 + 用户自定义）
  const customModels = useMemo((): ModelInfo[] => {
    return availableModels.filter(m => !isAi00sModel(m.id));
  }, [availableModels]);

  /// 用户自定义远程 API 模型（排除本地模型）；ai00s 作为 Ai00-API 入口，不在此列表
  const customApiModels = useMemo((): ModelInfo[] => {
    return customModels.filter(m =>
      !((m.provider || '').trim().toLowerCase() === 'rwkv' || m.id.startsWith('gguf-local:'))
    );
  }, [customModels]);

  const handleSelectModel = useCallback(async (modelId: string, keepOpen = false) => {
    if (loading) return;

    // 受控模式：只回调调用方（策窗口局部持久化），不写全局配置
    if (isControlled) {
      onControlledSelect?.(modelId);
      // auto 开关切换（keepOpen）与切到 auto 均保持弹层打开；从列表选具体模型才关闭
      if (!keepOpen && modelId !== 'auto') setDropdownOpen(false);
      return;
    }

    setLoading(true);
    try {
      if (modelId === 'auto') {
        // 自动模式 = 显式覆盖标记 'auto'；当前模型（primary）保留不动，
        // 关闭自动时即回到之前选的模型（未选过则由调用方回落本地）
        const currentAgentModels = await configManager.getConfig<Record<string, string>>('ai.agent_models') || {};
        const updatedAgentModels = { ...currentAgentModels, [currentMode]: 'auto' };
        await configManager.setConfig('ai.agent_models', updatedAgentModels);
        setAgentModels(updatedAgentModels);
        // 切到 auto 不关闭弹层：下方展开 R0-R3 路由配置
      } else {
        const currentDefaultModels = await configManager.getConfig<any>('ai.default_models') || {};
        await configManager.setConfig('ai.default_models', {
          ...currentDefaultModels,
          primary: modelId,
        });
        setDefaultModels(prev => ({ ...prev, primary: modelId }));

        // 关闭自动：清除该模式的 'auto' 覆盖，回到当前模型
        const currentAgentModels = await configManager.getConfig<Record<string, string>>('ai.agent_models') || {};
        const updatedAgentModels = { ...currentAgentModels };
        delete updatedAgentModels[currentMode];
        await configManager.setConfig('ai.agent_models', updatedAgentModels);
        setAgentModels(updatedAgentModels);

        if (!keepOpen) setDropdownOpen(false);
      }

      if (sessionId) {
        FlowChatStore.getInstance().updateSessionModelName(sessionId, modelId === 'auto' ? 'auto' : modelId);
        await agentAPI.updateSessionModel({
          sessionId,
          modelName: modelId === 'auto' ? 'auto' : modelId,
        });
      }

      log.info('Primary model updated', { modelId });

      globalEventBus.emit('mode:config:updated');

      setDropdownOpen(false);
    } catch (error) {
      log.error('Failed to switch model', error);
    } finally {
      setLoading(false);
    }
  }, [currentMode, loading, sessionId, isControlled, onControlledSelect]);

  /// 当前选中的 Ai00-API 子模型 id（primary 为 'ai00s:<sub>' 复合引用时取 sub；旧 'ai00s' 引用取 ai00s.model_name）
  const currentAi00ApiModelId = useMemo(() => {
    if (!primaryModelId) return null;
    if (primaryModelId.startsWith('ai00s:')) {
      return primaryModelId.slice('ai00s:'.length) || null;
    }
    if (primaryModelId === 'ai00s') {
      const ai00sModel = allModels.find(m => m.id === 'ai00s');
      return ai00sModel?.model_name || null;
    }
    return null;
  }, [primaryModelId, allModels]);

  /// 本地模型固定槽位（RWKV 3B / 7B / 13B / Qwen3.8 27B）。
  /// 就绪/进度来自 Rust 内置下载目录（未下载可触发下载）；本地引擎同时只加载一个，
  /// RWKV 系就绪槽统一指向 'rwkv-local'（激活由 ai.local_active 决定），
  /// Qwen 就绪指向 'gguf-local:<路径>'（执行前由 gguf_ensure_server 懒启动）。
  const localSlots = useMemo(() => {
    const cat = (key: string) => localCatalog[key] ?? { ready: false, progress: null as number | null };
    const rwkvSlot = (key: string, label: string) => {
      const { ready, progress } = cat(key);
      return { key, label, ready, progress, ref: ready ? 'rwkv-local' : null };
    };
    const qwen = cat('qwen3.8-27b');
    // 路径由 Rust 侧 gguf_builtin_catalog 解析返回，前端不再自行拼接
    const qwenRef = qwen.ready && qwen.resolvedGgufPath
      ? `gguf-local:${qwen.resolvedGgufPath}`
      : null;

    return [
      { ...rwkvSlot('rwkv-3b', 'RWKV 3B') },
      { ...rwkvSlot('rwkv-7b', 'RWKV 7B') },
      { ...rwkvSlot('rwkv-13b', 'RWKV 13B') },
      { key: 'qwen3.8-27b', label: 'Qwen3.8 27B', ready: qwen.ready, progress: qwen.progress, ref: qwenRef },
    ];
  }, [localCatalog]);

  /// 当前 primary 是否指向本地槽位（用于高亮）
  const isLocalSlotSelected = useCallback((slotRef: string | null): boolean => {
    return !!slotRef && primaryModelId === slotRef;
  }, [primaryModelId]);

  // ===== 自动路由（ai.router）：R0-R3 档位 ↔ 模型快捷配置 =====

  // 本地激活模型（'rwkv-7b' 默认 / 'qwen3.8-27b' …）：本地引擎同时只加载一个，
  // R0-R3 选「本地」都指向它；选择持久化到 ai.local_active
  // （state 声明前置到组件顶部 state 区：loadConfigData 在其定义前写入）
  const [localActiveEditorOpen, setLocalActiveEditorOpen] = useState(false);

  const handleLocalActiveChange = useCallback(async (slotKey: string) => {
    setLocalActiveSlotKey(slotKey);
    setLocalActiveEditorOpen(false);
    try {
      await configManager.setConfig('ai.local_active', slotKey);
      // 引擎联动（仅就绪模型）：RWKV 槽热切换引擎；Qwen 槽懒启动 llama-server
      const entry = localCatalog[slotKey];
      if (!entry?.ready) return;
      if (slotKey.startsWith('rwkv')) {
        if (entry.resolvedModelPath) {
          void invoke('init_llm_engine', {
            modelPath: entry.resolvedModelPath,
            vocabPath: entry.resolvedVocabPath ?? null,
          }).catch((e) => log.warn('Failed to hot-switch RWKV engine', { slotKey, e }));
        }
      } else if (entry.resolvedGgufPath) {
        void invoke('gguf_ensure_server', {
          ggufPath: entry.resolvedGgufPath,
        }).catch((e) => log.warn('Failed to ensure llama-server', { slotKey, e }));
      }
    } catch (error) {
      log.warn('Failed to set active local model', { slotKey, error });
    }
  }, [localCatalog]);

  const handleTierModelChange = useCallback(async (tierKey: string, ref: string) => {
    const next = { ...routerTierModels, [tierKey]: ref };
    setRouterTierModels(next);
    try {
      const routerCfg = await configManager.getConfig<any>('ai.router') || {};
      await configManager.setConfig('ai.router', { ...routerCfg, tier_models: next });
    } catch (error) {
      log.warn('Failed to update router tier model', { tierKey, ref, error });
    }
  }, [routerTierModels]);

  const handleRouterEnabledChange = useCallback(async (enabled: boolean) => {
    setRouterEnabled(enabled);
    try {
      const routerCfg = await configManager.getConfig<any>('ai.router') || {};
      await configManager.setConfig('ai.router', { ...routerCfg, enabled });
    } catch (error) {
      log.warn('Failed to toggle smart router', { enabled, error });
    }
  }, []);

  /** 档位引用 → 显示名（primary/fast 为动态引用：fast 未设置时回落当前模型） */
  const resolveTierRefLabel = useCallback((ref: string): string => {
    const resolveId = (id: string): string => {
      const hit = allModels.find(m => m.id === id);
      if (hit) return hit.model_name || hit.name;
      if (id.startsWith('ai00s:')) {
        return ai00ApiModels.find(m => m.id === id.slice('ai00s:'.length))?.displayName || id;
      }
      if (id.startsWith('gguf-local:')) return getGgufModelDisplayName(id.slice('gguf-local:'.length));
      return id;
    };
    if (ref === 'primary') {
      return defaultModels.primary ? resolveId(defaultModels.primary) : t('modelSelector.autoModel');
    }
    if (ref === 'fast') {
      // 中档概念已废除：fast 引用运行时回落当前模型，显示上直接展示
      return defaultModels.fast ? resolveId(defaultModels.fast) : resolveTierRefLabel('primary');
    }
    if (ref === 'rwkv-local') {
      // 「本地」= 当前激活的本地模型（本地引擎同时只加载一个，由 ai.local_active 决定）
      return localSlots.find(s => s.key === localActiveSlotKey)?.label || ref;
    }
    return resolveId(ref);
  }, [allModels, ai00ApiModels, defaultModels, localSlots, localActiveSlotKey, t]);

  /** 档位模型候选：「本地」统一一项（指向激活的本地模型）+ Ai00-API 子模型 + 自定义模型 */
  const tierCandidates = useMemo(() => {
    const items: { ref: string; label: string }[] = [];
    if (localSlots.some(s => s.ready && s.ref)) {
      items.push({ ref: 'rwkv-local', label: t('modelSelector.localModels.sectionTitle') });
    }
    ai00ApiModels
      .filter(m => canAccessModel(m, userTier))
      .forEach(m => {
        items.push({
          ref: `ai00s:${m.id}`,
          label: m.multiplier !== undefined
            ? `${m.displayName} · ${formatMultiplier(m.multiplier)}`
            : m.displayName,
        });
      });
    customApiModels.forEach(m => {
      items.push({ ref: m.id, label: m.modelName });
    });
    return items;
  }, [localSlots, ai00ApiModels, customApiModels, userTier, t]);

  /// Phase 5.1: 是否免费层用户（用于显示升级提示）
  const isFreeUser = useMemo(() => {
    return isFreeTier(userPlan?.planTier ?? userTier);
  }, [userPlan, userTier]);

  /// 选择 Ai00-API 子模型
  /// - 优先检查额度（exhausted 时阻止选择）
  /// - 兼容旧的 tier 检查（canAccessModel）
  const handleSelectAi00ApiModel = useCallback(async (apiModel: Ai00sModelInfo) => {
    if (loading) return;

    // 受控模式：只回调复合引用，不写全局配置
    if (isControlled) {
      onControlledSelect?.(`ai00s:${apiModel.id}`);
      setDropdownOpen(false);
      return;
    }

    // 额度用完阻止选择
    if (!isModelSelectable(apiModel)) {
      log.info('Free model quota exhausted, selection blocked', { modelId: apiModel.id });
      return;
    }

    // locked：当前套餐不可用（新体系后端下发 locked；旧体系兜底按 tier rank）→ 弹升级提示
    if (!canAccessModel(apiModel, userTier)) {
      setUpgradeDialog({
        modelName: apiModel.displayName,
        requiredTier: apiModel.tier,
      });
      return;
    }

    setLoading(true);
    try {
      // 同步 ai00s.model_name（旧引用与模板显示兜底）；实际调用走 primary 的复合引用
      const currentModels = await configManager.getConfig<AIModelConfig[]>('ai.models') || [];
      const updatedModels = currentModels.map(m =>
        m.id === 'ai00s' ? { ...m, model_name: apiModel.id } : m
      );
      await configManager.setConfig('ai.models', updatedModels);
      setAllModels(updatedModels);

      // primary 写复合引用 ai00s:<sub>（独立绑定子模型，不与中档共享）
      const compositeRef = `ai00s:${apiModel.id}`;
      const currentDefaultModels = await configManager.getConfig<any>('ai.default_models') || {};
      await configManager.setConfig('ai.default_models', {
        ...currentDefaultModels,
        primary: compositeRef,
      });
      setDefaultModels(prev => ({ ...prev, primary: compositeRef }));

      // 清除当前 mode 的 agent_models 覆盖
      const currentAgentModels = await configManager.getConfig<Record<string, string>>('ai.agent_models') || {};
      const updatedAgentModels = { ...currentAgentModels };
      delete updatedAgentModels[currentMode];
      await configManager.setConfig('ai.agent_models', updatedAgentModels);
      setAgentModels(updatedAgentModels);

      if (sessionId) {
        FlowChatStore.getInstance().updateSessionModelName(sessionId, compositeRef);
        await agentAPI.updateSessionModel({
          sessionId,
          modelName: compositeRef,
        });
      }

      log.info('Ai00-API sub-model selected', { subModelId: apiModel.id });

      globalEventBus.emit('mode:config:updated');

      setDropdownOpen(false);
    } catch (error) {
      log.error('Failed to switch Ai00-API sub-model', error);
    } finally {
      setLoading(false);
    }
  }, [currentMode, loading, sessionId, userTier, isControlled, onControlledSelect]);

  /// 自动默认选中：当 primary 指向 Ai00-API 且当前子模型是无效占位符（"ai00s" 或不在服务器模型列表）
  /// 时，自动选中服务器标注的默认模型（isDefault），无默认则选第一个可访问模型。
  /// 仅执行一次，避免覆盖用户手动选择。
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (isControlled) return;
    if (!primaryModelId || !isAi00sModel(primaryModelId)) return;
    if (ai00ApiModels.length === 0) return;

    const currentSubModelId = primaryModelId.startsWith('ai00s:')
      ? primaryModelId.slice('ai00s:'.length)
      : (allModels.find(m => m.id === 'ai00s')?.model_name || '');
    // 无效判定：占位符 "ai00s" 或不在服务器返回的模型中
    const isValid = currentSubModelId !== 'ai00s'
      && ai00ApiModels.some(m => m.id === currentSubModelId);
    if (isValid) return;

    autoSelectedRef.current = true;
    // 优先选服务器标注的默认模型，否则第一个可访问（未锁定）的模型
    const defaultModel = ai00ApiModels.find(m => m.isDefault && !m.locked)
      || ai00ApiModels.find(m => m.isUpstreamFree && !m.locked)
      || ai00ApiModels.find(m => !m.locked)
      || ai00ApiModels[0];
    if (defaultModel) {
      log.info('Auto-selecting server default model', { modelId: defaultModel.id });
      handleSelectAi00ApiModel(defaultModel);
    }
  }, [isControlled, primaryModelId, ai00ApiModels, allModels, handleSelectAi00ApiModel]);

  const tokenPercentage = useMemo(() => {
    if (!maxTokens || maxTokens <= 0 || !currentTokens) return 0;
    return Math.min(Math.round((currentTokens / maxTokens) * 100), 100);
  }, [currentTokens, maxTokens]);

  const tokenStatusClass = useMemo(() => {
    if (tokenPercentage >= 90) return 'critical';
    if (tokenPercentage >= 70) return 'warning';
    return '';
  }, [tokenPercentage]);

  const formatTokenCount = (n: number) =>
    n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;

  const isAutoMode = isControlled
    ? (primaryModelId === 'auto')
    : (agentModels[currentMode] === 'auto');

  // 「自动」关闭时回到的模型：受控模式记住最近一次非 auto 选择；非受控 = 当前模型（primary），没选过默认本地
  const lastControlledRef = useRef<string | null>(null);
  useEffect(() => {
    if (isControlled && controlledValue && controlledValue !== 'auto') {
      lastControlledRef.current = controlledValue;
    }
  }, [isControlled, controlledValue]);
  const lastModelRef = isControlled
    ? (lastControlledRef.current || 'rwkv-local')
    : (primaryModelId && primaryModelId !== 'auto' ? primaryModelId : 'rwkv-local');

  const handleToggleAutoMode = useCallback(() => {
    // auto 开/关切换都保持弹层打开（keepOpen）
    void handleSelectModel(isAutoMode ? lastModelRef : 'auto', true);
  }, [handleSelectModel, isAutoMode, lastModelRef]);

  const triggerLabel = useMemo(() => {
    // 受控模式：从引用解析显示名（本地槽位 / Ai00-API 子模型 / 自定义模型）
    if (isControlled) {
      const ref = primaryModelId;
      if (!ref || ref === 'auto') return t('modelSelector.autoModel');
      if (ref === 'rwkv-local') {
        return localSlots.find(s => s.ref === 'rwkv-local')?.label || ref;
      }
      if (ref.startsWith('gguf-local:')) {
        return localSlots.find(s => s.ref === ref)?.label
          || getGgufModelDisplayName(ref.slice('gguf-local:'.length));
      }
      if (ref.startsWith('ai00s:')) {
        const sub = ref.slice('ai00s:'.length);
        return ai00ApiModels.find(m => m.id === sub)?.displayName || sub;
      }
      const hit = allModels.find(m => m.id === ref);
      return hit?.model_name || hit?.name || ref;
    }

    if (isAutoMode && primaryModelId) {
      const model = allModels.find(m => m.id === primaryModelId);
      if (model) return model.model_name || model.name;
    }
    if (currentModel) {
      return currentModel.modelName || currentModel.configName;
    }
    return t('modelSelector.autoModel');
  }, [isControlled, isAutoMode, primaryModelId, allModels, currentModel, t, localSlots, ai00ApiModels]);

  if (!isControlled && availableModels.length === 0 && ai00ApiModels.length === 0) {
    return null;
  }

  const primaryModel = allModels.find(m => m.id === primaryModelId);
  const autoTooltip = primaryModel
    ? buildResolvedModelTooltipText(primaryModel.model_name, {
      providerName: getProviderDisplayName(primaryModel),
      contextWindow: primaryModel.context_window
    }, t('modelSelector.autoModelDesc'))
    : t('modelSelector.autoModelDesc');

  const baseTooltip = isAutoMode ? autoTooltip : (currentModel ? buildModelMetaText(currentModel) : autoTooltip);
  const tooltipContent =
    currentTokens > 0 && maxTokens > 0
      ? `${baseTooltip} · ${formatTokenCount(currentTokens)}/${formatTokenCount(maxTokens)} (${tokenPercentage}%)`
      : baseTooltip;

  return (
    <Popover open={dropdownOpen} onOpenChange={setDropdownOpen}>
      <div className={`ai00-x-model-selector ${className}`}>
        <Tooltip content={tooltipContent}>
          <PopoverTrigger asChild>
            <button
              className={`ai00-x-model-selector__trigger ${dropdownOpen ? 'ai00-x-model-selector__trigger--open' : ''}`}
              disabled={loading}
            >
              <Cpu size={10} className="ai00-x-model-selector__icon" />
              <span className="ai00-x-model-selector__name">
                {triggerLabel}
              </span>
              {currentModel?.enableThinking && (
                <Sparkles size={9} className="ai00-x-model-selector__thinking-icon" />
              )}
              {currentModel?.reasoningEffort && (
                <span className="ai00-x-model-selector__effort-badge">
                  {currentModel.reasoningEffort}
                </span>
              )}
              {tokenPercentage > 0 && (
                <span className={`ai00-x-model-selector__ctx-usage${tokenStatusClass ? ` ai00-x-model-selector__ctx-usage--${tokenStatusClass}` : ''}`}>
                  · {tokenPercentage}%
                </span>
              )}
              <ChevronDown size={10} className="ai00-x-model-selector__chevron" />
            </button>
          </PopoverTrigger>
        </Tooltip>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={6}
          className="ai00-x-model-selector__dropdown"
        >
          {/* Trae 风格头部：Auto Mode + 开关（整行可点 = 切换自动路由；开关仅作状态指示）。
              自动开启 → R0-R3 路由；关闭 → 回到之前选的模型（当前模型参数始终保留，未选过默认本地） */}
          <div
            className={`ai00-x-model-selector__auto-header${isAutoMode ? ' ai00-x-model-selector__auto-header--active' : ''}`}
            onClick={handleToggleAutoMode}
          >
            <div className="ai00-x-model-selector__auto-header-text">
              <span className="ai00-x-model-selector__auto-title">{t('modelSelector.autoMode')}</span>
              <span className="ai00-x-model-selector__auto-subtitle">
                {isControlled
                  ? t('modelSelector.autoModelDesc')
                  : (isAutoMode
                    ? `${t('modelSelector.currentMode')}: ${currentMode}`
                    : `→ ${resolveTierRefLabel(lastModelRef)}`)}
              </span>
            </div>
            <Switch size="small" checked={isAutoMode} readOnly tabIndex={-1} className="ai00-x-model-selector__auto-switch" />
          </div>

          {/* 自动路由：R0-R3 档位 ↔ 对应模型（快捷配置，写入 ai.router 全局配置，与设置页同源） */}
          {isAutoMode && (
            <div className="ai00-x-model-selector__auto-route">
              <div className="ai00-x-model-selector__auto-route-head">
                <span className="ai00-x-model-selector__section-title">
                  {t('modelSelector.autoRoute.sectionTitle')}
                </span>
                <Switch
                  size="small"
                  checked={routerEnabled}
                  onChange={(e) => void handleRouterEnabledChange(e.target.checked)}
                />
              </div>
              {!routerEnabled && (
                <div className="ai00-x-model-selector__auto-route-hint">
                  {t('modelSelector.autoRoute.disabledHint')}
                </div>
              )}
              {/* 本地模型是哪个：本地引擎同时只加载一个，R0-R3 选「本地」都指向它 */}
              <div className="ai00-x-model-selector__auto-route-tier">
                <div
                  className="ai00-x-model-selector__auto-route-tier-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setLocalActiveEditorOpen(prev => !prev)}
                >
                  <span className="ai00-x-model-selector__auto-route-tier-label">
                    {t('modelSelector.autoRoute.localModel')}
                  </span>
                  <span className="ai00-x-model-selector__auto-route-tier-model">
                    {localSlots.find(s => s.key === localActiveSlotKey)?.label
                      || t('modelSelector.localModels.notReadyShort')}
                  </span>
                  <ChevronRight
                    size={10}
                    className={`ai00-x-model-selector__auto-route-tier-chevron${localActiveEditorOpen ? ' is-open' : ''}`}
                  />
                </div>
                {localActiveEditorOpen && (
                  <div className="ai00-x-model-selector__auto-route-options">
                    {localSlots.map(slot => {
                      const slotDownloading = !slot.ready && slot.progress !== null;
                      return (
                        <div
                          key={slot.key}
                          className={`ai00-x-model-selector__auto-route-option${slot.key === localActiveSlotKey ? ' is-selected' : ''}${!slot.ready ? ' is-disabled' : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            if (slot.ready) void handleLocalActiveChange(slot.key);
                            else if (!slotDownloading) void startLocalDownload(slot.key);
                          }}
                        >
                          <span className="ai00-x-model-selector__auto-route-option-label">
                            {slot.label}
                            {!slot.ready
                              ? (slotDownloading
                                ? ` · ${t('modelSelector.localModels.downloading')} ${slot.progress}%`
                                : ` · ${t('modelSelector.localModels.downloadNow')}`)
                              : ''}
                          </span>
                          {slot.key === localActiveSlotKey && (
                            <Check size={12} className="ai00-x-model-selector__option-check" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {([
                { key: 'r0', label: t('modelSelector.autoRoute.r0') },
                { key: 'r1', label: t('modelSelector.autoRoute.r1') },
                { key: 'r2', label: t('modelSelector.autoRoute.r2') },
                { key: 'r3', label: t('modelSelector.autoRoute.r3') },
              ]).map(({ key, label }) => {
                const fallbackRef = key === 'r0' || key === 'r1' ? 'rwkv-local' : key === 'r2' ? 'fast' : 'primary';
                const ref = routerTierModels[key] || fallbackRef;
                const editing = tierEditor === key;

                return (
                  <div key={key} className="ai00-x-model-selector__auto-route-tier">
                    <div
                      className="ai00-x-model-selector__auto-route-tier-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => setTierEditor(editing ? null : key)}
                    >
                      <span className="ai00-x-model-selector__auto-route-tier-label">{label}</span>
                      <span className="ai00-x-model-selector__auto-route-tier-model">
                        {resolveTierRefLabel(ref)}
                      </span>
                      <ChevronRight size={10} className="ai00-x-model-selector__auto-route-tier-chevron" />
                    </div>
                    {editing && (
                      <div className="ai00-x-model-selector__auto-route-options">
                        {tierCandidates.map(c => (
                          <div
                            key={c.ref}
                            className={`ai00-x-model-selector__auto-route-option${ref === c.ref ? ' is-selected' : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              void handleTierModelChange(key, c.ref);
                              setTierEditor(null);
                            }}
                          >
                            <span className="ai00-x-model-selector__auto-route-option-label">{c.label}</span>
                            {ref === c.ref && (
                              <Check size={12} className="ai00-x-model-selector__option-check" />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* 本地模型：固定槽位（RWKV 3B / 7B / 13B / Qwen3.8 27B）；自动模式下不显示（只留 R0-R3 路由配置） */}
          {!isAutoMode && (
          <>
          <div className="ai00-x-model-selector__section-title">
            {t('modelSelector.localModels.sectionTitle')}
          </div>
          <div className="ai00-x-model-selector__list">
            {localSlots.map(slot => {
              const isSelected = isLocalSlotSelected(slot.ref);
              const downloading = !slot.ready && slot.progress !== null;
              const slotTooltip = slot.ready
                ? slot.label
                : downloading
                  ? `${slot.label} · ${t('modelSelector.localModels.downloading')} ${slot.progress}%`
                  : t('modelSelector.localModels.notReady');
              const statusText = downloading
                ? `${slot.progress}%`
                : (slot.ready ? null : t('modelSelector.localModels.downloadNow'));

              return (
                <Tooltip key={slot.key} content={slotTooltip} placement="right">
                  <div
                    className={`ai00-x-model-selector__option ${isSelected ? 'ai00-x-model-selector__option--selected' : ''} ${!slot.ready ? 'ai00-x-model-selector__option--disabled' : ''}`}
                    onClick={() => {
                      if (slot.ready && slot.ref) {
                        // 选为当前模型的同时激活该本地模型（引擎热切换 / gguf 懒启动）
                        if (slot.key !== localActiveSlotKey) void handleLocalActiveChange(slot.key);
                        void handleSelectModel(slot.ref);
                      } else if (!slot.ready && !downloading) {
                        void startLocalDownload(slot.key);
                      }
                    }}
                  >
                    <span className="ai00-x-model-selector__option-avatar" aria-hidden="true">
                      {slot.label.charAt(0).toUpperCase()}
                    </span>
                    <div className="ai00-x-model-selector__option-main">
                      <div className="ai00-x-model-selector__option-title">
                        <span className="ai00-x-model-selector__option-name">
                          {slot.label}
                        </span>
                      </div>
                    </div>
                    {statusText && (
                      <span className="ai00-x-model-selector__option-multiplier">
                        {statusText}
                      </span>
                    )}
                    {isSelected && (
                      <Check size={14} className="ai00-x-model-selector__option-check" />
                    )}
                  </div>
                </Tooltip>
              );
            })}
          </div>
          </>
          )}

          {/* Ai00-API：服务器下发的模型列表 + 消耗倍率；自动模式下不显示 */}
          {!isAutoMode && ai00ApiModels.length > 0 && (
            <>
              <div className="ai00-x-model-selector__section-title">
                {t('modelSelector.xfModels.sectionTitle')}
              </div>
              <div className="ai00-x-model-selector__list">
                {ai00ApiModels.map(apiModel => {
                        const isSelected = currentAi00ApiModelId === apiModel.id;
                        const isLocked = !canAccessModel(apiModel, userTier);
                        const isExhausted = apiModel.isUpstreamFree && getFreeQuotaStatus(apiModel.freeQuota) === 'exhausted';
                        const multiplierText = apiModel.multiplier !== undefined ? formatMultiplier(apiModel.multiplier) : null;
                        const quotaText = formatFreeQuotaText(apiModel, t);
                        const modalityLabel = formatModalityLabel(apiModel.modality);
                        const hasMemberDiscount = !!apiModel.discountEligible
                          && apiModel.memberDiscount !== undefined
                          && apiModel.memberDiscount < 1;
                        const memberZhe = hasMemberDiscount
                          ? String(parseFloat((apiModel.memberDiscount! * 10).toFixed(1)))
                          : '';
                        const memberPct = hasMemberDiscount
                          ? Math.round((1 - (apiModel.memberDiscount ?? 1)) * 100)
                          : 0;

                        // tooltip: 显示名 + 模态 + 机构 + 剩余额度 + 锁定原因（元价格不再突出）
                        const tooltipParts: string[] = [apiModel.displayName];
                        if (modalityLabel) tooltipParts.push(modalityLabel);
                        if (apiModel.producer) tooltipParts.push(apiModel.producer);
                        if (quotaText) tooltipParts.push(quotaText);
                        if (isExhausted) {
                          tooltipParts.push(t('modelSelector.freeQuota.exhausted'));
                        } else if (isLocked) {
                          tooltipParts.push(t('modelSelector.upgrade.locked'));
                        }
                        const tooltipText = tooltipParts.join(' · ');

                        return (
                          <Tooltip key={apiModel.id} content={tooltipText} placement="right">
                            <div
                              className={`ai00-x-model-selector__option ${isSelected ? 'ai00-x-model-selector__option--selected' : ''} ${isExhausted ? 'ai00-x-model-selector__option--disabled' : ''} ${isLocked ? 'ai00-x-model-selector__option--locked' : ''}`}
                              onClick={() => handleSelectAi00ApiModel(apiModel)}
                            >
                              <span className="ai00-x-model-selector__option-avatar" aria-hidden="true">
                                {apiModel.displayName.charAt(0).toUpperCase()}
                              </span>
                              <div className="ai00-x-model-selector__option-main">
                                <div className="ai00-x-model-selector__option-title">
                                  <span className="ai00-x-model-selector__option-name">
                                    {apiModel.displayName}
                                  </span>
                                  {apiModel.isDefault && (
                                    <span
                                      className="ai00-x-model-selector__option-dot"
                                      title={t('modelSelector.defaultBadge')}
                                    />
                                  )}
                                  {hasMemberDiscount && (
                                    <span className="ai00-x-model-selector__option-tag ai00-x-model-selector__option-tag--discount">
                                      {t('modelSelector.badges.memberDiscount', { zhe: memberZhe, pct: memberPct })}
                                    </span>
                                  )}
                                  {apiModel.isUpstreamFree && (
                                    <span className="ai00-x-model-selector__option-tag ai00-x-model-selector__option-tag--subsidy">
                                      {t('modelSelector.badges.subsidy')}
                                    </span>
                                  )}
                                </div>
                              </div>
                              {isLocked ? (
                                <Lock size={12} className="ai00-x-model-selector__option-lock" />
                              ) : (
                                multiplierText && (
                                  <span className="ai00-x-model-selector__option-multiplier">
                                    {multiplierText}
                                  </span>
                                )
                              )}
                              {isSelected && (
                                <Check size={14} className="ai00-x-model-selector__option-check" />
                              )}
                            </div>
                          </Tooltip>
                        );
                      })}
              </div>

              {/* 免费层用户升级提示 */}
              {isFreeUser && (
                <div className="ai00-x-model-selector__upgrade-hint">
                  <Rocket size={11} className="ai00-x-model-selector__upgrade-icon" />
                  <span>{t('modelSelector.upgradeHint.freeTier')}</span>
                </div>
              )}
            </>
          )}

          {/* 自定义模型API；自动模式下不显示 */}
          {!isAutoMode && customApiModels.length > 0 && (
            <>
              <div className="ai00-x-model-selector__section-title">
                {t('modelSelector.customModels.sectionTitle')}
              </div>
              <div className="ai00-x-model-selector__list">
                {customApiModels.map(model => {
                  const isPrimary = model.id === primaryModelId;

                  return (
                    <Tooltip key={model.id} content={buildModelMetaText(model)} placement="right">
                      <div
                        className={`ai00-x-model-selector__option ${isPrimary ? 'ai00-x-model-selector__option--selected' : ''}`}
                        onClick={() => handleSelectModel(model.id)}
                      >
                        <span className="ai00-x-model-selector__option-avatar" aria-hidden="true">
                          {model.modelName.charAt(0).toUpperCase()}
                        </span>
                        <div className="ai00-x-model-selector__option-main">
                          <div className="ai00-x-model-selector__option-title">
                            <span className="ai00-x-model-selector__option-name">
                              {model.modelName}
                            </span>
                            {model.enableThinking && (
                              <Sparkles size={10} className="ai00-x-model-selector__option-thinking" />
                            )}
                          </div>
                        </div>
                        {isPrimary && (
                          <Check size={14} className="ai00-x-model-selector__option-check" />
                        )}
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            </>
          )}

          {/* 积分余额底栏（来自 /ai00-s/api/ai/me 的 total_remaining） */}
          <div className="ai00-x-model-selector__dropdown-footer">
            <Coins size={11} className="ai00-x-model-selector__footer-icon" />
            <span className="ai00-x-model-selector__footer-label">{t('modelSelector.balance.label')}</span>
            <span className="ai00-x-model-selector__footer-value">
              {userPlan ? formatCredits(userPlan.totalRemaining) : '—'}
            </span>
          </div>
        </PopoverContent>
      </div>

      <UpgradeDialog
        isOpen={upgradeDialog !== null}
        onClose={() => setUpgradeDialog(null)}
        modelName={upgradeDialog?.modelName ?? ''}
        requiredTier={upgradeDialog?.requiredTier ?? ''}
        currentTier={userTier}
      />
    </Popover>
  );
};
export default ModelSelector;
