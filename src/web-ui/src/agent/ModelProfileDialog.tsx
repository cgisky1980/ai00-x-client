/**
 * ModelProfileDialog — 新建 / 编辑模型组合。
 *
 * 一行一个阶段：规划 / 执行 / 评审 / 兜底 / 调研，各自选模型（本地或云端），
 * 选完即可保存为组合；模型选择器里直接选组合即可应用。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button, Modal, Select, type SelectOption } from '@/component-library';
import { useNotification } from '@/shared/notification-system';
import {
  AGENT_STAGES,
  AGENT_STAGE_HINTS,
  AGENT_STAGE_LABELS,
  deleteProfile,
  loadAgentModelOptions,
  saveProfile,
  type AgentModelOption,
  type AgentModelProfile,
  type AgentStage,
} from '@/agent/modelProfiles';
import './ModelProfileDialog.scss';

export interface ModelProfileDialogProps {
  open: boolean;
  /** null = 新建；非空 = 编辑该组合。 */
  profile: AgentModelProfile | null;
  onClose: () => void;
  onSaved?: (profile: AgentModelProfile) => void;
}

function genId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const EMPTY_MODELS: Record<AgentStage, string> = {
  plan: 'ai00-api',
  execute: 'rwkv-local',
  review: 'ai00-api',
  fallback: 'ai00-api',
  research: 'ai00-auto',
};

export const ModelProfileDialog: React.FC<ModelProfileDialogProps> = ({
  open,
  profile,
  onClose,
  onSaved,
}) => {
  const notification = useNotification();
  const [name, setName] = useState('');
  const [models, setModels] = useState<Record<AgentStage, string>>(EMPTY_MODELS);
  const [options, setOptions] = useState<AgentModelOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? '');
    setModels(profile ? { ...EMPTY_MODELS, ...profile.models } : { ...EMPTY_MODELS });
    setLoading(true);
    let cancelled = false;
    void loadAgentModelOptions()
      .then(next => {
        if (!cancelled) setOptions(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, profile]);

  const selectOptions: SelectOption[] = useMemo(
    () =>
      options.map(option => ({
        label:
          option.multiplier !== undefined
            ? `${option.label} · ${option.multiplier.toFixed(2)}x`
            : option.label,
        value: option.value,
        group: option.group,
      })),
    [options],
  );

  const handleSave = useCallback((): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      notification.warning('请先给组合起个名字');
      return;
    }
    const saved = saveProfile({
      id: profile?.id ?? genId(),
      name: trimmed,
      models,
    });
    notification.success(`已保存组合「${saved.name}」`);
    onSaved?.(saved);
    onClose();
  }, [models, name, notification, onClose, onSaved, profile]);

  const handleDelete = useCallback((): void => {
    if (!profile || profile.builtin) return;
    deleteProfile(profile.id);
    notification.success(`已删除组合「${profile.name}」`);
    onClose();
  }, [notification, onClose, profile]);

  return (
    <Modal isOpen={open} onClose={onClose} title={profile ? '编辑模型组合' : '新建模型组合'} size="large">
      <div className="ai00-x-model-profile">
        <label className="ai00-x-model-profile__name">
          <span className="ai00-x-model-profile__name-label">组合名称</span>
          <input
            className="ai00-x-model-profile__name-input"
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="例如：本地省钱 / 云端低价执行"
          />
        </label>

        <div className="ai00-x-model-profile__rows">
          {AGENT_STAGES.map(stage => (
            <div key={stage} className="ai00-x-model-profile__row">
              <div className="ai00-x-model-profile__row-text">
                <span className="ai00-x-model-profile__row-label">{AGENT_STAGE_LABELS[stage]}</span>
                <span className="ai00-x-model-profile__row-hint">{AGENT_STAGE_HINTS[stage]}</span>
              </div>
              <Select
                className="ai00-x-model-profile__select"
                size="small"
                value={models[stage]}
                onChange={value => {
                  const next = typeof value === 'string' ? value : String(value ?? '');
                  setModels(prev => ({ ...prev, [stage]: next }));
                }}
                options={selectOptions}
                disabled={loading}
              />
            </div>
          ))}
        </div>

        <p className="ai00-x-model-profile__note">
          执行 / 评审 / 兜底 / 调研会写入工人定义，切换后需要引擎重启；引擎空闲时会自动重启，
          有会话运行中则稍后手动重启生效。规划模型直接切到当前会话。
        </p>

        <div className="ai00-x-model-profile__footer">
          {profile && !profile.builtin ? (
            <Button variant="ghost" size="small" onClick={handleDelete}>
              <Trash2 size={13} />
              删除
            </Button>
          ) : (
            <span />
          )}
          <div className="ai00-x-model-profile__footer-actions">
            <Button variant="secondary" size="small" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" size="small" onClick={handleSave}>
              保存组合
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default ModelProfileDialog;
