import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Route,
  CircleCheck,
  CircleAlert,
  CircleDashed,
  TriangleAlert,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Select, Switch, NumberInput, type SelectOption } from '@/component-library';
import { notificationService } from '@/shared/notification-system';
import { configManager } from '../services/ConfigManager';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import type { AIModelConfig, SmartRouterConfig as SmartRouterConfigType } from '../types';
import { ConfigPageRow } from './common';
import RouterTestPanel from './RouterTestPanel';
import { createLogger } from '@/shared/utils/logger';
import './SmartRouterConfig.scss';

const log = createLogger('SmartRouterConfig');

interface RouterStatus {
  router_enabled: boolean;
  engine_initialized: boolean;
  head_loaded: boolean;
  head_input_dim: number | null;
  head_detail: string | null;
}

const DEFAULT_ROUTER_CONFIG: SmartRouterConfigType = {
  enabled: false,
  tier_models: {
    r0: 'rwkv-local',
    r1: 'rwkv-local',
    r2: 'fast',
    r3: 'primary',
  },
  fallback: 'primary',
  safety_threshold: 0.45,
  sticky_enabled: true,
  timeout_ms: 3000,
};

type TierKey = 'r0' | 'r1' | 'r2' | 'r3';

const TIER_KEYS: TierKey[] = ['r0', 'r1', 'r2', 'r3'];

const normalizeSelectValue = (value: string | number | (string | number)[]): string | number =>
  Array.isArray(value) ? (value[0] ?? '') : value;

