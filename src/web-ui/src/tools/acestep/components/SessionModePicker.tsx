/**
 * SessionModePicker — modal dialog for choosing session creation mode.
 *
 * Shown when the user clicks "New Session". Offers two choices:
 * - text2music: generate a complete song in one step (existing behavior)
 * - lego: multi-step layered creation (backing → vocals → drums → ...)
 */

import React from 'react';
import { Music, Layers, X } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { SessionMode } from '../types';
import './SessionModePicker.scss';

interface SessionModePickerProps {
  open: boolean;
  onSelect: (mode: SessionMode) => void;
  onCancel: () => void;
}

export const SessionModePicker: React.FC<SessionModePickerProps> = ({
  open,
  onSelect,
  onCancel,
}) => {
  const { t } = useI18n('acestep');

  if (!open) return null;

  const modes: {
    id: SessionMode;
    icon: React.ReactNode;
    title: string;
    desc: string;
    detail: string;
  }[] = [
    {
      id: 'text2music',
      icon: <Music size={28} />,
      title: t('modePicker.text2music.title', { defaultValue: '从零创作' }),
      desc: t('modePicker.text2music.desc', { defaultValue: '完整歌曲 · 一步生成' }),
      detail: t('modePicker.text2music.detail', {
        defaultValue: '描述你想要的歌曲，AI 直接生成完整作品',
      }),
    },
    {
      id: 'lego',
      icon: <Layers size={28} />,
      title: t('modePicker.lego.title', { defaultValue: '分层创作' }),
      desc: t('modePicker.lego.desc', { defaultValue: '逐层叠加 · 多步生成' }),
      detail: t('modePicker.lego.detail', {
        defaultValue: '先生成伴奏，再逐步添加人声、鼓点等轨道',
      }),
    },
  ];

  return (
    <div className="session-mode-picker__overlay" onClick={onCancel}>
      <div
        className="session-mode-picker__dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="session-mode-picker__close"
          onClick={onCancel}
          title={t('common.cancel', { defaultValue: '取消' })}
        >
          <X size={18} />
        </button>

        <h2 className="session-mode-picker__title">
          {t('modePicker.title', { defaultValue: '选择创作模式' })}
        </h2>

        <div className="session-mode-picker__cards">
          {modes.map((m) => (
            <button
              key={m.id}
              className="session-mode-picker__card"
              onClick={() => onSelect(m.id)}
            >
              <div className="session-mode-picker__card-icon">{m.icon}</div>
              <div className="session-mode-picker__card-body">
                <div className="session-mode-picker__card-title">{m.title}</div>
                <div className="session-mode-picker__card-desc">{m.desc}</div>
                <div className="session-mode-picker__card-detail">{m.detail}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
