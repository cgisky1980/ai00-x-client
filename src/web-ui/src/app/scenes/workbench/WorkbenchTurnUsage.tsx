/**
 * WorkbenchTurnUsage — 本轮消耗（本地 / 云端分开）。
 *
 * 数据来自网关账本按会话增量（AiUsageAPI）：本地 RWKV 与云端模型各自
 * 的输入/输出 token、缓存命中与回退次数。无记录时不渲染，避免空行。
 * 只报 token：远端扣了多少积分以云端账单为准，这里不做换算，也不放跳转
 * 链接（工作台窗口没有积分中心场景，跳转本来就是死链）。
 */
import React from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { AiUsageSplit } from '@/infrastructure/api/service-api/AiUsageAPI';
import { formatCredits } from '@/infrastructure/api/service-api/AiUsageAPI';
import './WorkbenchTurnUsage.scss';

export interface WorkbenchTurnUsageProps {
  local: AiUsageSplit;
  remote: AiUsageSplit;
  /**
   * 本轮远端调用的积分消耗（服务端账单口径）。
   * `null` = 还没查到（未登录 / 尚未结算），此时不显示积分。
   */
  remoteCredits?: number | null;
  className?: string;
}

const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

const isEmpty = (split: AiUsageSplit): boolean =>
  split.calls === 0 && split.promptTokens === 0 && split.completionTokens === 0;

export const WorkbenchTurnUsage: React.FC<WorkbenchTurnUsageProps> = ({
  local,
  remote,
  remoteCredits = null,
  className,
}) => {
  const { t } = useI18n('common');

  if (isEmpty(local) && isEmpty(remote)) return null;

  const fallback = local.fallbackCalls + remote.fallbackCalls;
  const unknown = local.unknownUsageCalls + remote.unknownUsageCalls;
  const cached = local.cachedPromptTokens;

  return (
    <div className={`ai00-x-turn-usage${className ? ` ${className}` : ''}`}>
      <span className="ai00-x-turn-usage__meta">
        <span className="ai00-x-turn-usage__label">
          {t('nav.workbenchWindow.usage.round')}
        </span>
        {!isEmpty(local) && (
          <span className="ai00-x-turn-usage__item is-muted">
            <span className="ai00-x-turn-usage__tag">{t('nav.workbenchWindow.usage.local')}</span>
            <span className="ai00-x-turn-usage__num">
              ↑{fmt(local.promptTokens)} ↓{fmt(local.completionTokens)}
            </span>
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
      </span>
      {/* 云端积分是主角：辅行右端、交互色、等宽数字 */}
      {!isEmpty(remote) && (
        <span className="ai00-x-turn-usage__item is-credits">
          <span className="ai00-x-turn-usage__tag">{t('nav.workbenchWindow.usage.cloud')}</span>
          <span className="ai00-x-turn-usage__num">
            {remoteCredits === null
              ? t('nav.workbenchWindow.usage.creditsPending')
              : `${formatCredits(remoteCredits)} ${t('nav.workbenchWindow.usage.creditsUnit')}`}
          </span>
        </span>
      )}
    </div>
  );
};

export default WorkbenchTurnUsage;