export const SmartRouterConfig: React.FC = () => {
  const { t } = useTranslation('settings/default-model');

  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<AIModelConfig[]>([]);
  const [routerConfig, setRouterConfig] = useState<SmartRouterConfigType>(DEFAULT_ROUTER_CONFIG);
  const [status, setStatus] = useState<RouterStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.invoke<RouterStatus>('get_router_status', {});
      setStatus(s);
    } catch (error) {
      log.error('Failed to load router status', error);
    }
  }, []);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [allModels, storedRouter] = await Promise.all([
        configManager.getConfig<AIModelConfig[]>('ai.models') || [],
        configManager.getConfig<Partial<SmartRouterConfigType>>('ai.router'),
      ]);
      setModels(allModels);
      setRouterConfig({
        ...DEFAULT_ROUTER_CONFIG,
        ...storedRouter,
        tier_models: {
          ...DEFAULT_ROUTER_CONFIG.tier_models,
          ...(storedRouter?.tier_models || {}),
        },
      });
    } catch (error) {
      log.error('Failed to load smart router config', error);
      notificationService.error(t('messages.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadData();
    void refreshStatus();
    const unsubscribeModels = configManager.watch('ai.models', () => {
      void loadData();
    });
    const unsubscribeRouter = configManager.watch('ai.router', () => {
      void loadData();
      void refreshStatus();
    });
    // Poll while the router is enabled but the engine/head is not ready yet
    // (engine preload takes ~13s after enabling); stop once fully loaded.
    const statusTimer = window.setInterval(() => {
      setStatus((prev) => {
        if (prev && prev.head_loaded && prev.engine_initialized) {
          return prev;
        }
        void refreshStatus();
        return prev;
      });
    }, 5000);
    return () => {
      unsubscribeModels();
      unsubscribeRouter();
      window.clearInterval(statusTimer);
    };
  }, [loadData, refreshStatus]);

  const buildOptions = useCallback((): SelectOption[] => {
    const logicalOptions: SelectOption[] = [
      { label: t('smartRouter.options.primary'), value: 'primary' },
      { label: t('smartRouter.options.fast'), value: 'fast' },
      { label: t('smartRouter.options.rwkvLocal'), value: 'rwkv-local' },
    ];
    // Enabled user models (rwkv-local excluded to avoid a duplicate option).
    const modelOptions = models
      .filter((m) => m.enabled && m.id && m.id !== 'rwkv-local' && m.model_name !== 'rwkv-local')
      .map((m) => ({ label: m.model_name, value: m.id! }));
    // Disabled models still referenced by a tier/fallback stay selectable so
    // the dropdown does not silently blank out; flagged with a suffix.
    const referenced = new Set([
      ...TIER_KEYS.map((k) => routerConfig.tier_models[k]),
      routerConfig.fallback,
    ]);
    const disabledReferenced = models
      .filter(
        (m) =>
          !m.enabled &&
          m.id &&
          m.id !== 'rwkv-local' &&
          m.model_name !== 'rwkv-local' &&
          referenced.has(m.id)
      )
      .map((m) => ({ label: `${m.model_name} ${t('smartRouter.disabledSuffix')}`, value: m.id! }));
    return [...logicalOptions, ...modelOptions, ...disabledReferenced];
  }, [models, routerConfig, t]);

  // A tier/fallback reference is invalid when it is neither a logical name
  // nor any configured model (enabled or disabled) — routing falls back to
  // primary at runtime, so surface a warning.
  const hasInvalidRefs = useCallback((): boolean => {
    const known = new Set([
      'primary',
      'fast',
      'rwkv-local',
      ...models.map((m) => m.id).filter((id): id is string => Boolean(id)),
    ]);
    return [...TIER_KEYS.map((k) => routerConfig.tier_models[k]), routerConfig.fallback].some(
      (ref) => !known.has(ref)
    );
  }, [models, routerConfig]);

  const persist = useCallback(async (next: SmartRouterConfigType) => {
    setRouterConfig(next);
    try {
      await configManager.setConfig('ai.router', next);
    } catch (error) {
      log.error('Failed to save smart router config', { next, error });
      notificationService.error(t('messages.updateFailed'));
    }
  }, [t]);

  const handleEnabledChange = useCallback((checked: boolean) => {
    void persist({ ...routerConfig, enabled: checked });
  }, [persist, routerConfig]);

  const handleTierChange = useCallback(
    (tier: TierKey, value: string | number | (string | number)[]) => {
      const modelRef = String(normalizeSelectValue(value));
      void persist({
        ...routerConfig,
        tier_models: { ...routerConfig.tier_models, [tier]: modelRef },
      });
    },
    [persist, routerConfig]
  );

  const handleFallbackChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const modelRef = String(normalizeSelectValue(value));
      void persist({ ...routerConfig, fallback: modelRef });
    },
    [persist, routerConfig]
  );

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [reloading, setReloading] = useState(false);

  const handleReloadHead = useCallback(async () => {
    setReloading(true);
    try {
      await api.invoke('reload_router_head', {});
      await refreshStatus();
    } catch (error) {
      log.error('Failed to reload router head', error);
      notificationService.error(t('smartRouter.status.reloadFailed'));
    } finally {
      setReloading(false);
    }
  }, [refreshStatus, t]);

  const handleSafetyThresholdChange = useCallback(
    (value: number) => {
      void persist({ ...routerConfig, safety_threshold: value });
    },
    [persist, routerConfig]
  );

  const handleStickyEnabledChange = useCallback(
    (checked: boolean) => {
      void persist({ ...routerConfig, sticky_enabled: checked });
    },
    [persist, routerConfig]
  );

  const handleTimeoutChange = useCallback(
    (value: number) => {
      void persist({ ...routerConfig, timeout_ms: Math.round(value) });
    },
    [persist, routerConfig]
  );

  if (loading) {
    return null;
  }

  const options = buildOptions();

  const renderStatus = () => {
    if (!status) return null;
    let icon = <CircleDashed size={12} />;
    let text = t('smartRouter.status.engineInit');
    let cls = 'smart-router-config__status--init';
    if (status.engine_initialized && status.head_loaded) {
      icon = <CircleCheck size={12} />;
      text = t('smartRouter.status.loaded', {
        dim: status.head_input_dim ?? '?',
      });
      cls = 'smart-router-config__status--ok';
    } else if (status.engine_initialized && !status.head_loaded) {
      icon = <CircleAlert size={12} />;
      text = t('smartRouter.status.notLoaded', {
        reason: status.head_detail ?? '',
      });
      cls = 'smart-router-config__status--warn';
    }
    return (
      <div className={`smart-router-config__status ${cls}`}>
        {icon}
        <span>{text}</span>
        {status.engine_initialized && (
          <button
            type="button"
            className="smart-router-config__reload-btn"
            disabled={reloading}
            onClick={() => void handleReloadHead()}
          >
            {t('smartRouter.status.reload')}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="smart-router-config">
      <ConfigPageRow
        label={t('smartRouter.title')}
        description={t('smartRouter.description')}
        align="center"
      >
        <Switch
          checked={routerConfig.enabled}
          onChange={(e) => handleEnabledChange(e.target.checked)}
          size="small"
        />
      </ConfigPageRow>

      {routerConfig.enabled && (
        <>
          {renderStatus()}
          {TIER_KEYS.map((tier) => (
            <ConfigPageRow
              key={tier}
              label={t(`smartRouter.tiers.${tier}.label`)}
              description={t(`smartRouter.tiers.${tier}.description`)}
              align="center"
            >
              <Select
                value={routerConfig.tier_models[tier]}
                onChange={(value) => handleTierChange(tier, normalizeSelectValue(value))}
                options={options}
                className="smart-router-config__tier-select"
                size="small"
              />
            </ConfigPageRow>
          ))}

          <ConfigPageRow
            label={t('smartRouter.fallback.label')}
            description={t('smartRouter.fallback.description')}
            align="center"
          >
            <Select
              value={routerConfig.fallback}
              onChange={handleFallbackChange}
              options={options}
              className="smart-router-config__tier-select"
              size="small"
            />
          </ConfigPageRow>

          {hasInvalidRefs() && (
            <div className="smart-router-config__warning">
              <TriangleAlert size={12} />
              <span>{t('smartRouter.warnings.invalidRef')}</span>
            </div>
          )}

          <div className="smart-router-config__advanced">
            <button
              type="button"
              className="smart-router-config__advanced-toggle"
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span>{t('smartRouter.advanced.title')}</span>
            </button>
            {advancedOpen && (
              <>
                <ConfigPageRow
                  label={t('smartRouter.advanced.safetyThreshold.label')}
                  description={t('smartRouter.advanced.safetyThreshold.description')}
                  align="center"
                >
                  <NumberInput
                    value={routerConfig.safety_threshold}
                    onChange={handleSafetyThresholdChange}
                    min={0.1}
                    max={0.9}
                    step={0.05}
                    precision={2}
                    size="small"
                  />
                </ConfigPageRow>
                <ConfigPageRow
                  label={t('smartRouter.advanced.sticky.label')}
                  description={t('smartRouter.advanced.sticky.description')}
                  align="center"
                >
                  <Switch
                    checked={routerConfig.sticky_enabled}
                    onChange={(e) => handleStickyEnabledChange(e.target.checked)}
                    size="small"
                  />
                </ConfigPageRow>
                <ConfigPageRow
                  label={t('smartRouter.advanced.timeout.label')}
                  description={t('smartRouter.advanced.timeout.description')}
                  align="center"
                >
                  <NumberInput
                    value={routerConfig.timeout_ms}
                    onChange={handleTimeoutChange}
                    min={500}
                    max={10000}
                    step={100}
                    unit="ms"
                    size="small"
                  />
                </ConfigPageRow>
              </>
            )}
          </div>

          <div className="smart-router-config__test">
            <div className="smart-router-config__test-title">
              {t('smartRouter.test.title')}
            </div>
            <RouterTestPanel />
          </div>

          <div className="smart-router-config__hint">
            <Route size={12} />
            <span>{t('smartRouter.hint')}</span>
          </div>
        </>
      )}
    </div>
  );
};

export default SmartRouterConfig;
