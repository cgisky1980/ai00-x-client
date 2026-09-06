/**
 * InviteView — 邀请有礼页（积分中心第三页签）。
 *
 * 功能（契约：参考/邀请码机制-实施方案设计.md v2.11）：
 * - 领取制邀请码：未领取态（朱砂 CTA）/ 已领取态（码 + 复制链接），一人一码终身唯一
 * - 本月待结算分红实时展示（accrued，月底结算前不可用）
 * - 邀请记录（昵称打码 + 状态 + 分红）
 * - 会员打折券：分档（basic/pro/flagship），累计付费邀请数解锁，分红兑换，每月限兑
 * - 奖励规则折叠面板
 *
 * 视觉纪律（新东方极简）：墨阶 token 表面、衬线标题、mono+tabular 数字
 * （.ds-data）、朱砂 --color-brand-seal 一屏一处（领码/复制 CTA）。
 * 口径纪律：积分只以积分数字展示，严禁出现积分↔人民币换算率。
 *
 * 文案说明：credits 场景现有页面（RechargeView/MembershipView）均为中文硬编码，
 * 本页保持一致；场景整体 i18n 化另行统一处理。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Gift, Link2, Ticket, Users } from 'lucide-react';
import { Button, Tag, toast, toastSuccess, Skeleton } from '@/component-library';
import { createLogger } from '@/shared/utils/logger';
import {
  claimInviteCode,
  exchangeCoupon,
  getInviteCoupons,
  getInviteSummary,
  listInvitees,
  type InviteCoupon,
  type InviteCouponTier,
  type InviteeEntry,
  type InviteSummary,
} from '@/infrastructure/api/service-api/InviteApi';

const log = createLogger('InviteView');

/** 事件埋点（invite_* 事件族，用于 k 系数与转化分析） */
function track(event: string, data?: Record<string, unknown>): void {
  log.info(`invite_telemetry ${event}`, data);
}

/** 折扣率 → 「X 折」 */
function fmtDiscount(discount: number): string {
  const zhe = Number((discount * 10).toFixed(1));
  return `${Number.isInteger(zhe) ? zhe : zhe.toFixed(1)} 折`;
}

function fmtDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '';
}

/** 邀请状态 → 展示 */
const STATUS_META: Record<InviteeEntry['status'], { label: string; tone: 'done' | 'pending' }> = {
  pending: { label: '未充值', tone: 'pending' },
  activated: { label: '已充值', tone: 'done' },
  retained: { label: '留存达标', tone: 'done' },
};

