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
import { Cpu, ChevronDown, ChevronRight, Check, Sparkles, Lock, Rocket, Coins, Pencil, Trash2, Copy, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { dshEngine } from '@/infrastructure/api/service-api/DshAPI';
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
import { Tooltip, Popover, PopoverTrigger, PopoverAnchor, PopoverContent } from '@/component-library';
import { createLogger } from '@/shared/utils/logger';
import { notificationService } from '@/shared/notification-system';
import ModelProfileDialog from '@/agent/ModelProfileDialog';
import {
  applyModelProfile,
  deleteProfile,
  getActiveProfileId,
  listProfiles,
  resolveProfileModels,
  saveProfile,
  setActiveProfileId as persistActiveProfileId,
  type AgentModelProfile,
} from '@/agent/modelProfiles';
import { quickActions } from '@/shared/services/ide-control/api';
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
   * 组合应用后的回调（宿主可刷新会话模型投影；不传时只做应用与提示）。
   */
  onProfileApplied?: (profile: AgentModelProfile) => void;
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
  /**
   * 是否在触发器上显示推理档位徽标（默认显示）。
   *
   * composer 里档位由独立的「思考档位」控件表达，避免与引擎会话档位重复展示。
   */
  showEffortBadge?: boolean;
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

interface ModelDetailItem {
  label: string;
  value: string;
}

/**
 * 模型详细信息卡（悬停二级弹层内容）。
 * 只做展示：模型名 + 元信息 + 键值明细，样式全部走设计令牌。
 */
const ModelDetailCard: React.FC<{
  title: string;
  meta?: string;
  items: ModelDetailItem[];
}> = ({ title, meta, items }) => (
  <div className="ai00-x-model-selector__detail">
    <div className="ai00-x-model-selector__detail-title">{title}</div>
    {meta && <div className="ai00-x-model-selector__detail-meta">{meta}</div>}
    {items.length > 0 && (
      <div className="ai00-x-model-selector__detail-grid">
        {items.map(item => (
          <div key={item.label} className="ai00-x-model-selector__detail-item">
            <span className="ai00-x-model-selector__detail-label">{item.label}</span>
            <span className="ai00-x-model-selector__detail-value">{item.value}</span>
          </div>
        ))}
      </div>
    )}
  </div>
);

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  // currentMode 参数随 per-mode 模型覆盖（ai.agent_models）移除不再使用（接口保留兼容既有调用方）
  className = '',
  // 会话绑定：组合应用时把规划模型切到该会话（无会话则只保存偏好）
  sessionId,
  currentTokens = 0,
  maxTokens = 0,
  controlledValue,
  onControlledSelect,
  disabled = false,
  onProfileApplied,
  displayLabel = null,
  allowedModelRefs = null,
  showEffortBadge = true,
}) => {
  const { t } = useTranslation('flow-chat');
  // 受控模式（策窗口复用）：选择只回调，不写全局配置
  const isControlled = !!onControlledSelect;
  const [profiles, setProfiles] = useState<AgentModelProfile[]>(() => listProfiles());
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() =>
    getActiveProfileId(),
  );
  const [profileDialog, setProfileDialog] = useState<{
    open: boolean;
    profile: AgentModelProfile | null;
  }>({ open: false, profile: null });
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

  // 悬停二级弹层：当前展开详情的行 id（api:/local:/custom: 前缀区分来源）
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailCloseTimerRef = useRef<number | null>(null);
  const detailIdRef = useRef<string | null>(null);

  // 「单一模型」二级菜单（本地 / Ai00-API / 自定义模型）
  const [singleMenuOpen, setSingleMenuOpen] = useState(false);
  const singleMenuTimerRef = useRef<number | null>(null);

  const openDetail = useCallback((id: string) => {
    if (detailCloseTimerRef.current !== null) {
      window.clearTimeout(detailCloseTimerRef.current);
      detailCloseTimerRef.current = null;
    }
    detailIdRef.current = id;
    setDetailId(current => (current === id ? current : id));
  }, []);

  const scheduleCloseDetail = useCallback(() => {
    if (detailCloseTimerRef.current !== null) window.clearTimeout(detailCloseTimerRef.current);
    detailCloseTimerRef.current = window.setTimeout(() => {
      detailCloseTimerRef.current = null;
      detailIdRef.current = null;
      setDetailId(null);
    }, 120);
  }, []);

  const openSingleMenu = useCallback(() => {
    if (singleMenuTimerRef.current !== null) {
      window.clearTimeout(singleMenuTimerRef.current);
      singleMenuTimerRef.current = null;
    }
    setSingleMenuOpen(true);
  }, []);

  const scheduleCloseSingleMenu = useCallback(() => {
    if (singleMenuTimerRef.current !== null) window.clearTimeout(singleMenuTimerRef.current);
    singleMenuTimerRef.current = window.setTimeout(() => {
      singleMenuTimerRef.current = null;
      // 详情卡还开着（鼠标停在某个模型行上）时先不关，等它自己收起
      if (detailIdRef.current) {
        scheduleCloseSingleMenu();
        return;
      }
      setSingleMenuOpen(false);
    }, 200);
  }, []);

  useEffect(() => {
    if (!dropdownOpen) {
      setDetailId(null);
      detailIdRef.current = null;
      setSingleMenuOpen(false);
    }
  }, [dropdownOpen]);

  useEffect(() => () => {
    if (detailCloseTimerRef.current !== null) window.clearTimeout(detailCloseTimerRef.current);
    if (singleMenuTimerRef.current !== null) window.clearTimeout(singleMenuTimerRef.current);
  }, []);

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

  /// 服务器默认的 Ai00-API 子模型（`ai00-api` 网关主模型槽的落点）
  const defaultApiModel = useMemo(
    () =>
      ai00ApiModels.find(m => m.isDefault && !m.locked)
      ?? ai00ApiModels.find(m => !m.locked)
      ?? ai00ApiModels[0]
      ?? null,
    [ai00ApiModels],
  );

  /// 模型引用 → 可读名（组合摘要 / 触发器共用；不再露裸 id）
  const describeModelRef = useCallback((ref: string): string => {
    if (!ref) return '';
    if (ref === 'ai00-api' || ref === 'ai00-salvo') return defaultApiModel?.displayName ?? 'Ai00-API 默认';
    if (ref === 'ai00-auto' || ref === 'auto') return '智能路由';
    if (ref === 'rwkv-local') return '本地 RWKV';
    if (ref.startsWith('ai00s:')) {
      const sub = ref.slice('ai00s:'.length);
      return ai00ApiModels.find(m => m.id === sub)?.displayName ?? sub;
    }
    const hit = allModels.find(m => m.id === ref);
    return hit?.name || hit?.model_name || ref;
  }, [defaultApiModel, ai00ApiModels, allModels]);

  /// 当前生效模型的展示信息（受控/非受控统一按 primaryModelId 解析：
  /// ai00s 复合引用 → 服务器列表；ai00-api 主模型槽 → 服务器默认子模型；
  /// 自定义 id → ai.models；空/自动 → 默认态）
  const currentModel = useMemo((): ModelInfo | null => {
    const ref = primaryModelId;
    if (!ref || ref === 'auto') return buildAutoModelInfo(t);
    if (ref === 'ai00-api' || ref === 'ai00-salvo') {
      // 网关主模型槽：跟随服务端 is_default，展示真实子模型名而非裸引用
      return {
        id: ref,
        configName: defaultApiModel?.displayName ?? 'Ai00-API 默认',
        modelName: defaultApiModel?.displayName ?? 'Ai00-API 默认',
        providerName: 'Ai00-API',
        provider: 'ai00s',
      };
    }
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
  }, [primaryModelId, allModels, ai00ApiModels, defaultApiModel, t, isControlled, displayLabel]);

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
    return availableModels.filter(
      m => !isAi00sModel(m.id) && (m.provider || '').trim().toLowerCase() !== 'ai00s',
    );
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

  /// 内置组合的动态占位引用（最低/最高倍率）按当前目录解析后再展示与应用
  const resolvedProfiles = useMemo(
    () => profiles.map(profile => ({
      ...profile,
      models: resolveProfileModels(profile, ai00ApiModels),
    })),
    [profiles, ai00ApiModels],
  );

  /// 当前生效的组合（组合模式下「单一模型」分组不再显示勾选，二者互斥）
  const activeProfile = useMemo(
    () => resolvedProfiles.find(profile => profile.id === activeProfileId) ?? null,
    [resolvedProfiles, activeProfileId],
  );

  const handleSelectModel = useCallback(async (modelId: string) => {
    if (loading) return;

    // 选具体模型 = 退出组合模式（受控/非受控都要清，避免组合勾选与触发器不一致）
    persistActiveProfileId(null);
    setActiveProfileId(null);

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

  /**
   * 选本地常驻模型（RWKV 3B）作为单一模型。
   * 7B/13B 只是可选下载档位，引擎不加载，不能当对话模型。
   */
  const handleSelectLocalModel = useCallback(async () => {
    if (loading) return;

    persistActiveProfileId(null);
    setActiveProfileId(null);

    if (isControlled) {
      onControlledSelect?.('rwkv-local');
      setDropdownOpen(false);
      return;
    }

    setLoading(true);
    try {
      const currentDefaultModels = await configManager.getConfig<any>('ai.default_models') || {};
      await configManager.setConfig('ai.default_models', {
        ...currentDefaultModels,
        primary: 'rwkv-local',
      });
      setDefaultModels(prev => ({ ...prev, primary: 'rwkv-local' }));
      log.info('Primary model switched to local RWKV');
      globalEventBus.emit('mode:config:updated');
      setDropdownOpen(false);
    } catch (error) {
      log.error('Failed to switch to local model', error);
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
      persistActiveProfileId(null);
      setActiveProfileId(null);
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

      // 选具体模型 = 退出组合模式，避免组合勾选与实际模型不一致
      persistActiveProfileId(null);
      setActiveProfileId(null);

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

  /** 选组合：写工人模型 + 切换当前会话规划模型，必要时重启引擎装载新 preset。 */
  const handleSelectProfile = useCallback(
    async (profile: AgentModelProfile): Promise<void> => {
      setDropdownOpen(false);
      try {
        const result = await applyModelProfile(profile, { sessionId: sessionId ?? null });
        setActiveProfileId(profile.id);
        if (isControlled && onControlledSelect) {
          // 工人模型改动会触发引擎重启：等引擎就绪再切会话模型，否则切换必然被拒
          if (result.workersChanged) {
            try {
              await dshEngine.ensureReady();
            } catch {
              // 引擎起不来时仍尝试切换，失败由宿主回调提示
            }
          }
          onControlledSelect(profile.models.plan);
        }
        onProfileApplied?.(profile);
        if (result.workersError) {
          notificationService.warning(
            `组合「${profile.name}」已保存，但工人模型写入失败：${result.workersError}`,
          );
        } else if (result.restartRequired) {
          notificationService.warning('模型组合已保存；有会话正在运行，稍后重启引擎生效');
        } else if (result.workersChanged) {
          notificationService.success(`已应用组合「${profile.name}」（引擎已重载）`);
        } else {
          notificationService.success(`已应用组合「${profile.name}」`);
        }
      } catch (error) {
        notificationService.error(
          `应用组合失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [isControlled, onControlledSelect, onProfileApplied, sessionId],
  );

  /** 编辑自定义组合（内置组合只能另存为）。 */
  const handleEditProfile = useCallback((profile: AgentModelProfile) => {
    setDropdownOpen(false);
    setProfileDialog({ open: true, profile });
  }, []);

  /** 删除自定义组合；删的是当前生效组合时一并退出组合模式。 */
  const handleDeleteProfile = useCallback((profile: AgentModelProfile) => {
    deleteProfile(profile.id);
    setProfiles(listProfiles());
    if (getActiveProfileId() === profile.id) {
      persistActiveProfileId(null);
      setActiveProfileId(null);
    }
    notificationService.success(`已删除组合「${profile.name}」`);
  }, []);

  /**
   * 打开「自定义 API」管理页。
   *
   * 设置页只存在于主窗口：工作台/策等独立窗口里 `openScene('settings')` 没有
   * 对应路由（会落回本窗口的场景列表，看起来像「页面不对」）。因此这里先唤起
   * 主窗口，再广播 `open-settings-scene`（主窗口监听后切到「AI 模型」页）。
   */
  const openCustomApiManagement = useCallback(async () => {
    setDropdownOpen(false);
    try {
      const [{ invoke }, { emit }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/event'),
      ]);
      await invoke('show_main_window');
      await emit('open-settings-scene', { tab: 'models' });
    } catch (error) {
      log.warn('Failed to open settings in main window, falling back to local scene', error);
      quickActions.openSettings('models');
    }
  }, []);

  /** 内置组合「另存为」：复制成可编辑的同内容自定义组合。 */
  const handleDuplicateProfile = useCallback((profile: AgentModelProfile) => {
    const copy = saveProfile({
      id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${profile.name} 副本`,
      models: { ...profile.models },
    });
    setProfiles(listProfiles());
    notificationService.success(`已另存为「${copy.name}」，可继续编辑`);
  }, []);

  const tokenStatusClass = useMemo(() => {
    if (tokenPercentage >= 90) return 'critical';
    if (tokenPercentage >= 70) return 'warning';
    return '';
  }, [tokenPercentage]);

  const formatTokenCount = (n: number) =>
    n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;

  /// 触发器显示名：统一按 currentModel 解析（空/未解析出 → 「自动」默认态）
  const triggerLabel = useMemo((): string => {
    // 组合生效时直接显示组合名——组合是「按阶段分配模型」，露单个模型名会误导
    if (activeProfile) return activeProfile.name;

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
  }, [activeProfile, currentModel, primaryModelId, ai00ApiModels, allModels, t]);

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
              <Cpu size={16} className="ai00-x-model-selector__icon" />
              <span className="ai00-x-model-selector__name">
                {triggerLabel}
              </span>
              {currentModel?.enableThinking && (
                <Sparkles size={12} className="ai00-x-model-selector__thinking-icon" />
              )}
              {showEffortBadge && currentModel?.reasoningEffort && (
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
          {/* 模型组合：按阶段分配模型（规划/执行/评审/兜底/调研），
              既支持本地+云端，也支持云端高低价模型混搭 */}
          <div className="ai00-x-model-selector__section-title">
            模型组合
          </div>
          <div className="ai00-x-model-selector__list">
            {resolvedProfiles.map(profile => {
              const selected = activeProfileId === profile.id;
              const summary = `规划 ${describeModelRef(profile.models.plan)} · 执行 ${describeModelRef(profile.models.execute)} · 评审 ${describeModelRef(profile.models.review)}`;
              return (
                <div
                  key={profile.id}
                  className={`ai00-x-model-selector__option ${selected ? 'ai00-x-model-selector__option--selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => void handleSelectProfile(profile)}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    void handleSelectProfile(profile);
                  }}
                >
                  <span className="ai00-x-model-selector__option-avatar" aria-hidden="true">
                    {profile.name.charAt(0)}
                  </span>
                  <div className="ai00-x-model-selector__option-main">
                    <div className="ai00-x-model-selector__option-title">
                      <span className="ai00-x-model-selector__option-name">{profile.name}</span>
                      {profile.builtin && (
                        <span className="ai00-x-model-selector__option-tag">预设</span>
                      )}
                    </div>
                    <span
                      className="ai00-x-model-selector__option-multiplier ai00-x-model-selector__option-multiplier--summary"
                      title={summary}
                    >
                      {summary}
                    </span>
                  </div>
                  <div className="ai00-x-model-selector__option-actions">
                    {profile.builtin ? (
                      <button
                        type="button"
                        className="ai00-x-model-selector__option-action"
                        title="另存为自定义组合"
                        onClick={event => {
                          event.stopPropagation();
                          handleDuplicateProfile(profile);
                        }}
                      >
                        <Copy size={12} />
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="ai00-x-model-selector__option-action"
                          title="编辑组合"
                          onClick={event => {
                            event.stopPropagation();
                            handleEditProfile(profile);
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          className="ai00-x-model-selector__option-action ai00-x-model-selector__option-action--danger"
                          title="删除组合"
                          onClick={event => {
                            event.stopPropagation();
                            handleDeleteProfile(profile);
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </div>
                  {selected && (
                    <Check size={14} className="ai00-x-model-selector__option-check" />
                  )}
                </div>
              );
            })}
            <div
              className="ai00-x-model-selector__option"
              role="button"
              tabIndex={0}
              onClick={() => {
                setDropdownOpen(false);
                setProfileDialog({ open: true, profile: null });
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                setDropdownOpen(false);
                setProfileDialog({ open: true, profile: null });
              }}
            >
              <span className="ai00-x-model-selector__option-avatar" aria-hidden="true">
                +
              </span>
              <div className="ai00-x-model-selector__option-main">
                <div className="ai00-x-model-selector__option-title">
                  <span className="ai00-x-model-selector__option-name">新建组合…</span>
                </div>
                <span className="ai00-x-model-selector__option-multiplier ai00-x-model-selector__option-multiplier--summary">
                  每个阶段单独选模型（含本地与云端）
                </span>
              </div>
            </div>
          </div>

          {/* 单一模型：本地 / Ai00-API / 自定义模型收进二级菜单，
              主菜单只保留组合与这一个入口 */}
          <div className="ai00-x-model-selector__section-title">
            单一模型
          </div>
          <Popover
            open={singleMenuOpen}
            modal={false}
            onOpenChange={next => {
              if (!next) setSingleMenuOpen(false);
            }}
          >
            <PopoverAnchor asChild>
              <div
                className="ai00-x-model-selector__option ai00-x-model-selector__option--submenu"
                role="button"
                tabIndex={0}
                aria-haspopup="menu"
                aria-expanded={singleMenuOpen}
                onMouseEnter={openSingleMenu}
                onMouseLeave={scheduleCloseSingleMenu}
                onClick={openSingleMenu}
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  openSingleMenu();
                }}
              >
                <span className="ai00-x-model-selector__option-avatar" aria-hidden="true">
                  <Cpu size={12} />
                </span>
                <div className="ai00-x-model-selector__option-main">
                  <div className="ai00-x-model-selector__option-title">
                    <span className="ai00-x-model-selector__option-name">选单个模型</span>
                  </div>
                  <span className="ai00-x-model-selector__option-multiplier ai00-x-model-selector__option-multiplier--summary">
                    当前：{currentModel?.modelName ?? '未选择'}
                  </span>
                </div>
                <ChevronRight size={12} className="ai00-x-model-selector__option-chevron" />
              </div>
            </PopoverAnchor>
            <PopoverContent
              side="right"
              align="start"
              sideOffset={8}
              className="ai00-x-model-selector__submenu"
              onOpenAutoFocus={event => event.preventDefault()}
              onMouseEnter={openSingleMenu}
              onMouseLeave={scheduleCloseSingleMenu}
            >
              {activeProfile && (
                <div className="ai00-x-model-selector__submenu-hint">
                  组合「{activeProfile.name}」生效中；选任一模型会退出组合
                </div>
              )}
              {/* 本地模型：RWKV 3B 为必需档位（本地协同默认，自动下载），
                  7B/13B 为可选档位，点行按需下载；未上架档位只做占位说明 */}
              <div className="ai00-x-model-selector__section-title">
                {t('modelSelector.localModels.sectionTitle')}
              </div>
              <div className="ai00-x-model-selector__list">
            {localSlots.map(slot => {
              const downloading = !slot.ready && slot.progress !== null;
              const statusText = !slot.available
                ? t('modelSelector.localModels.unavailable')
                : downloading
                  ? `${slot.progress}%`
                  : (slot.ready
                    ? (slot.required ? null : t('modelSelector.localModels.downloaded'))
                    : t('modelSelector.localModels.downloadNow'));

              const actionable = slot.available && !slot.ready && !downloading;
              // 常驻档（3B）就绪后可作为「单一模型」被选中；7B/13B 只是下载档位
              const selectable = slot.required && slot.ready && slot.available;
              const interactive = actionable || selectable;
              const isSelectedLocal = selectable && !activeProfile && primaryModelId === 'rwkv-local';
              const detailKey = `local:${slot.key}`;
              const detailItems: ModelDetailItem[] = [
                {
                  label: '状态',
                  value: !slot.available
                    ? t('modelSelector.localModels.unavailable')
                    : downloading
                      ? `${t('modelSelector.localModels.downloading')} ${slot.progress}%`
                      : slot.ready
                        ? t('modelSelector.localModels.downloaded')
                        : t('modelSelector.localModels.notReady'),
                },
                {
                  label: '定位',
                  value: slot.required
                    ? '常驻引擎默认档（智能路由 / 本地工具轮），也可选为对话模型'
                    : '可选档位，按需下载，不参与常驻',
                },
              ];
              return (
                <Popover key={slot.key} open={detailId === detailKey} modal={false}>
                  <PopoverAnchor asChild>
                    <div
                      className={`ai00-x-model-selector__option ${isSelectedLocal ? 'ai00-x-model-selector__option--selected' : ''} ${
                        !slot.available
                          ? 'ai00-x-model-selector__option--disabled'
                          : actionable || downloading || selectable
                            ? 'ai00-x-model-selector__option--downloadable'
                            : ''
                      }`}
                      role={interactive ? 'button' : undefined}
                      tabIndex={interactive ? 0 : -1}
                      aria-disabled={!interactive || undefined}
                      aria-pressed={selectable ? isSelectedLocal : undefined}
                      onMouseEnter={() => openDetail(detailKey)}
                      onMouseLeave={scheduleCloseDetail}
                      onClick={() => {
                        // 未就绪的可选档位：点行拉起下载；就绪的常驻档：选为单一模型
                        if (actionable) void startLocalDownload(slot.key);
                        else if (selectable) void handleSelectLocalModel();
                      }}
                      onKeyDown={(e) => {
                        if (!interactive) return;
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        if (actionable) void startLocalDownload(slot.key);
                        else if (selectable) void handleSelectLocalModel();
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
                      {isSelectedLocal && (
                        <Check size={14} className="ai00-x-model-selector__option-check" />
                      )}
                    </div>
                  </PopoverAnchor>
                  <PopoverContent
                    side="right"
                    align="start"
                    sideOffset={8}
                    className="ai00-x-model-selector__detail-popover"
                    onOpenAutoFocus={event => event.preventDefault()}
                    onMouseEnter={() => openDetail(detailKey)}
                    onMouseLeave={scheduleCloseDetail}
                  >
                    <ModelDetailCard
                      title={slot.label}
                      meta={slot.required ? '本地常驻默认档' : '本地可选档位'}
                      items={detailItems}
                    />
                  </PopoverContent>
                </Popover>
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
                        const isSelected = !activeProfile && currentAi00ApiModelId === apiModel.id;
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
                        // 促销折扣（服务端手工配置，与会员折扣叠加；倍率已由服务端按促销后价计算）
                        const promo = apiModel.promoDiscount ?? 1;
                        const hasPromoDiscount = promo > 0 && promo < 1;
                        const promoZhe = hasPromoDiscount
                          ? String(parseFloat((promo * 10).toFixed(1)))
                          : '';
                        const promoPct = hasPromoDiscount ? Math.round((1 - promo) * 100) : 0;

                        // 悬停详情：倍率 / 折扣 / 额度 / 状态（元价格不再突出）
                        const detailKey = `api:${apiModel.id}`;
                        const detailMeta = [modalityLabel, apiModel.producer].filter(Boolean).join(' · ');
                        const detailItems: ModelDetailItem[] = [];
                        if (multiplierText) detailItems.push({ label: '消耗倍率', value: multiplierText });
                        if (hasMemberDiscount) {
                          detailItems.push({ label: '会员折扣', value: `${memberZhe} 折 · 省 ${memberPct}%` });
                        }
                        if (hasPromoDiscount) {
                          detailItems.push({ label: '限时促销', value: `${promoZhe} 折 · 省 ${promoPct}%` });
                        }
                        if (apiModel.isUpstreamFree) {
                          detailItems.push({ label: '今日免费额度', value: quotaText || '不限' });
                        }
                        detailItems.push({
                          label: '状态',
                          value: isExhausted
                            ? t('modelSelector.freeQuota.exhausted')
                            : isLocked
                              ? t('modelSelector.upgrade.locked')
                              : apiModel.isDefault
                                ? '服务器默认'
                                : '可用',
                        });

                        return (
                          <Popover key={apiModel.id} open={detailId === detailKey} modal={false}>
                            <PopoverAnchor asChild>
                              <div
                                className={`ai00-x-model-selector__option ${isSelected ? 'ai00-x-model-selector__option--selected' : ''} ${isExhausted ? 'ai00-x-model-selector__option--disabled' : ''} ${isLocked ? 'ai00-x-model-selector__option--locked' : ''}`}
                                onMouseEnter={() => openDetail(detailKey)}
                                onMouseLeave={scheduleCloseDetail}
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
                                    {hasPromoDiscount && (
                                      <span className="ai00-x-model-selector__option-tag ai00-x-model-selector__option-tag--promo">
                                        {t('modelSelector.badges.promoDiscount', { zhe: promoZhe, pct: promoPct })}
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
                            </PopoverAnchor>
                            <PopoverContent
                              side="right"
                              align="start"
                              sideOffset={8}
                              className="ai00-x-model-selector__detail-popover"
                              onOpenAutoFocus={event => event.preventDefault()}
                              onMouseEnter={() => openDetail(detailKey)}
                              onMouseLeave={scheduleCloseDetail}
                            >
                              <ModelDetailCard
                                title={apiModel.displayName}
                                meta={detailMeta}
                                items={detailItems}
                              />
                            </PopoverContent>
                          </Popover>
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

          {/* 自定义模型API：用户自建远程 API + 管理入口（内置 ai00s 载体不在此列） */}
          <div className="ai00-x-model-selector__section-title">
            {t('modelSelector.customModels.sectionTitle')}
          </div>
          <div className="ai00-x-model-selector__list">
            {customApiModels.map(model => {
              const isPrimary = !activeProfile && model.id === primaryModelId;
              const detailKey = `custom:${model.id}`;
              const detailItems: ModelDetailItem[] = [
                { label: '模型 ID', value: model.configName || model.id },
                { label: '上下文', value: formatContextWindow(model.contextWindow) ?? '—' },
                { label: '思考模式', value: model.enableThinking ? '开启' : '关闭' },
              ];

              return (
                <Popover key={model.id} open={detailId === detailKey} modal={false}>
                  <PopoverAnchor asChild>
                    <div
                      className={`ai00-x-model-selector__option ${isPrimary ? 'ai00-x-model-selector__option--selected' : ''}`}
                      onMouseEnter={() => openDetail(detailKey)}
                      onMouseLeave={scheduleCloseDetail}
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
                  </PopoverAnchor>
                  <PopoverContent
                    side="right"
                    align="start"
                    sideOffset={8}
                    className="ai00-x-model-selector__detail-popover"
                    onOpenAutoFocus={event => event.preventDefault()}
                    onMouseEnter={() => openDetail(detailKey)}
                    onMouseLeave={scheduleCloseDetail}
                  >
                    <ModelDetailCard
                      title={model.modelName}
                      meta={model.providerName}
                      items={detailItems}
                    />
                  </PopoverContent>
                </Popover>
              );
            })}
            <div
              className="ai00-x-model-selector__option ai00-x-model-selector__option--manage"
              role="button"
              tabIndex={0}
              onClick={() => {
                void openCustomApiManagement();
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                void openCustomApiManagement();
              }}
            >
              <span className="ai00-x-model-selector__option-avatar" aria-hidden="true">
                <SlidersHorizontal size={12} />
              </span>
              <div className="ai00-x-model-selector__option-main">
                <div className="ai00-x-model-selector__option-title">
                  <span className="ai00-x-model-selector__option-name">管理自定义 API…</span>
                </div>
              </div>
            </div>
              </div>
            </PopoverContent>
          </Popover>

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

      <ModelProfileDialog
        open={profileDialog.open}
        profile={profileDialog.profile}
        onClose={() => setProfileDialog({ open: false, profile: null })}
        onSaved={saved => {
          setProfiles(listProfiles());
          void handleSelectProfile(saved);
        }}
      />
    </Popover>
  );
};
export default ModelSelector;
