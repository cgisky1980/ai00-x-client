/**
 * ParameterPanel — grouped, collapsible parameter editor for AceRequest.
 *
 * Renders 5 groups (Content / DiT / LM / Advanced / Output). The Content
 * group respects `visibleContentFields` (task-dependent); the other four
 * groups are always shown. Each field uses a minimal control (number input,
 * text input, textarea, select, or checkbox).
 */

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { AceRequest } from '../types';
import {
  SOLVER_EULER,
  SOLVER_SDE,
  SOLVER_DPM3M,
  SOLVER_STORK4,
  LM_MODE_GENERATE,
  LM_MODE_INSPIRE,
  LM_MODE_FORMAT,
  OUTPUT_FORMAT_MP3,
  OUTPUT_FORMAT_WAV16,
  OUTPUT_FORMAT_WAV24,
  OUTPUT_FORMAT_WAV32,
} from '../types';
import './ParameterPanel.scss';

type FieldKind = 'text' | 'textarea' | 'number' | 'select' | 'checkbox';
type GroupId = 'content' | 'dit' | 'lm' | 'advanced' | 'output';

interface FieldConfig {
  key: keyof AceRequest;
  kind: FieldKind;
  group: GroupId;
  options?: string[];
}

const FIELD_CONFIGS: FieldConfig[] = [
  // ---- Content ----
  { key: 'caption', kind: 'textarea', group: 'content' },
  { key: 'lyrics', kind: 'textarea', group: 'content' },
  { key: 'duration', kind: 'number', group: 'content' },
  { key: 'bpm', kind: 'number', group: 'content' },
  { key: 'keyscale', kind: 'text', group: 'content' },
  { key: 'timesignature', kind: 'text', group: 'content' },
  { key: 'vocal_language', kind: 'text', group: 'content' },
  { key: 'track', kind: 'text', group: 'content' },
  { key: 'audio_cover_strength', kind: 'number', group: 'content' },
  { key: 'cover_noise_strength', kind: 'number', group: 'content' },
  { key: 'repainting_start', kind: 'number', group: 'content' },
  { key: 'repainting_end', kind: 'number', group: 'content' },
  // ---- DiT ----
  { key: 'inference_steps', kind: 'number', group: 'dit' },
  { key: 'guidance_scale', kind: 'number', group: 'dit' },
  { key: 'shift', kind: 'number', group: 'dit' },
  { key: 'solver', kind: 'select', group: 'dit', options: [SOLVER_EULER, SOLVER_SDE, SOLVER_DPM3M, SOLVER_STORK4] },
  { key: 'stork_substeps', kind: 'number', group: 'dit' },
  // ---- LM ----
  { key: 'lm_temperature', kind: 'number', group: 'lm' },
  { key: 'lm_cfg_scale', kind: 'number', group: 'lm' },
  { key: 'lm_top_p', kind: 'number', group: 'lm' },
  { key: 'lm_top_k', kind: 'number', group: 'lm' },
  { key: 'lm_negative_prompt', kind: 'text', group: 'lm' },
  { key: 'lm_mode', kind: 'select', group: 'lm', options: [LM_MODE_GENERATE, LM_MODE_INSPIRE, LM_MODE_FORMAT] },
  { key: 'use_cot_caption', kind: 'checkbox', group: 'lm' },
  { key: 'lm_seed', kind: 'number', group: 'lm' },
  // ---- Advanced ----
  { key: 'dcw_scaler', kind: 'number', group: 'advanced' },
  { key: 'dcw_high_scaler', kind: 'number', group: 'advanced' },
  { key: 'dcw_mode', kind: 'select', group: 'advanced', options: ['low', 'mid', 'high'] },
  { key: 'latent_shift', kind: 'number', group: 'advanced' },
  { key: 'latent_rescale', kind: 'number', group: 'advanced' },
  { key: 'custom_timesteps', kind: 'text', group: 'advanced' },
  { key: 'seed', kind: 'number', group: 'advanced' },
  // ---- Output ----
  { key: 'output_format', kind: 'select', group: 'output', options: [OUTPUT_FORMAT_MP3, OUTPUT_FORMAT_WAV16, OUTPUT_FORMAT_WAV24, OUTPUT_FORMAT_WAV32] },
  { key: 'peak_clip', kind: 'number', group: 'output' },
  { key: 'mp3_bitrate', kind: 'number', group: 'output' },
];

