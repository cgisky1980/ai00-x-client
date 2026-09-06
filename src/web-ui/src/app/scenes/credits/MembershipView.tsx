/**
 * MembershipView — 会员套餐页。
 *
 * 五档套餐对比（free/standard/plus/pro/max），当前档位高亮；
 * 附带每日签到入口（月历式，显示今日是否已签、本月签到记录），
 * 签到成功后刷新积分余额。支付未接入：升级按钮仅提示。
 * 纪律：积分只以积分数字展示，严禁折算人民币。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, TrendingUp } from 'lucide-react';
import { Button, Tag, toast, toastSuccess, toastWarning, Skeleton } from '@/component-library';
import { useCreditsStore } from './creditsStore';
import type { PlanDefinition } from '@/infrastructure/api/service-api/BillingApi';

/** plan_tier → 中文名兜底映射（服务端 display_name 优先） */
const TIER_FALLBACK_NAMES: Record<string, string> = {
  free: '免费',
  standard: '标准',
  plus: '进阶',
  pro: '旗舰',
  max: '至尊',
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

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const MembershipView: React.FC = () => {
  const {
    summary,
    plans,
    signinStatus,
    loadingSummary,
    loadingPlans,
    loadingSignin,
    loadSummary,
    loadPlans,
    loadSignin,
    doSignin,
  } = useCreditsStore();

  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    loadSummary();
    loadPlans();
    loadSignin();
  }, [loadSummary, loadPlans, loadSignin]);

  const todaySigned = signinStatus?.today_signed ?? false;

  // 本月签到日历数据
  const calendar = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-based
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // 周一起始的偏移
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const signedSet = new Set((signinStatus?.signed_dates ?? []).map(d => d.slice(0, 10)));
    const cells: { day: number; dateStr: string; signed: boolean; isToday: boolean }[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${pad2(month + 1)}-${pad2(day)}`;
      cells.push({
        day,
        dateStr,
        signed: signedSet.has(dateStr),
        isToday: day === now.getDate(),
      });
    }
    return { leadingBlanks: firstWeekday, cells };
  }, [signinStatus?.signed_dates]);

  const handleSignin = async () => {
    if (signingIn || todaySigned) return;
    setSigningIn(true);
    try {
      const result = await doSignin();
      if (result.already_signed) {
        toastWarning('今日已签到过啦');
      } else {
        toastSuccess(`签到成功，获得 ${result.credits_granted} 积分`, {
              description: '余额已刷新 · 邀请好友充值，你也拿分红',
            });
      }
    } catch {
      toast('签到失败，请稍后重试', { variant: 'error' });
    } finally {
      setSigningIn(false);
    }
  };

  const handleUpgrade = (plan: PlanDefinition) => {
    toastWarning(`「${tierDisplayName(plan)}」套餐升级即将开放，敬请期待`);
  };

  const currentTier = summary?.plan_tier ?? null;

  return (
    <div className="ai00-x-credits-membership">
      {/* 每日签到 */}
      <section className="ai00-x-credits-signin" aria-label="每日签到">
        <div className="ai00-x-credits-signin__info">
          <h3 className="ai00-x-credits-signin__title">
            <CalendarCheck size={16} aria-hidden />
            每日签到
          </h3>
          <p className="ai00-x-credits-signin__desc">
            {todaySigned ? '今日已签到，明天再来吧。' : '签到领取积分奖励，连续签到不间断。'}
          </p>
          <Button
            variant="primary"
            size="small"
            onClick={handleSignin}
            disabled={todaySigned}
            isLoading={signingIn}
          >
            {todaySigned ? '已签到' : '立即签到'}
          </Button>
        </div>
        <div className="ai00-x-credits-signin__calendar" aria-label="本月签到记录">
          <div className="ai00-x-credits-signin__calendar-grid">
            {WEEKDAY_LABELS.map(w => (
              <span key={w} className="ai00-x-credits-signin__calendar-weekday">{w}</span>
            ))}
            {Array.from({ length: calendar.leadingBlanks }, (_, i) => (
              <span key={`blank-${i}`} />
            ))}
            {calendar.cells.map(cell => (
              <span
                key={cell.dateStr}
                className={[
                  'ai00-x-credits-signin__calendar-day ds-data',
                  cell.signed && 'ai00-x-credits-signin__calendar-day--signed',
                  cell.isToday && 'ai00-x-credits-signin__calendar-day--today',
                ].filter(Boolean).join(' ')}
                title={cell.signed ? `${cell.dateStr} 已签到` : cell.dateStr}
              >
                {cell.day}
              </span>
            ))}
          </div>
          {loadingSignin && !signinStatus && (
            <Skeleton style={{ height: 'var(--size-gap-7)', marginTop: 'var(--size-gap-2)' }} />
          )}
        </div>
      </section>

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
                  <header className="ai00-x-credits-plan-card__head">
                    <h4 className="ai00-x-credits-plan-card__name">{tierDisplayName(plan)}</h4>
                    {isCurrent && <Tag color="blue">当前套餐</Tag>}
                  </header>
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
                      <TrendingUp size={12} aria-hidden />
                      热门模型 {fmtDiscount(discount)}
                    </div>
                  )}
                  <div className="ai00-x-credits-plan-card__action">
                    {isCurrent ? (
                      <Button variant="secondary" size="small" disabled>
                        当前套餐
                      </Button>
                    ) : (
                      <Button variant="primary" size="small" onClick={() => handleUpgrade(plan)}>
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
