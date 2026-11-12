/**
 * WorkbenchTurnUsage — 本轮消耗（本地 / 云端分开）。
 *
 * 数据来自网关账本按会话增量（AiUsageAPI）：本地 RWKV 与云端模型各自
 * 的输入/输出 token、缓存命中与回退次数。无记录时不渲染，避免空行。
 * 口径：这里只报 token；远端扣了多少积分以云端账单为准，给账单入口，
 * 不做 token→积分换算。
 */
import React from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { AiUsageSplit } from '@/infrastructure/api/service-api/AiUsageAPI';
import { requestCreditsTab } from '@/app/scenes/credits/creditsSceneEvents';
import './WorkbenchTurnUsage.scss';

export interface WorkbenchTurnUsageProps {
  local: AiUsageSplit;
  remote: AiUsageSplit;
  className?: string;
}

const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

const isEmpty = (split: AiUsageSplit): boolean =>
  split.calls === 0 && split.promptTokens === 0 && split.completionTokens === 0;

export const WorkbenchTurnUsage: React.FC<WorkbenchTurnUsageProps> = ({
  local,
  remote,
  className,
}) => {
  const { t } = useI18n('common');

  if (isEmpty(local) && isEmpty(remote)) return null;

  const fallback = local.fallbackCalls + remote.fallbackCalls;
  const unknown = local.unknownUsageCalls + remote.unknownUsageCalls;
  const cached = local.cachedPromptTokens + remote.cachedPromptTokens;

  return (
    <div className={`ai00-x-turn-usage${className ? ` ${className}` : ''}`}>
      <span className="ai00-x-turn-usage__label">
        {t('nav.workbenchWindow.usage.round')}
      </span>
      {!isEmpty(local) && (
        <span className="ai00-x-turn-usage__item">
          <span className="ai00-x-turn-usage__tag">{t('nav.workbenchWindow.usage.local')}</span>
          <span className="ai00-x-turn-usage__num">
            ↑{fmt(local.promptTokens)} ↓{fmt(local.completionTokens)}
          </span>
        </span>
      )}
      {!isEmpty(remote) && (
        <span className="ai00-x-turn-usage__item">
          <span className="ai00-x-turn-usage__tag">{t('nav.workbenchWindow.usage.cloud')}</span>
          <span className="ai00-x-turn-usage__num">
            ↑{fmt(remote.promptTokens)} ↓{fmt(remote.completionTokens)}
          </span>
        </span>
      )}
      {!isEmpty(remote) && (
        // 口径标注：云端 token 取自客户端网关记录，权威扣费以服务端账单为准
        <span className="ai00-x-turn-usage__item is-muted">
          {t('nav.workbenchWindow.usage.cloudNote')}
        </span>
      )}
      {cached > 0 && (
        <span className="ai00-x-turn-usage__item is-muted">
          {t('nav.workbenchWindow.usage.cached')} {fmt(cached)}
        </span>
      )}
      {fallback > 0 && (
        <span className="ai00-x-turn-usage__item is-warning">
          {t('nav.workbenchWindow.usage.fallback')} {fallback}
        </span>
      )}
      {unknown > 0 && (
        <span className="ai00-x-turn-usage__item is-muted">
          {t('nav.workbenchWindow.usage.unknown')} {unknown}
        </span>
      )}
      <button
        type="button"
        className="ai00-x-turn-usage__link"
        onClick={() => requestCreditsTab('usage')}
      >
        {t('nav.workbenchWindow.usage.credits')}
      </button>
    </div>
  );
};

export default WorkbenchTurnUsage;
