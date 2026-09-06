import React, { useId, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, type SelectOption } from '@/component-library';
import type { AIModelConfig } from '../types';
import { getModelDisplayName } from '../services/modelConfigs';
import './ModelSelectionRadio.scss';

export interface ModelSelectionRadioProps {
  value: string;
  models: AIModelConfig[];
  onChange: (modelId: string) => void;
  disabled?: boolean;
  layout?: 'horizontal' | 'vertical';
  size?: 'small' | 'medium';
}

const isSpecialModel = (value: string): value is 'primary' | 'fast' | 'rwkv-local' => {
  return value === 'primary' || value === 'fast' || value === 'rwkv-local';
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

  const selectionType = useMemo<'primary' | 'fast' | 'local' | 'custom'>(() => {
    if (value === 'primary') return 'primary';
    if (value === 'fast') return 'fast';
    if (value === 'rwkv-local') return 'local';
    return 'custom';
  }, [value]);

  const customModelId = useMemo(() => {
    return isSpecialModel(value) ? undefined : value;
  }, [value]);

  const handleSelectionChange = (selection: 'primary' | 'fast' | 'local' | 'custom') => {
    if (selection === 'custom') {
      const newModelId = customModelId || models[0]?.id || 'primary';
      onChange(newModelId);
    } else if (selection === 'local') {
      onChange('rwkv-local');
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
    return (
      <div className="model-selection-radio__model-option">
        <span className="model-selection-radio__model-option-label">{option.label}</span>
      </div>
    );
  }, []);

  const renderModelValue = useCallback((option?: SelectOption | SelectOption[]) => {
    const selected = Array.isArray(option) ? option[0] : option;
    if (!selected) return null;
    return (
      <span className="model-selection-radio__model-value">
        <span className="model-selection-radio__model-value-label">{selected.label}</span>
      </span>
    );
  }, []);

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
          checked={selectionType === 'primary' || selectionType === 'fast'}
          onChange={() => handleSelectionChange('primary')}
          disabled={disabled}
          className="model-selection-radio__input"
        />
        <span className="model-selection-radio__label">
          {t('selection.primary')}
        </span>
      </label>

      <label
        className={`model-selection-radio__option ${selectionType === 'local' ? 'model-selection-radio__option--selected' : ''}`}
      >
        <input
          type="radio"
          name={radioName}
          value="rwkv-local"
          checked={selectionType === 'local'}
          onChange={() => handleSelectionChange('local')}
          disabled={disabled}
          className="model-selection-radio__input"
        />
        <span className="model-selection-radio__label">
          {t('selection.local')}
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
