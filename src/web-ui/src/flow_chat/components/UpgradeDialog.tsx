/**
 * UpgradeDialog — 占位升级弹窗
 *
 * 当用户选择超出当前订阅等级的模型时弹出。
 * 当前仅提示，无支付入口（后续接入）。
 */

import React from 'react';
import { Lock } from 'lucide-react';
import { Modal } from '@/component-library';
import { useTranslation } from 'react-i18next';

/// 后端 tier → 套餐中文名（与 ai_channel_pools.xf_plan_name 对应）
const TIER_NAME: Record<string, string> = {
  free: '无忧版',
  cheap: '专业版',
  expensive: '高效版',
};

interface UpgradeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  modelName: string;
  requiredTier: string;
  currentTier?: string | null;
}

export const UpgradeDialog: React.FC<UpgradeDialogProps> = ({
  isOpen,
  onClose,
  modelName,
  requiredTier,
  currentTier,
}) => {
  const { t } = useTranslation('flow-chat');

  const requiredName = TIER_NAME[requiredTier] || requiredTier;
  const currentName = currentTier ? TIER_NAME[currentTier] || currentTier : '-';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modelSelector.upgrade.title')}
      size="small"
      closeOnOverlayClick
    >
      <div
        style={{
          textAlign: 'center',
          padding: '24px 16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <div
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: 'rgba(251, 146, 60, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Lock size={28} color="rgba(251, 146, 60, 0.9)" />
        </div>

        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>{modelName}</h3>

        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '14px' }}>
          {t('modelSelector.upgrade.required', { tier: requiredName })}
        </p>

        <p style={{ margin: 0, color: 'var(--text-tertiary)', fontSize: '13px' }}>
          {t('modelSelector.upgrade.current', { tier: currentName })}
        </p>

        <p
          style={{
            margin: '8px 0 0',
            color: 'var(--text-tertiary)',
            fontSize: '12px',
            fontStyle: 'italic',
          }}
        >
          {t('modelSelector.upgrade.comingSoon')}
        </p>

        <button
          onClick={onClose}
          style={{
            marginTop: '8px',
            padding: '8px 24px',
            borderRadius: '6px',
            border: 'none',
            background: 'rgb(var(--primary))',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          {t('modelSelector.upgrade.close')}
        </button>
      </div>
    </Modal>
  );
};
