/**
 * RechargeView — 积分充值页。
 *
 * 手游充值九宫格风格：档位卡片网格（数据全部来自 GET /recharge/specs）。
 * 当前积分余额展示已迁至消耗首页（UsageView）。
 * 支付未接入：点击档位仅弹确认提示。
 * 纪律：积分只以积分数字展示，严禁出现任何"积分↔人民币换算率"。
 */

import React, { useEffect } from 'react';
import { Sparkles, Gift } from 'lucide-react';
import { confirmDialog, Skeleton } from '@/component-library';
import { useCreditsStore } from './creditsStore';
import type { RechargeSpec } from '@/infrastructure/api/service-api/BillingApi';

/** 分 → 元展示（整除不带小数，否则保留两位） */
function fmtYuan(priceCents: number): string {
  const yuan = priceCents / 100;
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
}

const RechargeView: React.FC = () => {
  const { specs, loadingSpecs, loadSpecs } = useCreditsStore();

  useEffect(() => {
    loadSpecs();
  }, [loadSpecs]);

  const handlePickSpec = async (spec: RechargeSpec) => {
    const totalCredits = spec.credits + (spec.bonus_credits || 0);
    const bonusNote = spec.bonus_credits > 0 ? `（含赠送 ${spec.bonus_credits} 积分）` : '';
    await confirmDialog({
      title: '确认充值',
      message: `将购买「${spec.label}」：${totalCredits} 积分${bonusNote}，售价 ¥${fmtYuan(spec.price_cents)}。支付渠道接入后即可完成购买。
把 Ai00-X 分享给好友，TA 每次充值你都拿分红——首年 10%，之后年年有。`,
      type: 'info',
      confirmText: '知道了',
      showCancel: false,
    });
  };

  return (
    <div className="ai00-x-credits-recharge">
      {/* 档位九宫格 */}
      <section className="ai00-x-credits-recharge__grid" aria-label="充值档位">
        {loadingSpecs && specs.length === 0
          ? Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} style={{ height: 'var(--size-gap-12)' }} />
            ))
          : specs.map(spec => {
              const hasBonus = spec.bonus_credits > 0;
              return (
                <button
                  key={spec.id}
                  type="button"
                  className="ai00-x-credits-recharge__card ds-hover-glow"
                  onClick={() => handlePickSpec(spec)}
                >
                  {hasBonus && (
                    <span className="ai00-x-credits-recharge__bonus">
                      <Gift size={12} aria-hidden />
                      含赠送 {spec.bonus_credits}
                    </span>
                  )}
                  <span className="ai00-x-credits-recharge__credits ds-data">
                    {spec.credits + (spec.bonus_credits || 0)}
                  </span>
                  <span className="ai00-x-credits-recharge__credits-unit">
                    <Sparkles size={12} aria-hidden />
                    积分
                  </span>
                  <span className="ai00-x-credits-recharge__price ds-data">
                    ¥{fmtYuan(spec.price_cents)}
                  </span>
                </button>
              );
            })}
      </section>

      {!loadingSpecs && specs.length === 0 && (
        <p className="ai00-x-credits-recharge__empty">充值档位暂未开放，敬请期待。</p>
      )}
    </div>
  );
};

export default RechargeView;
