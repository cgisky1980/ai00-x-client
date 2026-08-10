/**
 * Model selector component.
 * Shows the active model and allows quick switching.
 *
 * Config linkage:
 * - Auto mode: system auto-routes between primary (complex) and fast (RWKV, locked)
 * - Selecting a model updates the primary model config
 * - Fast model is locked to RWKV Local
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Cpu, ChevronDown, Check, Sparkles, Lock, Zap, Crown, Rocket } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { getProviderDisplayName } from '@/infrastructure/config/services/modelConfigs';
import {
  isAi00sModel,
  getAi00sTier,
  fetchUserTier,
  setCachedTier,
  fetchAi00sModels,
  canAccessModel,
  fetchUserPlanInfo,
  setCachedUserPlan,
  isFreeTier,
  getModelPriceGroup,
  getFreeQuotaStatus,
  isModelSelectable,
  type Ai00sModelInfo,
  type UserPlanInfo,
  type ModelPriceGroup,
} from '@/infrastructure/config/services/ai00sTier';
import { getEffectiveReasoningMode, isReasoningVisiblyEnabled } from '@/infrastructure/config/utils/reasoning';
import { globalEventBus } from '@/infrastructure/event-bus';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { Tooltip } from '@/component-library';
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

/// Phase 5.1: 格式化模型价格（元/百万 tokens）
///
/// 返回简短文本：如 "0.5/1.5" 表示输入 0.5 元、输出 1.5 元（均为每百万 tokens）
const formatModelPrice = (model: Ai00sModelInfo): string => {
  if (!model.pricing) return '';
  const { input, output } = model.pricing;
  if (input === 0 && output === 0) return '';
  // 价格 < 1 时显示 2 位小数，>= 1 时显示 1 位
  const fmt = (v: number) => (v < 1 ? v.toFixed(2) : v.toFixed(1));
  return `${fmt(input)}/${fmt(output)}`;
};

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
}) => {
  const { t } = useTranslation('flow-chat');
  const [allModels, setAllModels] = useState<AIModelConfig[]>([]);
  const [defaultModels, setDefaultModels] = useState<Record<string, string>>({});
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [userTier, setUserTier] = useState<string | null>(null);
  const [userPlan, setUserPlan] = useState<UserPlanInfo | null>(null);
  const [xfModels, setXfModels] = useState<Ai00sModelInfo[]>([]);
  const [upgradeDialog, setUpgradeDialog] = useState<{ modelName: string; requiredTier: string } | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  const loadConfigData = useCallback(async () => {
    try {
      const [models, defaultModelsData, agentModelsData] = await Promise.all([
        configManager.getConfig<AIModelConfig[]>('ai.models') || [],
        configManager.getConfig<any>('ai.default_models') || {},
        configManager.getConfig<Record<string, string>>('ai.agent_models') || {}
      ]);

      setAllModels(models);
      setDefaultModels(defaultModelsData);
      setAgentModels(agentModelsData);

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

    // 拉取讯飞子模型列表（带 tier + 定价 + 限流）
    try {
      const xfList = await fetchAi00sModels();
      setXfModels(xfList);
    } catch (err) {
      log.warn('Failed to fetch xunfei models', err);
    }
  }, []);

  useEffect(() => {
    loadConfigData();

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
    };
  }, [loadConfigData]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [dropdownOpen]);

  const primaryModelId = defaultModels.primary || null;

  const currentModel = useMemo((): ModelInfo | null => {
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
  }, [allModels, currentMode, agentModels, primaryModelId, t]);

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

  /// 用户自定义模型（provider != ai00s）；ai00s 作为默认模型入口，不在此列表
  const customModels = useMemo((): ModelInfo[] => {
    return availableModels.filter(m => !isAi00sModel(m.id));
  }, [availableModels]);

  const handleSelectModel = useCallback(async (modelId: string) => {
    if (loading) return;

    setLoading(true);
    try {
      if (modelId === 'auto') {
        const currentAgentModels = await configManager.getConfig<Record<string, string>>('ai.agent_models') || {};
        const updatedAgentModels = { ...currentAgentModels };
        delete updatedAgentModels[currentMode];
        await configManager.setConfig('ai.agent_models', updatedAgentModels);
        setAgentModels(updatedAgentModels);
      } else {
        const currentDefaultModels = await configManager.getConfig<any>('ai.default_models') || {};
        await configManager.setConfig('ai.default_models', {
          ...currentDefaultModels,
          primary: modelId,
        });
        setDefaultModels(prev => ({ ...prev, primary: modelId }));

        const currentAgentModels = await configManager.getConfig<Record<string, string>>('ai.agent_models') || {};
        const updatedAgentModels = { ...currentAgentModels };
        delete updatedAgentModels[currentMode];
        await configManager.setConfig('ai.agent_models', updatedAgentModels);
        setAgentModels(updatedAgentModels);
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
  }, [currentMode, loading, sessionId]);

  /// 当前选中的讯飞子模型 id（primary=ai00s 时，取 ai00s.model_name）
  const currentXfModelId = useMemo(() => {
    if (primaryModelId !== 'ai00s') return null;
    const ai00sModel = allModels.find(m => m.id === 'ai00s');
    return ai00sModel?.model_name || null;
  }, [primaryModelId, allModels]);

  /// Phase 5.1: 按价格区间分组讯飞模型（economy/standard/premium）
  const groupedXfModels = useMemo(() => {
    const groups: Record<ModelPriceGroup, Ai00sModelInfo[]> = {
      economy: [],
      standard: [],
      premium: [],
    };
    xfModels.forEach(m => {
      groups[getModelPriceGroup(m)].push(m);
    });
    return groups;
  }, [xfModels]);

  /// Phase 5.1: 是否免费层用户（用于显示升级提示）
  const isFreeUser = useMemo(() => {
    return isFreeTier(userPlan?.planTier ?? userTier);
  }, [userPlan, userTier]);

  /// Phase 5.1: 选择讯飞子模型
  /// - 优先检查额度（exhausted 时阻止选择）
  /// - 兼容旧的 tier 检查（canAccessModel）
  const handleSelectXfModel = useCallback(async (xfModel: Ai00sModelInfo) => {
    if (loading) return;

    // 额度用完阻止选择
    if (!isModelSelectable(xfModel)) {
      log.info('Free model quota exhausted, selection blocked', { modelId: xfModel.id });
      return;
    }

    // 兼容旧的 tier 检查（canAccessModel 仅对旧体系 free/cheap/expensive 有效）
    // 新体系下后端已按 plan_tier 过滤可见模型，前端不再需要 tier 检查
    // 但保留此检查以防后端未过滤的情况
    if (xfModel.tier && xfModel.tier !== 'free' && !canAccessModel(xfModel.tier, userTier)) {
      setUpgradeDialog({
        modelName: xfModel.displayName,
        requiredTier: xfModel.tier,
      });
      return;
    }

    setLoading(true);
    try {
      // 更新 ai00s 的 model_name（讯飞子模型走 ai00s provider，model_name 决定实际调哪个讯飞模型）
      const currentModels = await configManager.getConfig<AIModelConfig[]>('ai.models') || [];
      const updatedModels = currentModels.map(m =>
        m.id === 'ai00s' ? { ...m, model_name: xfModel.id } : m
      );
      await configManager.setConfig('ai.models', updatedModels);
      setAllModels(updatedModels);

      // 设 primary 为 ai00s（让 Provider 走 ai00s 入口）
      const currentDefaultModels = await configManager.getConfig<any>('ai.default_models') || {};
      await configManager.setConfig('ai.default_models', {
        ...currentDefaultModels,
        primary: 'ai00s',
      });
      setDefaultModels(prev => ({ ...prev, primary: 'ai00s' }));

      // 清除当前 mode 的 agent_models 覆盖
      const currentAgentModels = await configManager.getConfig<Record<string, string>>('ai.agent_models') || {};
      const updatedAgentModels = { ...currentAgentModels };
      delete updatedAgentModels[currentMode];
      await configManager.setConfig('ai.agent_models', updatedAgentModels);
      setAgentModels(updatedAgentModels);

      if (sessionId) {
        FlowChatStore.getInstance().updateSessionModelName(sessionId, 'ai00s');
        await agentAPI.updateSessionModel({
          sessionId,
          modelName: 'ai00s',
        });
      }

      log.info('Xunfei sub-model selected', { xfModelId: xfModel.id });

      globalEventBus.emit('mode:config:updated');

      setDropdownOpen(false);
    } catch (error) {
      log.error('Failed to switch xunfei sub-model', error);
    } finally {
      setLoading(false);
    }
  }, [currentMode, loading, sessionId, userTier]);

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

  const isAutoMode = !agentModels[currentMode] || agentModels[currentMode] === 'auto';

  const triggerLabel = useMemo(() => {
    if (isAutoMode && primaryModelId) {
      const model = allModels.find(m => m.id === primaryModelId);
      if (model) return model.model_name || model.name;
    }
    if (currentModel) {
      return currentModel.modelName || currentModel.configName;
    }
    return t('modelSelector.autoModel');
  }, [isAutoMode, primaryModelId, allModels, currentModel, t]);

  if (availableModels.length === 0 && xfModels.length === 0) {
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
    <div
      ref={dropdownRef}
      className={`ai00-x-model-selector ${className}`}
    >
      <Tooltip content={tooltipContent}>
        <button
          className={`ai00-x-model-selector__trigger ${dropdownOpen ? 'ai00-x-model-selector__trigger--open' : ''}`}
          onClick={() => setDropdownOpen(!dropdownOpen)}
          disabled={loading}
        >
          <Cpu size={10} className="ai00-x-model-selector__icon" />
          <span className="ai00-x-model-selector__name">
            {triggerLabel}
          </span>
          {(isAutoMode && primaryModelId && isAi00sModel(primaryModelId)) && (
            <span className={`ai00-x-model-selector__tier-badge ai00-x-model-selector__tier-badge--${getAi00sTier(primaryModelId!, userTier)}`}>
              {getAi00sTier(primaryModelId!, userTier)}
            </span>
          )}
          {(!isAutoMode && currentModel && isAi00sModel(currentModel.id)) && (
            <span className={`ai00-x-model-selector__tier-badge ai00-x-model-selector__tier-badge--${getAi00sTier(currentModel.id, userTier)}`}>
              {getAi00sTier(currentModel.id, userTier)}
            </span>
          )}
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
      </Tooltip>

      {dropdownOpen && (
        <div className="ai00-x-model-selector__dropdown">
          <div className="ai00-x-model-selector__dropdown-header">
            <span>{t('modelSelector.modelSelection')}</span>
            <span className="ai00-x-model-selector__dropdown-hint">
              {t('modelSelector.currentMode')}: {currentMode}
            </span>
          </div>

          <Tooltip content={autoTooltip} placement="right">
            <div
              className={`ai00-x-model-selector__option ai00-x-model-selector__option--special ${isAutoMode ? 'ai00-x-model-selector__option--selected' : ''}`}
              onClick={() => handleSelectModel('auto')}
            >
              <div className="ai00-x-model-selector__option-main">
                <span className="ai00-x-model-selector__option-name">{t('modelSelector.autoModel')}</span>
              </div>
              {isAutoMode && (
                <Check size={14} className="ai00-x-model-selector__option-check" />
              )}
            </div>
          </Tooltip>

          <div className="ai00-x-model-selector__divider" />

          {xfModels.length > 0 && (
            <>
              {/* Phase 5.1: 按价格区间分组渲染（economy/standard/premium） */}
              {([
                { group: 'economy' as const, icon: <Zap size={9} className="ai00-x-model-selector__group-icon" /> },
                { group: 'standard' as const, icon: <Sparkles size={9} className="ai00-x-model-selector__group-icon" /> },
                { group: 'premium' as const, icon: <Crown size={9} className="ai00-x-model-selector__group-icon" /> },
              ]).map(({ group, icon }) => {
                const groupModels = groupedXfModels[group];
                if (groupModels.length === 0) return null;
                const sectionKey = `modelSelector.priceGroups.${group}`;
                return (
                  <React.Fragment key={group}>
                    <div className="ai00-x-model-selector__section-title">
                      {icon}
                      <span>{t(`${sectionKey}.title`)}</span>
                      <span className="ai00-x-model-selector__section-hint">
                        {t(`${sectionKey}.hint`)}
                      </span>
                    </div>
                    <div className="ai00-x-model-selector__list">
                      {groupModels.map(xfModel => {
                        const isSelected = currentXfModelId === xfModel.id;
                        const canAccess = canAccessModel(xfModel.tier, userTier);
                        const quotaText = formatFreeQuotaText(xfModel, t);
                        const priceText = formatModelPrice(xfModel);
                        const modalityLabel = formatModalityLabel(xfModel.modality);
                        const isExhausted = xfModel.isUpstreamFree && getFreeQuotaStatus(xfModel.freeQuota) === 'exhausted';

                        // tooltip: 显示名 + 模态 + 价格 + 剩余额度
                        const tooltipParts: string[] = [xfModel.displayName];
                        if (modalityLabel) tooltipParts.push(modalityLabel);
                        if (xfModel.producer) tooltipParts.push(xfModel.producer);
                        if (priceText) {
                          tooltipParts.push(t('modelSelector.priceLabel', { price: priceText }));
                        }
                        if (quotaText) tooltipParts.push(quotaText);
                        if (isExhausted) {
                          tooltipParts.push(t('modelSelector.freeQuota.exhausted'));
                        } else if (!canAccess && xfModel.tier !== 'free') {
                          tooltipParts.push(t('modelSelector.upgrade.required', { tier: xfModel.tier }));
                        }
                        const tooltipText = tooltipParts.join(' · ');

                        return (
                          <Tooltip key={xfModel.id} content={tooltipText} placement="right">
                            <div
                              className={`ai00-x-model-selector__option ${isSelected ? 'ai00-x-model-selector__option--selected' : ''} ${isExhausted ? 'ai00-x-model-selector__option--disabled' : ''} ${!canAccess && xfModel.tier !== 'free' ? 'ai00-x-model-selector__option--locked' : ''}`}
                              onClick={() => handleSelectXfModel(xfModel)}
                            >
                              <div className="ai00-x-model-selector__option-main">
                                <span className="ai00-x-model-selector__option-name">
                                  {xfModel.displayName}
                                  {xfModel.isUpstreamFree && (
                                    <span className="ai00-x-model-selector__price-badge ai00-x-model-selector__price-badge--economy">
                                      {t('modelSelector.badges.economy')}
                                    </span>
                                  )}
                                  {modalityLabel && (
                                    <span className="ai00-x-model-selector__modality-badge">
                                      {modalityLabel}
                                    </span>
                                  )}
                                  {isExhausted && (
                                    <Lock size={10} className="ai00-x-model-selector__option-lock" />
                                  )}
                                </span>
                                <span className="ai00-x-model-selector__option-subdesc">
                                  {quotaText || (priceText ? t('modelSelector.priceLabel', { price: priceText }) : '')}
                                </span>
                                {isSelected && (
                                  <span className="ai00-x-model-selector__option-badge">{t('modelSelector.primaryBadge')}</span>
                                )}
                              </div>
                              {isSelected && (
                                <Check size={14} className="ai00-x-model-selector__option-check" />
                              )}
                            </div>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </React.Fragment>
                );
              })}

              {/* Phase 5.1: 免费层用户升级提示 */}
              {isFreeUser && (
                <div className="ai00-x-model-selector__upgrade-hint">
                  <Rocket size={11} className="ai00-x-model-selector__upgrade-icon" />
                  <span>{t('modelSelector.upgradeHint.freeTier')}</span>
                </div>
              )}
            </>
          )}

          {customModels.length > 0 && (
            <>
              {xfModels.length > 0 && (
                <div className="ai00-x-model-selector__divider" />
              )}
              <div className="ai00-x-model-selector__section-title">
                {t('modelSelector.customModels.sectionTitle')}
              </div>
              <div className="ai00-x-model-selector__list">
                {customModels.map(model => {
                  const isPrimary = model.id === primaryModelId;

                  return (
                    <Tooltip key={model.id} content={buildModelMetaText(model)} placement="right">
                      <div
                        className={`ai00-x-model-selector__option ${isPrimary ? 'ai00-x-model-selector__option--selected' : ''}`}
                        onClick={() => handleSelectModel(model.id)}
                      >
                        <div className="ai00-x-model-selector__option-main">
                          <span className="ai00-x-model-selector__option-name">
                            {model.modelName}
                            {model.enableThinking && (
                              <Sparkles size={10} className="ai00-x-model-selector__option-thinking" />
                            )}
                          </span>
                          {isPrimary && (
                            <span className="ai00-x-model-selector__option-badge">{t('modelSelector.primaryBadge')}</span>
                          )}
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
        </div>
      )}

      <UpgradeDialog
        isOpen={upgradeDialog !== null}
        onClose={() => setUpgradeDialog(null)}
        modelName={upgradeDialog?.modelName ?? ''}
        requiredTier={upgradeDialog?.requiredTier ?? ''}
        currentTier={userTier}
      />
    </div>
  );
};
export default ModelSelector;
