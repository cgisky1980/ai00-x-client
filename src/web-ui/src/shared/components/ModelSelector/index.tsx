/**
 * Model selector component.
 * Shows the active model and allows quick switching.
 *
 * 模型语义（2026-09-11 收敛）：
 * - 本地模型仅 RWKV 3B 一个槽位：常驻引擎（智能路由/本地工具用），恒勾选；
 *   第一次初始化自动拉起下载，不作为对话模型候选。
 * - 远程模型（Ai00-API / 自定义 API）必须选一个：未选过自动选服务器默认。
 * - 「自动」不再是可选项：自动路由（R0-R3）是系统默认行为，无需选择/配置。
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Cpu, ChevronDown, Check, Sparkles, Lock, Rocket, Coins } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getProviderDisplayName } from '@/infrastructure/config/services/modelConfigs';
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
import { Tooltip, Popover, PopoverTrigger, PopoverContent } from '@/component-library';
import { createLogger } from '@/shared/utils/logger';
import { UpgradeDialog } from './UpgradeDialog';
import './ModelSelector.scss';

const log = createLogger('ModelSelector');

/// Rust 内置 GGUF 目录 key ↔ 前端本地槽位 key（ai.local_active 持久化用槽位 key）。
/// Rust 侧就绪判定为对 models/llm 指定文件直接 stat（零扫描）。
/// GGUF 对话模型（Qwen3.8/Spark-X2.5/MiniCPM5）内置支持已移除（2026-09-10），
/// 目录返回空 → 映射表留空兜底。
const GGUF_SLOT_KEY_BY_CATALOG: Record<string, string> = {};
const GGUF_CATALOG_KEY_BY_SLOT: Record<string, string> = Object.fromEntries(
  Object.entries(GGUF_SLOT_KEY_BY_CATALOG).map(([catalogKey, slotKey]) => [slotKey, catalogKey]),
);

/// RWKV 3B 首次初始化自动下载已拉起标记（模块级——多实例共享，全应用一次）。
let rwkv3bAutoDownloadStarted = false;

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
  /** 整体禁用（Agent 回合运行中不允许切换模型）。 */
  disabled?: boolean;
  /**
   * 受控值在本组件模型域里解析不出时的展示名。
   *
   * 典型场景：dsh 会话模型（如 `ai00s:<子模型>`）属于引擎目录，而本组件列出的是
   * 应用配置里的模型；此时用引擎目录里的可读名展示，避免露出裸 id。
   */
  displayLabel?: string | null;
  /**
   * 引擎目录里真正可用的模型引用（受控模式下用）。
   *
   * 服务端模型目录包含「服务器有、本机引擎还没配置路由」的条目；受控模式会把选择
   * 写进 dsh 会话，选到这类条目必然被 `session/model-unavailable` 拒绝。
   * 传了该列表就只展示引擎可用的子模型（`ai00s:<id>` 或裸 id 均可匹配）。
   */
  allowedModelRefs?: string[] | null;
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
  // currentMode 参数随 per-mode 模型覆盖（ai.agent_models）移除不再使用（接口保留兼容既有调用方）
  className = '',
  // sessionId 参数已随本地多档位移除不再使用（接口保留兼容既有调用方）
  currentTokens = 0,
  maxTokens = 0,
  controlledValue,
  onControlledSelect,
  disabled = false,
  displayLabel = null,
  allowedModelRefs = null,
}) => {
  const { t } = useTranslation('flow-chat');
  // 受控模式（策窗口复用）：选择只回调，不写全局配置
  const isControlled = !!onControlledSelect;
  const [allModels, setAllModels] = useState<AIModelConfig[]>([]);
  const [defaultModels, setDefaultModels] = useState<Record<string, string>>({});
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [userTier, setUserTier] = useState<string | null>(null);
  const [userPlan, setUserPlan] = useState<UserPlanInfo | null>(null);
  const [ai00ApiModels, setAi00ApiModels] = useState<Ai00sModelInfo[]>([]);
  const [upgradeDialog, setUpgradeDialog] = useState<{ modelName: string; requiredTier: string } | null>(null);
  // 本地模型目录（就绪/进度/解析路径，来自 Rust 内置目录：3B 必需 + 7B/13B 可选）
  const [localCatalog, setLocalCatalog] = useState<Record<string, {
    ready: boolean; progress: number | null; required?: boolean; available?: boolean;
    resolvedModelPath?: string; resolvedVocabPath?: string; resolvedGgufPath?: string;
  }>>({});
  const localDownloadPollRef = useRef<number | null>(null);

  const autoSelectedRef = useRef(false);

  /** 拉取本地模型内置目录（RWKV 3B/7B/13B + Qwen3.8 27B）的就绪状态与可用路径。 */
  const refreshLocalCatalog = useCallback(async () => {
    try {
      const [rwkvCat, ggufCat] = await Promise.all([
        invoke<{
          key: string; display?: string; downloaded: boolean; required?: boolean; available?: boolean;
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
            required: e.required ?? false,
            available: e.available ?? true,
            resolvedModelPath: e.resolved_model_path,
            resolvedVocabPath: e.resolved_vocab_path,
          };
        }
        // 内置 GGUF 目录（Rust 侧 stat models/llm 指定文件，零扫描）映射到本地槽位 key
        for (const e of ggufCat) {
          const slotKey = GGUF_SLOT_KEY_BY_CATALOG[e.key];
          if (!slotKey) continue;
          next[slotKey] = {
            ready: e.downloaded,
            progress: e.downloaded ? null : (prev[slotKey]?.progress ?? null),
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
        const catalogKey = GGUF_CATALOG_KEY_BY_SLOT[slotKey];
        if (!catalogKey) {
          log.warn('No builtin catalog key for local slot', { slotKey });
          return;
        }
        taskIds = [await invoke<string>('gguf_builtin_download', { key: catalogKey })];
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
      const [models, defaultModelsData] = await Promise.all([
        configManager.getConfig<AIModelConfig[]>('ai.models') || [],
        configManager.getConfig<any>('ai.default_models') || {},
      ]);

      setAllModels(models);
      setDefaultModels(defaultModelsData);

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

  // 第一次初始化自动下载本地模型（仅 RWKV 3B，全应用一次）：
  // 本地 RWKV 是常驻引擎（智能路由 R0/R1、本地工具轮、混合循环都靠它），
  // 目录加载后发现未就绪即拉起下载——用户无需手动触发。
  useEffect(() => {
    if (rwkv3bAutoDownloadStarted) return;
    const entry = localCatalog['rwkv-3b'];
    if (!entry) return; // 目录尚未加载
    if (entry.ready || entry.progress !== null) return;
    rwkv3bAutoDownloadStarted = true;
    log.info('Auto-downloading local RWKV 3B on first init');
    void startLocalDownload('rwkv-3b');
  }, [localCatalog, startLocalDownload]);

  // 受控模式的 primary 来自调用方；非受控来自全局配置
  const primaryModelId = isControlled ? (controlledValue ?? null) : (defaultModels.primary || null);

  /// 当前生效模型的展示信息（受控/非受控统一按 primaryModelId 解析：
  /// ai00s 复合引用 → 服务器列表；自定义 id → ai.models；空/自动 → 默认态）
  const currentModel = useMemo((): ModelInfo | null => {
    const ref = primaryModelId;
    if (!ref || ref === 'auto') return buildAutoModelInfo(t);
    if (ref.startsWith('ai00s:')) {
      const sub = ref.slice('ai00s:'.length);
      const m = ai00ApiModels.find(x => x.id === sub);
      if (!m) return null;
      return {
        id: ref,
        configName: m.displayName,
        modelName: m.displayName,
        providerName: 'Ai00-API',
        provider: 'ai00s',
      };
    }
    const model = allModels.find(m => m.id === ref);
    if (!model) {
      // 引擎侧模型（如 ai00-api）：用调用方给的目录展示名，别露出裸 id
      if (isControlled && displayLabel) {
        return {
          id: ref,
          configName: displayLabel,
          modelName: displayLabel,
          providerName: 'Ai00-X',
          provider: 'ai00-x',
        };
      }
      return null;
    }
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
  }, [primaryModelId, allModels, ai00ApiModels, t, isControlled, displayLabel]);

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

  /// 用户自定义远程 API 模型（排除本地模型）；ai00s 作为 Ai00-API 入口，不在此列表。
  /// 受控模式 = 写入 dsh 会话模型：引擎只认识网关通告的 `ai00-api` / `rwkv-local` /
  /// `ai00s:<子模型>`，选自定义 API 模型必然被 `session/model-unavailable` 拒绝，
  /// 因此在这种场景不展示（避免「点了没反应 / 报错」的假选项）。
  const customApiModels = useMemo((): ModelInfo[] => {
    if (isControlled) return [];
    return customModels.filter(m =>
      !((m.provider || '').trim().toLowerCase() === 'rwkv' || m.id.startsWith('gguf-local:'))
    );
  }, [customModels, isControlled]);

  const handleSelectModel = useCallback(async (modelId: string) => {
    if (loading) return;

    // 受控模式：只回调调用方（策窗口局部持久化），不写全局配置
    if (isControlled) {
      onControlledSelect?.(modelId);
      setDropdownOpen(false);
      return;
    }

    setLoading(true);
    try {
      const currentDefaultModels = await configManager.getConfig<any>('ai.default_models') || {};
      await configManager.setConfig('ai.default_models', {
        ...currentDefaultModels,
        primary: modelId,
      });
      setDefaultModels(prev => ({ ...prev, primary: modelId }));

      log.info('Primary model updated', { modelId });

      globalEventBus.emit('mode:config:updated');

      setDropdownOpen(false);
    } catch (error) {
      log.error('Failed to switch model', error);
    } finally {
      setLoading(false);
    }
  }, [loading, isControlled, onControlledSelect]);

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

  /// 本地模型槽位：RWKV 3B 为必需档位（本地协同默认模型，首次初始化自动下载）；
  /// 7B/13B 为可选档位，只在这里按需下载，不影响引擎默认加载的 3B。
  const localSlots = useMemo(() => {
    const cat = (key: string) =>
      localCatalog[key] ?? { ready: false, progress: null as number | null, required: false, available: true };
    const slot = (key: string, label: string) => {
      const { ready, progress, required, available } = cat(key);
      return {
        key,
        label,
        ready,
        progress,
        required: required ?? false,
        available: available ?? true,
        ref: ready && required ? 'rwkv-local' : null,
      };
    };

    return [
      slot('rwkv-3b', 'RWKV 3B'),
      slot('rwkv-7b', 'RWKV 7B'),
      slot('rwkv-13b', 'RWKV 13B'),
    ];
  }, [localCatalog]);

  /// 实际可选的 Ai00-API 子模型：受控模式只保留引擎目录里可路由的条目。
  /// 例外：服务端标记 `locked` 的模型仍然展示（灰显 + 锁 + 升级提示）。
  /// 引擎侧只通告未锁定的子模型，若把 locked 一并过滤掉，用户会以为「服务器没有
  /// 这个模型」（实测测试服 deepseek-v4.1-flash 就是 locked=true 被静默隐藏）；
  /// 展示出来点击走升级引导，不会切到引擎不可路由的模型。
  const routableApiModels = useMemo(() => {
    if (!isControlled || !allowedModelRefs || allowedModelRefs.length === 0) {
      return ai00ApiModels;
    }
    const allowed = new Set(allowedModelRefs);
    return ai00ApiModels.filter(
      m => m.locked === true || allowed.has(`ai00s:${m.id}`) || allowed.has(m.id),
    );
  }, [ai00ApiModels, allowedModelRefs, isControlled]);

  /// Phase 5.1: 是否免费层用户（用于显示升级提示）
  const isFreeUser = useMemo(() => {
    return isFreeTier(userPlan?.planTier ?? userTier);
  }, [userPlan, userTier]);

  /// 选择 Ai00-API 子模型
  /// - 优先检查额度（exhausted 时阻止选择）
  /// - 兼容旧的 tier 检查（canAccessModel）
  const handleSelectAi00ApiModel = useCallback(async (apiModel: Ai00sModelInfo) => {
    if (loading) return;

    // 额度用完阻止选择
    if (!isModelSelectable(apiModel)) {
      log.info('Free model quota exhausted, selection blocked', { modelId: apiModel.id });
      return;
    }

    // locked：当前套餐不可用（新体系后端下发 locked；旧体系兜底按 tier rank）→ 弹升级提示
    // 受控模式（工作台/策等引擎会话）同样先拦：locked 模型网关不会通告给引擎，
    // 直接下发切换只会拿到 session/model-unavailable，界面还得回滚。
    if (!canAccessModel(apiModel, userTier)) {
      setUpgradeDialog({
        modelName: apiModel.displayName,
        requiredTier: apiModel.tier,
      });
      return;
    }

    // 受控模式：只回调复合引用，不写全局配置
    if (isControlled) {
      onControlledSelect?.(`ai00s:${apiModel.id}`);
      setDropdownOpen(false);
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

      log.info('Ai00-API sub-model selected', { subModelId: apiModel.id });

      globalEventBus.emit('mode:config:updated');

      setDropdownOpen(false);
    } catch (error) {
      log.error('Failed to switch Ai00-API sub-model', error);
    } finally {
      setLoading(false);
    }
  }, [loading, userTier, isControlled, onControlledSelect]);

  /// 远程模型必须选一个：未选过 / 遗留本地 primary / ai00s 占位或子模型无效时，
  /// 自动选中服务器标注的默认模型（isDefault），无默认则选第一个可访问模型。
  /// 仅执行一次，避免覆盖用户手动选择。
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (isControlled) return;
    if (ai00ApiModels.length === 0) return;

    const currentSubModelId = primaryModelId?.startsWith('ai00s:')
      ? primaryModelId.slice('ai00s:'.length)
      : (allModels.find(m => m.id === 'ai00s')?.model_name || '');
    const ai00sInvalid = !!primaryModelId && isAi00sModel(primaryModelId)
      && (currentSubModelId === '' || currentSubModelId === 'ai00s'
        || !ai00ApiModels.some(m => m.id === currentSubModelId));
    // 「自动」不再是可选项：遗留本地 primary（rwkv-local / gguf-local）或未选过
    // 一律自动选一个远程默认——本地 RWKV 是常驻引擎，不再作为对话模型候选
    const legacyLocalPrimary = primaryModelId === 'rwkv-local'
      || !!primaryModelId?.startsWith('gguf-local:');
    const needsPick = !primaryModelId || legacyLocalPrimary || ai00sInvalid;
    if (!needsPick) return;

    autoSelectedRef.current = true;
    // 优先选服务器标注的默认模型，否则第一个可访问（未锁定）的模型
    const defaultModel = ai00ApiModels.find(m => m.isDefault && !m.locked)
      || ai00ApiModels.find(m => m.isUpstreamFree && !m.locked)
      || ai00ApiModels.find(m => !m.locked)
      || ai00ApiModels[0];
    if (defaultModel) {
      log.info('Auto-selecting server default model', { modelId: defaultModel.id });
      void handleSelectAi00ApiModel(defaultModel);
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

  /// 触发器显示名：统一按 currentModel 解析（空/未解析出 → 「自动」默认态）
  const triggerLabel = useMemo((): string => {
    if (currentModel && currentModel.id !== 'auto') {
      return currentModel.modelName || currentModel.configName;
    }
    // currentModel 解析不出（如 ai00s 子模型不在列表）时按引用回落
    const ref = primaryModelId;
    if (ref && ref !== 'auto') {
      if (ref.startsWith('ai00s:')) {
        const sub = ref.slice('ai00s:'.length);
        return ai00ApiModels.find(m => m.id === sub)?.displayName || sub;
      }
      const hit = allModels.find(m => m.id === ref);
      if (hit) return hit.model_name || hit.name;
      return ref;
    }
    return t('modelSelector.autoModel');
  }, [currentModel, primaryModelId, ai00ApiModels, allModels, t]);

  if (!isControlled && availableModels.length === 0 && ai00ApiModels.length === 0) {
    return null;
  }

  const baseTooltip = currentModel
    ? buildResolvedModelTooltipText(currentModel.modelName, currentModel, t('modelSelector.autoModelDesc'))
    : t('modelSelector.autoModelDesc');
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
              disabled={loading || disabled}
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
          {/* 本地模型：RWKV 3B 为必需档位（本地协同默认，自动下载），
              7B/13B 为可选档位，点行按需下载；未上架档位只做占位说明 */}
          <div className="ai00-x-model-selector__section-title">
            {t('modelSelector.localModels.sectionTitle')}
          </div>
          <div className="ai00-x-model-selector__list">
            {localSlots.map(slot => {
              const downloading = !slot.ready && slot.progress !== null;
              const slotTooltip = !slot.available
                ? `${slot.label} · ${t('modelSelector.localModels.unavailable')}`
                : slot.ready
                  ? slot.required
                    ? `${slot.label} · ${t('modelSelector.localModels.defaultBadge')}`
                    : `${slot.label} · ${t('modelSelector.localModels.downloaded')}`
                  : downloading
                    ? `${slot.label} · ${t('modelSelector.localModels.downloading')} ${slot.progress}%`
                    : t('modelSelector.localModels.notReady');
              const statusText = !slot.available
                ? t('modelSelector.localModels.unavailable')
                : downloading
                  ? `${slot.progress}%`
                  : (slot.ready
                    ? (slot.required ? null : t('modelSelector.localModels.downloaded'))
                    : t('modelSelector.localModels.downloadNow'));

              const actionable = slot.available && !slot.ready && !downloading;
              return (
                <Tooltip key={slot.key} content={slotTooltip} placement="right">
                  <div
                    className={`ai00-x-model-selector__option ${
                      !slot.available
                        ? 'ai00-x-model-selector__option--disabled'
                        : actionable || downloading
                          ? 'ai00-x-model-selector__option--downloadable'
                          : ''
                    }`}
                    role={actionable ? 'button' : undefined}
                    tabIndex={actionable ? 0 : -1}
                    aria-disabled={!actionable || undefined}
                    onClick={() => {
                      // 本地模型是常驻引擎状态行（非对话模型候选）：
                      // 可选档位未就绪时点行拉起下载；已就绪/未上架点击无操作
                      if (actionable) void startLocalDownload(slot.key);
                    }}
                    onKeyDown={(e) => {
                      if (!actionable) return;
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      void startLocalDownload(slot.key);
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
                        {slot.required && (
                          <span className="ai00-x-model-selector__option-tag">
                            {t('modelSelector.localModels.defaultBadge')}
                          </span>
                        )}
                      </div>
                    </div>
                    {statusText && (
                      <span className="ai00-x-model-selector__option-multiplier">
                        {statusText}
                      </span>
                    )}
                    {slot.required && (
                      <Check size={14} className="ai00-x-model-selector__option-check" />
                    )}
                  </div>
                </Tooltip>
              );
            })}
          </div>

          {/* Ai00-API：服务器下发的模型列表 + 消耗倍率（远程模型必须选一个） */}
          {routableApiModels.length > 0 && (
            <>
              <div className="ai00-x-model-selector__section-title">
                {t('modelSelector.xfModels.sectionTitle')}
              </div>
              <div className="ai00-x-model-selector__list">
                {routableApiModels.map(apiModel => {
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

          {/* 自定义模型API */}
          {customApiModels.length > 0 && (
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