const InviteView: React.FC = () => {
  const [summary, setSummary] = useState<InviteSummary | null>(null);
  const [invitees, setInvitees] = useState<InviteeEntry[]>([]);
  const [tiers, setTiers] = useState<InviteCouponTier[]>([]);
  const [coupons, setCoupons] = useState<InviteCoupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [exchangingKey, setExchangingKey] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    const [summaryRes, listRes, couponRes] = await Promise.allSettled([
      getInviteSummary(),
      listInvitees(),
      getInviteCoupons(),
    ]);
    if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value);
    if (listRes.status === 'fulfilled') setInvitees(listRes.value.items ?? []);
    if (couponRes.status === 'fulfilled') {
      setTiers(couponRes.value.tiers ?? []);
      setCoupons(couponRes.value.coupons ?? []);
    }
    const allRejected =
      summaryRes.status === 'rejected' && listRes.status === 'rejected' && couponRes.status === 'rejected';
    setLoadFailed(allRejected);
    setLoading(false);
    if (allRejected) {
      log.warn('invite api unavailable (server not deployed?)');
    }
  }, []);

  useEffect(() => {
    track('invite_center_view');
    void load();
  }, [load]);

  const claimed = summary?.code_status === 'claimed';
  const inviteCode = summary?.invite_code ?? '';
  const shareUrl = summary?.share_url ?? '';

  /** 复制分享文案（朱砂 CTA；一屏一处朱砂，两态共用此动作） */
  const handleCopy = useCallback(async () => {
    track('invite_copy', { has_url: Boolean(shareUrl) });
    const text = shareUrl
      ? `我在用 Ai00-X，一个能跑本地 RWKV 的 AI 编程助手，目前邀请制内测、名额有限。用我的邀请码 ${inviteCode} 注册 → ${shareUrl}`
      : inviteCode;
    try {
      await navigator.clipboard.writeText(text);
      toastSuccess('已复制邀请信息，快去分享吧', { description: '好友凭邀请码注册充值，你可得分红' });
    } catch {
      toast('复制失败，请手动复制邀请码', { variant: 'error' });
    }
  }, [inviteCode, shareUrl]);

  const handleClaim = useCallback(async () => {
    setClaiming(true);
    try {
      const next = await claimInviteCode();
      setSummary(next);
      track('invite_claim_success');
      toastSuccess('邀请码已领取，终身专属');
    } catch (err) {
      track('invite_claim_failed');
      toast(err instanceof Error ? err.message : '领取失败，请稍后重试', { variant: 'error' });
    } finally {
      setClaiming(false);
    }
  }, []);

  const handleExchange = useCallback(
    async (tierKey: string) => {
      setExchangingKey(tierKey);
      try {
        const payload = await exchangeCoupon(tierKey);
        setTiers(payload.tiers ?? []);
        setCoupons(payload.coupons ?? []);
        track('invite_coupon_exchange', { tier: tierKey });
        toastSuccess('兑换成功，券已放入券包');
        // 兑换消耗了分红余额，刷新总览
        void getInviteSummary().then(setSummary).catch(() => {});
      } catch (err) {
        toast(err instanceof Error ? err.message : '兑换失败，请稍后重试', { variant: 'error' });
      } finally {
        setExchangingKey(null);
      }
    },
    []
  );

  const quota = summary?.quota;
  const activeCoupons = useMemo(() => coupons.filter(c => c.status === 'active'), [coupons]);

  return (
    <div className="ai00-x-credits-invite">
      {/* 邀请码卡片（领取制两态） */}
      <section className="ai00-x-credits-invite__hero" aria-label="我的邀请码">
        <div className="ai00-x-credits-invite__hero-info">
          <h3 className="ai00-x-credits-invite__hero-title">好友凭你的邀请码充值，你得分红</h3>
          <p className="ai00-x-credits-invite__hero-desc">
            首年 10%，之后年年有；你的分红还能兑换会员打折券
          </p>
        </div>
        {loading ? (
          <Skeleton style={{ height: 'var(--size-gap-9)', width: '220px' }} />
        ) : claimed ? (
          <div className="ai00-x-credits-invite__claimed">
            <div className="ai00-x-credits-invite__code-block">
              <span className="ai00-x-credits-invite__code-label">你的邀请码</span>
              <span className="ai00-x-credits-invite__code ds-data">{inviteCode}</span>
            </div>
            <Button variant="primary" size="small" onClick={() => void handleCopy()}>
              <Link2 size={14} />
              复制邀请
            </Button>
          </div>
        ) : (
          <Button
            variant="primary"
            size="small"
            disabled={claiming}
            onClick={() => void handleClaim()}
            className="ai00-x-credits-invite__claim-cta"
          >
            <Gift size={14} />
            {claiming ? '领取中…' : '领取我的邀请码'}
          </Button>
        )}
      </section>

      {/* 数据总览：名额 / 邀请 / 本月待结算分红 */}
      <section className="ai00-x-credits-invite__stats" aria-label="邀请数据">
        {loading ? (
          <Skeleton style={{ height: 'var(--size-gap-13)' }} />
        ) : loadFailed ? (
          <p className="ai00-x-credits-invite__empty">邀请服务暂不可用，请稍后重试</p>
        ) : (
          <>
            <div className="ai00-x-credits-invite__stat">
              <span className="ai00-x-credits-invite__stat-label">剩余名额</span>
              <span className="ai00-x-credits-invite__stat-value ds-data">{quota?.left ?? 0}</span>
            </div>
            <div className="ai00-x-credits-invite__stat">
              <span className="ai00-x-credits-invite__stat-label">已邀请</span>
              <span className="ai00-x-credits-invite__stat-value ds-data">
                {summary?.invited_count ?? 0}
              </span>
            </div>
            <div className="ai00-x-credits-invite__stat">
              <span className="ai00-x-credits-invite__stat-label">已充值</span>
              <span className="ai00-x-credits-invite__stat-value ds-data">
                {summary?.activated_count ?? 0}
              </span>
            </div>
            <div className="ai00-x-credits-invite__stat ai00-x-credits-invite__stat--accrued">
              <span className="ai00-x-credits-invite__stat-label">本月待结算分红</span>
              <span className="ai00-x-credits-invite__stat-value ds-data">
                {summary?.month_accrued ?? 0}
              </span>
              <span className="ai00-x-credits-invite__stat-note">月底统一入账</span>
            </div>
            <div className="ai00-x-credits-invite__stat">
              <span className="ai00-x-credits-invite__stat-label">累计已入账</span>
              <span className="ai00-x-credits-invite__stat-value ds-data">
                {summary?.rewards_total ?? 0}
              </span>
            </div>
          </>
        )}
      </section>

      {/* 会员打折券：兑换 + 券包 */}
      <section className="ai00-x-credits-invite__coupons" aria-label="会员打折券">
        <header className="ai00-x-credits-invite__section-head">
          <Ticket size={16} aria-hidden />
          <h4>会员打折券</h4>
          <span className="ai00-x-credits-invite__section-note">用分红兑换，兑换即预付折后款</span>
        </header>
        {loading ? (
          <Skeleton style={{ height: 'var(--size-gap-13)' }} />
        ) : (
          <div className="ai00-x-credits-invite__coupon-grid">
            {tiers.map(tier => {
              const locked = !tier.unlocked;
              const soldOut = tier.exchanged_this_month >= tier.monthly_limit;
              return (
                <article
                  key={tier.key}
                  className={[
                    'ai00-x-credits-invite__coupon-card',
                    locked && 'ai00-x-credits-invite__coupon-card--locked',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div className="ai00-x-credits-invite__coupon-tier">{tier.plan_tier.toUpperCase()}</div>
                  <div className="ai00-x-credits-invite__coupon-discount ds-data">
                    {fmtDiscount(tier.discount)}
                  </div>
                  <div className="ai00-x-credits-invite__coupon-cost ds-data">
                    {tier.cost} 分红 / 张
                  </div>
                  {locked ? (
                    <p className="ai00-x-credits-invite__coupon-lock">{tier.lock_hint ?? '邀请更多好友解锁'}</p>
                  ) : (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={soldOut || exchangingKey === tier.key}
                      onClick={() => void handleExchange(tier.key)}
                    >
                      {soldOut ? '本月已兑完' : exchangingKey === tier.key ? '兑换中…' : '用分红兑换'}
                    </Button>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {activeCoupons.length > 0 && (
          <div className="ai00-x-credits-invite__wallet" aria-label="我的券包">
            <span className="ai00-x-credits-invite__wallet-label">我的券包</span>
            {activeCoupons.map(c => (
              <span key={c.id} className="ai00-x-credits-invite__wallet-item">
                {c.plan_tier.toUpperCase()} {fmtDiscount(c.discount)} · {fmtDate(c.expires_at)} 前有效
              </span>
            ))}
          </div>
        )}
      </section>

      {/* 奖励规则（折叠） */}
      <section className="ai00-x-credits-invite__rules" aria-label="奖励规则">
        <button
          type="button"
          className="ai00-x-credits-invite__rules-toggle"
          onClick={() => setRulesOpen(open => !open)}
        >
          奖励规则 {rulesOpen ? '▲' : '▼'}
        </button>
        {rulesOpen && (
          <ul className="ai00-x-credits-invite__rules-list">
            <li>好友注册起 365 天内每笔充值，你得 10% 分红；之后每年 3%（年度封顶 500 分/人）。</li>
            <li>好友的好友（二代）首年充值，你得 30% 折算分红；分红只在首年计。</li>
            <li>分红每月月底统一结算入账，入账当月与次月内有效，次月底未用清零。</li>
            <li>分红可用于 AI 消耗，也可兑换会员打折券（每月限用 1 张）；不可用于其他消费。</li>
            <li>单邀请人每月分红上限 5000 分；刷单等异常行为将转人工审核。</li>
          </ul>
        )}
      </section>

      {/* 邀请记录 */}
      <section className="ai00-x-credits-invite__records" aria-label="邀请记录">
        <header className="ai00-x-credits-invite__section-head">
          <Users size={16} aria-hidden />
          <h4>邀请记录</h4>
        </header>
        {loading ? (
          <Skeleton style={{ height: 'var(--size-gap-9)' }} />
        ) : invitees.length === 0 ? (
          <p className="ai00-x-credits-invite__empty">
            还没有邀请记录。复制你的邀请码，邀请好友加入吧！
          </p>
        ) : (
          <ul className="ai00-x-credits-invite__record-list">
            {invitees.map(item => {
              const meta = STATUS_META[item.status];
              return (
                <li key={item.id} className="ai00-x-credits-invite__record">
                  <span className="ai00-x-credits-invite__record-name">{item.nickname_masked}</span>
                  <span className="ai00-x-credits-invite__record-date ds-data">
                    注册于 {fmtDate(item.registered_at)}
                  </span>
                  <Tag color={meta.tone === 'done' ? 'green' : 'gray'}>{meta.label}</Tag>
                  <span className="ai00-x-credits-invite__record-reward ds-data">
                    {item.reward_paid > 0
                      ? `已入账 ${item.reward_paid}`
                      : item.reward_accrued > 0
                        ? `待结算 ${item.reward_accrued}`
                        : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};

export default InviteView;