const GROUP_ORDER: GroupId[] = ['content', 'dit', 'lm', 'advanced', 'output'];

const GROUP_LABEL_KEYS: Record<GroupId, string> = {
  content: 'groups.content',
  dit: 'groups.dit',
  lm: 'groups.lm',
  advanced: 'groups.advanced',
  output: 'groups.output',
};

interface ParameterPanelProps {
  request: AceRequest;
  onChange: (patch: Partial<AceRequest>) => void;
  visibleContentFields: Set<keyof AceRequest>;
  disabled?: boolean;
}

const ParameterPanel: React.FC<ParameterPanelProps> = ({
  request,
  onChange,
  visibleContentFields,
  disabled,
}) => {
  const { t } = useI18n('acestep');
  const [collapsed, setCollapsed] = useState<Record<GroupId, boolean>>({
    content: false,
    dit: true,
    lm: true,
    advanced: true,
    output: true,
  });

  const toggleGroup = (g: GroupId) =>
    setCollapsed((s) => ({ ...s, [g]: !s[g] }));

  const renderField = (cfg: FieldConfig) => {
    const value = request[cfg.key];
    const label = t(`fields.${String(cfg.key)}`, { defaultValue: String(cfg.key) });
    const commonProps = {
      disabled,
      id: `acestep-field-${cfg.key}`,
    };

    if (cfg.kind === 'checkbox') {
      return (
        <div key={cfg.key} className="acestep-param__field acestep-param__field--checkbox">
          <input
            type="checkbox"
            {...commonProps}
            checked={Boolean(value)}
            onChange={(e) => onChange({ [cfg.key]: e.target.checked } as Partial<AceRequest>)}
          />
          <label htmlFor={commonProps.id}>{label}</label>
        </div>
      );
    }

    return (
      <div key={cfg.key} className="acestep-param__field">
        <label className="acestep-param__label" htmlFor={commonProps.id}>{label}</label>
        {cfg.kind === 'textarea' ? (
          <textarea
            {...commonProps}
            className="acestep-param__textarea"
            value={String(value)}
            rows={3}
            onChange={(e) => onChange({ [cfg.key]: e.target.value } as Partial<AceRequest>)}
          />
        ) : cfg.kind === 'select' ? (
          <select
            {...commonProps}
            className="acestep-param__select"
            value={String(value)}
            onChange={(e) => onChange({ [cfg.key]: e.target.value } as Partial<AceRequest>)}
          >
            {cfg.options!.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        ) : (
          <input
            {...commonProps}
            type={cfg.kind === 'number' ? 'number' : 'text'}
            className="acestep-param__input"
            value={String(value)}
            step={cfg.kind === 'number' ? 'any' : undefined}
            onChange={(e) => {
              const v = cfg.kind === 'number'
                ? (e.target.value === '' ? 0 : Number(e.target.value))
                : e.target.value;
              onChange({ [cfg.key]: v } as Partial<AceRequest>);
            }}
          />
        )}
      </div>
    );
  };

  return (
    <div className="acestep-param">
      {GROUP_ORDER.map((group) => {
        const fields = FIELD_CONFIGS.filter((f) => f.group === group);
        const visible = group === 'content'
          ? fields.filter((f) => visibleContentFields.has(f.key))
          : fields;
        if (visible.length === 0) return null;
        const isCollapsed = collapsed[group];
        return (
          <div key={group} className="acestep-param__group">
            <button
              type="button"
              className="acestep-param__group-header"
              onClick={() => toggleGroup(group)}
            >
              <ChevronDown size={14} className={`acestep-param__chevron${isCollapsed ? ' is-collapsed' : ''}`} />
              <span>{t(GROUP_LABEL_KEYS[group], { defaultValue: group })}</span>
            </button>
            {!isCollapsed && (
              <div className="acestep-param__group-body">
                {visible.map(renderField)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ParameterPanel;
