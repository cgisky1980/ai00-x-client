/**
 * ModelSelector —— AI 模型选择器（v0.16 AI 系，纯 UI / props 数据注入 / 零 store）
 *
 * 标准对话输入框的可切换模型件：胶囊 Trigger（当前模型名 + ChevronDown）
 * + Popover 分组列表（当前项 Check 高亮 / disabled 置灰）。
 * 数据形状与 dsh session.models 同构但泛化——消费方负责取数与写入。
 */
import { useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../components/popover';
import { label } from '../../../../lib/labels';
import './ModelSelector.scss';

/** 单个模型项。 */
export interface ModelOption {
  id: string;
  name: string;
  /** 副文本（价格/说明等，列表行内灰字） */
  description?: string;
  /** 徽章文本（tier/档位等，随模型名展示） */
  badge?: string;
  /** 置灰不可选（额度耗尽/权限不足等；title 提示原因） */
  disabled?: boolean;
  disabledReason?: string;
}

/** 模型分组（provider）。 */
export interface ModelGroup {
  id: string;
  /** 分组名（缺省不渲染组头） */
  name?: string;
  models: ModelOption[];
}

export interface ModelSelectorProps {
  groups: ModelGroup[];
  /** 当前模型 id（跨组匹配；null/未命中显示占位） */
  currentId?: string | null;
  onSelect(groupId: string, modelId: string): void;
  /** 目录加载中（Trigger 显示 muted 占位并禁用） */
  loading?: boolean;
  /** Trigger 胶囊尺寸：sm=输入框 footer 内嵌 / md=独立场景 */
  size?: 'sm' | 'md';
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  className?: string;
}

export function ModelSelector({
  groups,
  currentId,
  onSelect,
  loading = false,
  size = 'sm',
  side = 'top',
  align = 'start',
  className = '',
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const current = useMemo(() => {
    for (const g of groups) {
      const hit = g.models.find(m => m.id === currentId);
      if (hit) return hit;
    }
    return null;
  }, [groups, currentId]);

  const triggerLabel = loading
    ? label('components.ai.modelLoading', '模型加载中…')
    : current?.name ?? currentId ?? label('components.ai.modelEmpty', '选择模型');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={[
            'ai-model-selector',
            `ai-model-selector--${size}`,
            open && 'is-open',
            className,
          ]
            .filter(Boolean)
            .join(' ')}
          disabled={loading || groups.length === 0}
          aria-label={label('components.ai.modelSelect', '切换模型')}
        >
          <span className="ai-model-selector__name" title={triggerLabel}>
            {triggerLabel}
          </span>
          <svg
            className="ai-model-selector__chevron"
            viewBox="0 0 12 12"
            aria-hidden="true"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
          >
            <path
              d="M2.5 4.5L6 8L9.5 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} align={align} className="ai-model-selector__popover">
        {groups.map(g => (
          <div key={g.id} className="ai-model-selector__group">
            {g.name && <div className="ai-model-selector__group-name">{g.name}</div>}
            {g.models.map(m => {
              const active = m.id === currentId;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={[
                    'ai-model-selector__item',
                    active && 'is-active',
                    m.disabled && 'is-disabled',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    if (m.disabled) return;
                    onSelect(g.id, m.id);
                    setOpen(false);
                  }}
                  title={m.disabled ? m.disabledReason : m.description}
                >
                  <span className="ai-model-selector__item-name">{m.name}</span>
                  {m.badge && <span className="ai-model-selector__item-badge">{m.badge}</span>}
                  {active && (
                    <svg className="ai-model-selector__check" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M2 6.5L4.8 9.2L10 3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
