/**
 * MembershipView — 会员套餐页。
 *
 * 五档套餐对比（free/basic/pro/flagship），当前档位高亮。
 * 每日签到已迁至消耗首页（UsageView）。支付未接入：升级按钮仅提示。
 * 纪律：积分只以积分数字展示，严禁折算人民币。
 */

import React, { useEffect } from 'react';
import { TrendingUp } from 'lucide-react';
import { Button, toastWarning, Skeleton } from '@/component-library';
import { useCreditsStore } from './creditsStore';
import type { PlanDefinition } from '@/infrastructure/api/service-api/BillingApi';

/** plan_tier → 中文名兜底映射（服务端 display_name 优先） */
const TIER_FALLBACK_NAMES: Record<string, string> = {
  free: '免费版',
  basic: '基础版',
  pro: '专业版',
  flagship: '旗舰版',
};

function tierDisplayName(plan: PlanDefinition): string {
  return plan.display_name || TIER_FALLBACK_NAMES[plan.plan_tier] || plan.plan_tier;
}

/** 月价：分 → 元（整除不带小数，否则两位小数） */
function fmtPriceYuan(priceCents: number): string {
  const yuan = priceCents / 100;
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
}

/** 折扣 → 「X 折」（0.9 → 9 折，0.85 → 8.5 折） */
function fmtDiscount(discount: number): string {
  const zhe = Number((discount * 10).toFixed(1));
  return `${Number.isInteger(zhe) ? zhe : zhe.toFixed(1)} 折`;
}

const MembershipView: React.FC = () => {
  const { summary, plans, loadingSummary, loadingPlans, loadSummary, loadPlans } = useCreditsStore();

  useEffect(() => {
    loadSummary();
    loadPlans();
  }, [loadSummary, loadPlans]);

  const handleUpgrade = (plan: PlanDefinition) => {
    toastWarning(`「${tierDisplayName(plan)}」套餐升级即将开放，敬请期待`);
  };

  const currentTier = summary?.plan_tier ?? null;

  return (
    <div className="ai00-x-credits-membership">
      {/* 五档套餐对比 */}
      <section className="ai00-x-credits-plans" aria-label="会员套餐">
        {loadingPlans && plans.length === 0
          ? Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} style={{ height: 'var(--size-gap-14)' }} />
            ))
          : plans.map(plan => {
              const isCurrent = plan.plan_tier === currentTier;
              const isFree = plan.price_cents <= 0;
              const discount = plan.model_discount ?? 1;
              return (
                <article
                  key={plan.id}
                  className={[
                    'ai00-x-credits-plan-card',
                    isCurrent && 'ai00-x-credits-plan-card--current',
                  ].filter(Boolean).join(' ')}
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  {isCurrent && <span className="ai00-x-credits-plan-card__ribbon">当前套餐</span>}
                  <h4 className="ai00-x-credits-plan-card__name">{tierDisplayName(plan)}</h4>
                  <div className="ai00-x-credits-plan-card__price ds-data">
                    {isFree ? '免费' : `¥${fmtPriceYuan(plan.price_cents)}`}
                    {!isFree && <span className="ai00-x-credits-plan-card__price-unit">/月</span>}
                  </div>
                  <div className="ai00-x-credits-plan-card__credits">
                    <span className="ai00-x-credits-plan-card__credits-value ds-data">
                      {plan.monthly_credits}
                    </span>
                    <span className="ai00-x-credits-plan-card__credits-unit">积分/月</span>
                  </div>
                  {discount > 0 && discount < 1 && (
                    <div className="ai00-x-credits-plan-card__perk">
                      <TrendingUp size={13} aria-hidden />
                      热门模型 {fmtDiscount(discount)}
                    </div>
                  )}
                  <div className="ai00-x-credits-plan-card__action">
                    {isCurrent ? (
                      <Button variant="secondary" size="small" disabled>
                        使用中
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        size="small"
                        onClick={() => handleUpgrade(plan)}
                      >
                        升级
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
      </section>

      {loadingSummary && !summary && (
        <Skeleton style={{ height: 'var(--size-gap-4)', marginTop: 'var(--size-gap-4)' }} />
      )}
    </div>
  );
};

export default MembershipView;
