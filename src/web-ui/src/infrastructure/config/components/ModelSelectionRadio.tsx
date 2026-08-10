import React, { useId, useMemo, useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Select, type SelectOption } from '@/component-library';
import type { AIModelConfig } from '../types';
import { getModelDisplayName } from '../services/modelConfigs';
import { isAi00sModel, getAi00sTier, fetchUserTier, setCachedTier } from '../services/ai00sTier';
import './ModelSelectionRadio.scss';

export interface ModelSelectionRadioProps {
  value: string;
  models: AIModelConfig[];
  onChange: (modelId: string) => void;
  disabled?: boolean;
  layout?: 'horizontal' | 'vertical';
  size?: 'small' | 'medium';
}

const isSpecialModel = (value: string): value is 'primary' | 'fast' => {
  return value === 'primary' || value === 'fast';
};

export const ModelSelectionRadio: React.FC<ModelSelectionRadioProps> = ({
  value,
  models,
  onChange,
  disabled = false,
  layout = 'horizontal',
  size = 'medium',
}) => {
  const { t } = useTranslation('settings/default-model');
  const uniqueId = useId();
  const radioName = `model-selection-${uniqueId}`;
  const [userTier, setUserTier] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const authInfo = await invoke<{ plan_tier?: string | null } | null>('get_auth_info');
        if (authInfo?.plan_tier) {
          setUserTier(authInfo.plan_tier);
          setCachedTier(authInfo.plan_tier);
        } else {
          const tier = await fetchUserTier();
          if (tier) setUserTier(tier);
        }
      } catch {
        const tier = await fetchUserTier();
        if (tier) setUserTier(tier);
      }
    })();
  }, []);

  const selectionType = useMemo<'primary' | 'fast' | 'custom'>(() => {
    if (value === 'primary') return 'primary';
    if (value === 'fast') return 'fast';
    return 'custom';
  }, [value]);

  const customModelId = useMemo(() => {
    return isSpecialModel(value) ? undefined : value;
  }, [value]);

  const handleSelectionChange = (selection: 'primary' | 'fast' | 'custom') => {
    if (selection === 'custom') {
      const newModelId = customModelId || models[0]?.id || 'primary';
      onChange(newModelId);
    } else {
      onChange(selection);
    }
  };

  const handleCustomModelChange = (modelId: string | number | (string | number)[]) => {
    if (Array.isArray(modelId)) {
      onChange(String(modelId[0]));
    } else {
      onChange(String(modelId));
    }
  };

  const enabledModels = models.filter(m => m.enabled);

  const renderModelOption = useCallback((option: SelectOption) => {
    const id = String(option.value);
    return (
      <div className="model-selection-radio__model-option">
        <span className="model-selection-radio__model-option-label">{option.label}</span>
        {isAi00sModel(id) && (
          <span className={`model-selection-radio__tier-badge model-selection-radio__tier-badge--${getAi00sTier(id, userTier)}`}>
            {getAi00sTier(id, userTier)}
          </span>
        )}
      </div>
    );
  }, [userTier]);

  const renderModelValue = useCallback((option?: SelectOption | SelectOption[]) => {
    const selected = Array.isArray(option) ? option[0] : option;
    if (!selected) return null;
    const id = String(selected.value);
    return (
      <span className="model-selection-radio__model-value">
        <span className="model-selection-radio__model-value-label">{selected.label}</span>
        {isAi00sModel(id) && (
          <span className={`model-selection-radio__tier-badge model-selection-radio__tier-badge--${getAi00sTier(id, userTier)}`}>
            {getAi00sTier(id, userTier)}
          </span>
        )}
      </span>
    );
  }, [userTier]);

  return (
    <div
      className={`model-selection-radio model-selection-radio--${layout} model-selection-radio--${size}`}
    >
      <label
        className={`model-selection-radio__option ${selectionType === 'primary' ? 'model-selection-radio__option--selected' : ''}`}
      >
        <input
          type="radio"
          name={radioName}
          value="primary"
          checked={selectionType === 'primary'}
          onChange={() => handleSelectionChange('primary')}
          disabled={disabled}
          className="model-selection-radio__input"
        />
        <span className="model-selection-radio__label">
          {t('selection.primary')}
        </span>
      </label>

      <label
        className={`model-selection-radio__option ${selectionType === 'fast' ? 'model-selection-radio__option--selected' : ''}`}
      >
        <input
          type="radio"
          name={radioName}
          value="fast"
          checked={selectionType === 'fast'}
          onChange={() => handleSelectionChange('fast')}
          disabled={disabled}
          className="model-selection-radio__input"
        />
        <span className="model-selection-radio__label">
          {t('selection.fast')}
        </span>
      </label>

      <label
        className={`model-selection-radio__option model-selection-radio__option--custom ${selectionType === 'custom' ? 'model-selection-radio__option--selected' : ''}`}
      >
        <input
          type="radio"
          name={radioName}
          value="custom"
          checked={selectionType === 'custom'}
          onChange={() => handleSelectionChange('custom')}
          disabled={disabled}
          className="model-selection-radio__input"
        />
        <span className="model-selection-radio__label">
          {t('selection.custom')}
        </span>

        {selectionType === 'custom' && (
          <div className="model-selection-radio__dropdown">
            <Select
              value={customModelId || ''}
              onChange={handleCustomModelChange}
              disabled={disabled}
              placeholder={t('selection.selectModel')}
              options={enabledModels.map(model => ({
                label: getModelDisplayName(model),
                value: model.id!,
              }))}
              renderOption={renderModelOption}
              renderValue={renderModelValue}
              size="small"
            />
          </div>
        )}
      </label>
    </div>
  );
};

export default ModelSelectionRadio;
