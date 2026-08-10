/**
 * ModelLoader — ACE-Step model file selection and loading panel.
 *
 * Shows the local model files grouped by role (text_encoder / dit / vae),
 * lets the user pick which variant to load, and triggers the pipeline load.
 * LM is not needed — the chat flow goes directly to DiT.
 *
 * Must be invoked before StepByStepBuilder's "Generate" button works —
 * `acestep_generate` requires the pipeline to be loaded first.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { Package, Loader2, CheckCircle2, XCircle, Upload } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { useAceStepStore } from '../store/acestepStore';
import type { AceStepLocalModel } from '../types';
import './ModelLoader.scss';

type Role = 'text_encoder' | 'dit' | 'vae';

const ROLE_ORDER: Role[] = ['text_encoder', 'dit', 'vae'];

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  const gb = bytes / 1_000_000_000;
  const mb = bytes / 1_000_000;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

export const ModelLoader: React.FC = () => {
  const { t } = useI18n('acestep');
  const { localModels, localModelsLoading, status, generationState, loadFromSelection, refreshLocalModels } =
    useAceStepStore();

  const [selected, setSelected] = useState<Partial<Record<Role, AceStepLocalModel>>>({});

  // Group models by role.
  const byRole = useMemo(() => {
    const groups: Record<Role, AceStepLocalModel[]> = {
      text_encoder: [],
      dit: [],
      vae: [],
    };
    for (const m of localModels) {
      if (m.role in groups) {
        groups[m.role as Role].push(m);
      }
    }
    return groups;
  }, [localModels]);

  // Auto-select the first existing variant for each role when models load.
  useEffect(() => {
    if (localModels.length === 0) return;
    setSelected((prev) => {
      const next = { ...prev };
      for (const role of ROLE_ORDER) {
        if (next[role]) continue;
        const existing = byRole[role].find((m) => m.exists);
        if (existing) next[role] = existing;
      }
      return next;
    });
  }, [localModels, byRole]);

  const isLoaded = status?.synthLoaded;
  const isLoading = generationState === 'loading-models';

  const allSelected = ROLE_ORDER.every((r) => selected[r]);
  const allExist = ROLE_ORDER.every((r) => selected[r]?.exists);

  const handleLoad = async () => {
    if (!allSelected || !allExist) return;
    await loadFromSelection({
      textEncoder: selected.text_encoder!,
      dit: selected.dit!,
      vae: selected.vae!,
    });
  };

  const handleRefresh = () => {
    refreshLocalModels();
  };

  return (
    <div className="acestep-model-loader">
      <div className="acestep-model-loader__header">
        <Package size={16} />
        <span>{t('modelLoader.title')}</span>
        <button
          className="acestep-model-loader__refresh"
          onClick={handleRefresh}
          disabled={localModelsLoading || isLoading}
          title={t('modelLoader.refresh')}
        >
          {localModelsLoading ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
        </button>
      </div>

      {isLoaded && (
        <div className="acestep-model-loader__loaded-banner">
          <CheckCircle2 size={14} />
          <span>{t('modelLoader.loaded')}</span>
        </div>
      )}

      <div className="acestep-model-loader__roles">
        {ROLE_ORDER.map((role) => (
          <div key={role} className="acestep-model-loader__role">
            <label className="acestep-model-loader__role-label">
              {t(`modelLoader.role.${role}`)}
            </label>
            <div className="acestep-model-loader__variants">
              {byRole[role].length === 0 && (
                <span className="acestep-model-loader__empty">
                  {t('modelLoader.noVariants')}
                </span>
              )}
              {byRole[role].map((m) => {
                const isSelected = selected[role]?.filename === m.filename;
                return (
                  <button
                    key={m.filename}
                    className={`acestep-model-loader__variant ${isSelected ? 'selected' : ''} ${m.exists ? 'exists' : 'missing'}`}
                    onClick={() => setSelected((s) => ({ ...s, [role]: m }))}
                    disabled={isLoading}
                    title={m.exists ? m.localPath : t('modelLoader.missing')}
                  >
                    <span className="acestep-model-loader__variant-name">{m.variant}</span>
                    <span className="acestep-model-loader__variant-size">
                      {m.exists ? formatSize(m.sizeBytes) : t('modelLoader.notDownloaded')}
                    </span>
                    {m.exists ? (
                      <CheckCircle2 size={12} className="acestep-model-loader__icon-exists" />
                    ) : (
                      <XCircle size={12} className="acestep-model-loader__icon-missing" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <button
        className="acestep-model-loader__load-btn"
        onClick={handleLoad}
        disabled={!allSelected || !allExist || isLoading || isLoaded}
      >
        {isLoading ? (
          <>
            <Loader2 size={14} className="spin" />
            {t('modelLoader.loading')}
          </>
        ) : isLoaded ? (
          <>
            <CheckCircle2 size={14} />
            {t('modelLoader.loaded')}
          </>
        ) : (
          t('modelLoader.load')
        )}
      </button>

      {!allExist && allSelected && (
        <p className="acestep-model-loader__warning">
          {t('modelLoader.someMissing')}
        </p>
      )}
    </div>
  );
};
