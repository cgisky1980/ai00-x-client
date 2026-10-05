/**
 * ModelSelector — 本地音乐合成模型（DiT 档位）选择器。
 *
 * 交互与旧 MusicModelSelector 一致：PopoverTrigger asChild 锚定弹层，
 * 列出 Base Q5/Q8、XL Base Q5/Q8 四档（大小、XL/2B 徽标、选中勾）；
 * 未下载的档位带下载按钮，下载时触发整套 bundle（text encoder + DiT +
 * VAE）并在触发器/行内显示百分比进度。选中档位 localStorage 持久化
 * （与旧选择器同 key）。
 */

import React, { useMemo, useState } from 'react';
import { Music, ChevronDown, Check, Download, Loader2 } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { Popover, PopoverTrigger, PopoverContent } from '@/component-library';
import { useCreateStore } from './createStore';
import type { AceStepCatalogEntry } from '../types';

/** Short display name for a DiT catalog entry. */
function ditDisplayName(entry: AceStepCatalogEntry): string {
  if (entry.ditType === 'xl-base') {
    return entry.variant.includes('Q8') ? 'XL Base Q8' : 'XL Base Q5';
  }
  return entry.variant.includes('Q8') ? 'Base Q8' : 'Base Q5';
}

function formatSize(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  return `${(bytes / 1_000_000).toFixed(0)}MB`;
}

export interface ModelSelectorProps {
  /** 下拉开合透传（外层悬停容器需要知道下拉开着以保持展开）。 */
  onOpenChange?: (open: boolean) => void;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ onOpenChange }) => {
  const { t } = useI18n('acestep');
  const [open, setOpen] = useState(false);
  const catalog = useCreateStore((s) => s.catalog);
  const selectedDit = useCreateStore((s) => s.selectedDit);
  const selectModel = useCreateStore((s) => s.selectModel);
  const downloadModel = useCreateStore((s) => s.downloadModel);
  const downloadTasks = useCreateStore((s) => s.downloadTasks);
  const downloadProgress = useCreateStore((s) => s.downloadProgress);

  const selectedEntry = useMemo(
    () => catalog.find((e) => e.filename === selectedDit) ?? null,
    [catalog, selectedDit],
  );

  /** Per-entry download percent (task ids are catalog entry ids). */
  const progressFor = (entry: AceStepCatalogEntry): number | null => {
    const p = downloadProgress[entry.id];
    if (!p || p.total <= 0) return null;
    return Math.round((p.progress / p.total) * 100);
  };

  /** Overall bundle progress across active tasks (null while idle). */
  const overallPercent = useMemo(() => {
    const tasks = downloadTasks
      .map((id) => downloadProgress[id])
      .filter((p): p is NonNullable<typeof p> => Boolean(p) && (p?.total ?? 0) > 0);
    if (downloadTasks.length === 0 || tasks.length === 0) return null;
    const total = tasks.reduce((sum, p) => sum + p.total, 0);
    const done = tasks.reduce((sum, p) => sum + p.progress, 0);
    return Math.round((done / total) * 100);
  }, [downloadTasks, downloadProgress]);

  const triggerLabel = selectedEntry
    ? ditDisplayName(selectedEntry)
    : t('create.modelPick');

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        onOpenChange?.(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ai00-x-model-select__trigger"
          title={t('create.modelTitle')}
        >
          <Music size={13} />
          <span className="ai00-x-model-select__label">{triggerLabel}</span>
          {overallPercent !== null && (
            <span className="ai00-x-model-select__progress">
              <Loader2 size={10} className="ai00-x-create__spin" />
              {overallPercent}%
            </span>
          )}
          <ChevronDown size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="ai00-x-model-select__menu">
        {!catalog.some((e) => e.exists) && (
          <p className="ai00-x-model-select__hint">{t('create.modelNoneHint')}</p>
        )}
        {catalog.map((entry) => {
          const isSelected = selectedDit === entry.filename;
          const pct = progressFor(entry);
          return (
            <div
              key={entry.id}
              className={`ai00-x-model-select__row${isSelected ? ' is-selected' : ''}${!entry.exists ? ' is-missing' : ''}`}
            >
              <button
                type="button"
                className="ai00-x-model-select__option"
                disabled={!entry.exists || downloadTasks.length > 0}
                onClick={() => {
                  selectModel(entry.filename);
                  setOpen(false);
                }}
              >
                <span className="ai00-x-model-select__name">
                  {ditDisplayName(entry)}
                  <span className="ai00-x-model-select__badge">
                    {entry.ditType === 'xl-base' ? 'XL' : '2B'}
                  </span>
                </span>
                <span className="ai00-x-model-select__meta">
                  {entry.exists ? formatSize(entry.approxSizeBytes) : t('create.modelMissing')}
                </span>
                {isSelected && <Check size={13} />}
              </button>
              {!entry.exists && pct === null && (
                <button
                  type="button"
                  className="ai00-x-model-select__download"
                  disabled={downloadTasks.length > 0}
                  title={t('create.modelDownload')}
                  onClick={() => void downloadModel(entry.filename)}
                >
                  <Download size={12} />
                </button>
              )}
              {pct !== null && (
                <span className="ai00-x-model-select__progress">
                  <Loader2 size={10} className="ai00-x-create__spin" />
                  {pct}%
                </span>
              )}
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
};

export default ModelSelector;
