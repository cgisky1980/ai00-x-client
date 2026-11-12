/**
 * UsageView — 积分消耗页（积分中心首页）。
 *
 * 两个口径并列，绝不合并成「总用量」：
 * - 本地推理：本机 RWKV/pool 推理的 token 数（客户端 ledger，含估算，不扣积分）
 * - 远端消费：经 Ai00-X 云端计费的调用所扣积分（服务端账单，真实扣费）
 *
 * 数据（远端一律只读服务端字段，客户端不做分桶外的任何推算）：
 * - 远端积分/趋势/模型占比：GET /me/ai/usage（服务端账本日桶 + 按模型聚合）
 * - 最近记录/待结清：GET /me/billing/ledger（服务端分页明细 + 全量汇总）
 * - 本地 token：`ai_usage_query`（客户端 ledger，近 30 日）
 * 视觉纪律（新东方极简）：墨阶 token 表面、黛青唯一交互色（折线/占比条）、
 * 数字一律 .ds-data（mono + tabular-nums）、零硬编码色值/px 间距。
 * 口径纪律：只展示积分与 token 数，严禁积分↔人民币换算、严禁 token→积分换算。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, RefreshCw } from 'lucide-react';
import { Button, Skeleton, toast, toastSuccess, toastWarning } from '@/component-library';
import {
  listMyLedger,
  type MyLedgerResponse,
} from '@/infrastructure/api/service-api/BillingApi';
import {
  fetchServerUsage,
  queryLocalUsage,
  type LocalUsage,
  type ServerUsage,
} from '@/tools/todo/ai/usageApi';
import { useCreditsStore } from './creditsStore';
import './UsageView.scss';

/** 服务端聚合窗口（天数）；今日/本月/近 N 日均取自该窗口的日桶 */
const USAGE_WINDOW_DAYS = 30;

/** 最近记录条数（服务端分页上限 200，这里只需最近若干条） */
const RECENT_LIMIT = 20;

/** 本地日期键（YYYY-MM-DD） */
function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "MM-DD" 短日期 */
function shortDate(day: string): string {
  return day.slice(5).replace('-', '/');
}

/** "HH:mm" 短时间 */
function shortTime(iso: string): string {
  return iso.slice(11, 16);
}

/** token 数中文缩写（3.4 亿 / 326.9 万 / 9,820） */
function fmtTokens(n: number): string {
  if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(1)} 亿`;
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(1)} 万`;
  return n.toLocaleString('en-US');
}

const RANGE_DAYS = { 7: 7, 30: 30 } as const;
type RangeKey = keyof typeof RANGE_DAYS;

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 纯 SVG 消耗趋势折线（黛青描边 + 淡充填，mono 坐标） */
const UsageTrendChart: React.FC<{ series: { day: string; cost: number }[] }> = ({ series }) => {
  const W = 600;
  const H = 160;
  const PAD_X = 8;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 22;
  const max = Math.max(...series.map(p => p.cost), 1);
  const stepX = (W - PAD_X * 2) / Math.max(series.length - 1, 1);
  const points = series.map((p, i) => {
    const x = PAD_X + i * stepX;
    const y = PAD_TOP + (1 - p.cost / max) * (H - PAD_TOP - PAD_BOTTOM);
    return { ...p, x, y };
  });
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${H - PAD_BOTTOM} L${points[0].x.toFixed(1)},${H - PAD_BOTTOM} Z`;
  // X 轴标签最多取 6 个均匀样点（HTML 层渲染，避免 SVG 拉伸变形）
  const labelCount = Math.min(6, series.length);
  const labelIdx = new Set(
    Array.from({ length: labelCount }, (_, i) =>
      Math.round((i * (series.length - 1)) / Math.max(labelCount - 1, 1))
    )
  );

  return (
    <div className="ai00-x-credits-usage__chart-wrap">
      <svg
        className="ai00-x-credits-usage__chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`近 ${series.length} 日远端积分消耗趋势`}
        preserveAspectRatio="none"
      >
        <path className="ai00-x-credits-usage__chart-area" d={areaPath} />
        <path className="ai00-x-credits-usage__chart-line" d={linePath} />
      </svg>
      <div className="ai00-x-credits-usage__chart-labels" aria-hidden>
        {series.map((p, i) =>
          labelIdx.has(i) ? (
            <span
              key={p.day}
              className="ai00-x-credits-usage__chart-label"
              style={{
                position: 'absolute',
                left: `${((PAD_X + i * stepX) / W) * 100}%`,
                transform: i === 0 ? 'none' : i === series.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {shortDate(p.day)}
            </span>
          ) : null
        )}
      </div>
    </div>
  );
};

const UsageView: React.FC = () => {
  const {
    summary,
    signinStatus,
    loadingSummary,
    loadingSignin,
    loadSummary,
    loadSignin,
    doSignin,
  } = useCreditsStore();
  const [serverUsage, setServerUsage] = useState<ServerUsage | null>(null);
  const [ledger, setLedger] = useState<MyLedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [localUsage, setLocalUsage] = useState<LocalUsage | null>(null);
  const [range, setRange] = useState<RangeKey>(7);
  const [signingIn, setSigningIn] = useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    // 汇总走服务端账本（全量聚合，不受分页上限影响）；明细只取最近若干条
    const [usage, myLedger] = await Promise.all([
      fetchServerUsage(USAGE_WINDOW_DAYS),
      listMyLedger(RECENT_LIMIT, 0).catch(() => null),
    ]);
    setServerUsage(usage);
    setLedger(myLedger);
    setLoadFailed(usage === null);
    setLoading(false);
  }, []);

  /** 本地 ledger 独立加载：远端账单失败（未登录/断网）不影响本地 token 呈现。 */
  const loadLocal = React.useCallback(async () => {
    try {
      setLocalUsage(await queryLocalUsage(30));
    } catch {
      setLocalUsage(null);
    }
  }, []);

  useEffect(() => {
    loadSummary();
    loadSignin();
    void load();
    void loadLocal();
  }, [load, loadSummary, loadSignin, loadLocal]);

  const todaySigned = signinStatus?.today_signed ?? false;

  const handleSignin = async () => {
    if (signingIn || todaySigned) return;
    setSigningIn(true);
    try {
      const result = await doSignin();
      if (result.already_signed) {
        toastWarning('今日已签到过啦');
      } else {
        // 只展示服务端返回的实发积分与连签天数；不做「明日可领」预估（服务端唯一权威）
        toastSuccess(`签到成功，连签 ${result.streak ?? 1} 天，获得 ${result.credits_granted} 积分`, {
          description: '邀请好友充值，你也拿分红',
        });
      }
    } catch {
      toast('签到失败，请稍后重试', { variant: 'error' });
    } finally {
      setSigningIn(false);
    }
  };

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

  // ── 统计口径：全部取自服务端账本日桶/模型聚合，客户端只按日桶筛选与补零 ────
  const stats = useMemo(() => {
    const now = new Date();
    const todayKey = dayKeyOf(now);
    const monthPrefix = todayKey.slice(0, 7);

    // 服务端日桶（日期已按调用方时区折算）
    const perDay = new Map<string, number>();
    for (const d of serverUsage?.days ?? []) {
      perDay.set(d.date, d.credits);
    }

    const todayCost = perDay.get(todayKey) ?? 0;
    let monthCost = 0;
    for (const [day, cost] of perDay) {
      if (day.startsWith(monthPrefix)) monthCost += cost;
    }

    // 趋势序列：近 range 日（服务端日桶，无消耗的日补 0，仅补零不推算）
    const series: { day: string; cost: number }[] = [];
    for (let i = RANGE_DAYS[range] - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = dayKeyOf(d);
      series.push({ day: key, cost: perDay.get(key) ?? 0 });
    }

    // 模型聚合：服务端 byModel（credits 降序）
    const models = (serverUsage?.byModel ?? []).map(m => ({
      model: m.model,
      cost: m.credits,
      tokens: m.promptTokens + m.completionTokens,
      cachedTokens: m.cachedTokens,
      calls: m.calls,
    }));
    const modelTotal = models.reduce((s, m) => s + m.cost, 0);

    // 最近记录：服务端已按时间倒序返回，取前 8 条（不参与任何汇总）
    const recent = (ledger?.items ?? []).slice(0, 8);

    return {
      todayCost,
      monthCost,
      series,
      models,
      modelTotal,
      recent,
      cachedTokens: serverUsage?.totals.cachedTokens ?? 0,
      hasRemoteData: (serverUsage?.totals.calls ?? 0) > 0 || (serverUsage?.totals.credits ?? 0) > 0,
    };
  }, [serverUsage, ledger, range]);

  const hasData = !loading && !loadFailed && stats.hasRemoteData;
  const pendingCredits = ledger?.summary?.pending_credits ?? 0;
  const chargedCredits = ledger?.summary?.charged_credits ?? 0;
  const ledgerTotal = ledger?.total ?? 0;

  const nextReset = summary?.next_reset_at ? summary.next_reset_at.slice(0, 10) : null;
  const expiringSoon = summary?.expiring?.[0] ?? null;

  return (
    <div className="ai00-x-credits-usage">
      {/* 每日签到（自会员页迁入） */}
      <section className="ai00-x-credits-usage__signin" aria-label="每日签到">
        <div className="ai00-x-credits-usage__signin-info">
          <h3 className="ai00-x-credits-usage__signin-title">
            <CalendarCheck size={16} aria-hidden />
            每日签到
          </h3>
          <p className="ai00-x-credits-usage__signin-desc">
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
        <div className="ai00-x-credits-usage__signin-calendar" aria-label="本月签到记录">
          <div className="ai00-x-credits-usage__signin-grid">
            {WEEKDAY_LABELS.map(w => (
              <span key={w} className="ai00-x-credits-usage__signin-weekday">{w}</span>
            ))}
            {Array.from({ length: calendar.leadingBlanks }, (_, i) => (
              <span key={`blank-${i}`} />
            ))}
            {calendar.cells.map(cell => (
              <span
                key={cell.dateStr}
                className={[
                  'ai00-x-credits-usage__signin-day ds-data',
                  cell.signed && 'ai00-x-credits-usage__signin-day--signed',
                  cell.isToday && 'ai00-x-credits-usage__signin-day--today',
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

      {/* 当前积分余额（自充值页迁入） */}
      <section className="ai00-x-credits-usage__balance" aria-label="当前积分余额">
        <div className="ai00-x-credits-usage__balance-main">
          <span className="ai00-x-credits-usage__balance-label">当前积分</span>
          {loadingSummary && !summary ? (
            <Skeleton style={{ width: '160px', height: '32px' }} />
          ) : (
            <span className="ai00-x-credits-usage__balance-value ds-data">
              {summary?.total ?? 0}
            </span>
          )}
        </div>
        <div className="ai00-x-credits-usage__balance-meta">
          {summary?.plan_display_name && (
            <span className="ai00-x-credits-usage__meta-item">{summary.plan_display_name}</span>
          )}
          {nextReset && (
            <span className="ai00-x-credits-usage__meta-item ds-data">
              套餐剩余 {summary?.plan_remaining ?? 0} 分 · {nextReset} 重置
            </span>
          )}
          {(summary?.reward_remaining ?? 0) > 0 && (
            <span className="ai00-x-credits-usage__meta-item ds-data">
              分红 {summary?.reward_remaining} 分 · 仅限 AI 消耗
            </span>
          )}
          {expiringSoon && (
            <span className="ai00-x-credits-usage__meta-item ai00-x-credits-usage__meta-item--warn ds-data">
              到期提醒：{expiringSoon.amount} 分 {expiringSoon.expires_at.slice(0, 10)} 前用掉
            </span>
          )}
        </div>
      </section>

      {/* 顶部统计条：本地推理 token 与远端积分并列，不做合并总量 */}
      <section className="ai00-x-credits-usage__stats" aria-label="用量统计（本地推理与远端消费分开）">
        <div className="ai00-x-credits-usage__stat">
          <span className="ai00-x-credits-usage__stat-value ds-data">
            {loadFailed ? '—' : stats.monthCost}
          </span>
          <span className="ai00-x-credits-usage__stat-label">本月远端消耗（积分）</span>
          <span className="ai00-x-credits-usage__stat-note">
            {loadFailed ? '登录后同步' : '服务端账本 · 近 30 日窗口'}
          </span>
        </div>
        <div className="ai00-x-credits-usage__stat">
          <span className="ai00-x-credits-usage__stat-value ds-data">
            {localUsage ? fmtTokens(localUsage.totals.localTokens) : '—'}
          </span>
          <span className="ai00-x-credits-usage__stat-label">本地推理 Token · 近 30 日</span>
          <span className="ai00-x-credits-usage__stat-note">
            {localUsage ? `${localUsage.totals.localCalls} 次调用 · 估算` : '本机记录读取失败'}
          </span>
        </div>
        <div className="ai00-x-credits-usage__stat">
          <span className="ai00-x-credits-usage__stat-value ds-data">
            {loadFailed ? '—' : stats.todayCost}
          </span>
          <span className="ai00-x-credits-usage__stat-label">今日远端消耗（积分）</span>
          <span className="ai00-x-credits-usage__stat-note">本地推理不扣积分</span>
        </div>
      </section>

      {/* 每日远端积分消耗趋势（本地推理不产生积分，不混入） */}
      <section className="ai00-x-credits-usage__chart-card" aria-label="远端积分消耗趋势">
        <header className="ai00-x-credits-usage__card-head">
          <h3 className="ai00-x-credits-usage__card-title">远端积分消耗趋势</h3>
          <div className="ai00-x-credits-usage__range" role="tablist" aria-label="时间范围">
            {(Object.keys(RANGE_DAYS) as unknown as string[]).map(key => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={range === Number(key)}
                className={[
                  'ai00-x-credits-usage__range-btn',
                  range === Number(key) && 'ai00-x-credits-usage__range-btn--active',
                ].filter(Boolean).join(' ')}
                onClick={() => setRange(Number(key) as RangeKey)}
              >
                近 {key} 日
              </button>
            ))}
          </div>
        </header>
        {loading ? (
          <Skeleton style={{ height: '160px' }} />
        ) : loadFailed ? (
          <div className="ai00-x-credits-usage__failed">
            <p>消耗数据加载失败</p>
            <Button variant="secondary" size="small" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : !hasData ? (
          <p className="ai00-x-credits-usage__empty">
            还没有远端计费记录。本地推理不扣积分，其 token 用量见上方统计。
          </p>
        ) : (
          <UsageTrendChart series={stats.series} />
        )}
      </section>

      {hasData && (
        <>
          {/* 模型用量占比 */}
          <section className="ai00-x-credits-usage__chart-card" aria-label="模型用量">
            <header className="ai00-x-credits-usage__card-head">
              <h3 className="ai00-x-credits-usage__card-title">远端模型用量</h3>
              <span className="ai00-x-credits-usage__card-note ds-data">
                仅计费模型 · 近 {USAGE_WINDOW_DAYS} 日累计 {stats.modelTotal} 积分
                {stats.cachedTokens > 0 && ` · 缓存命中 ${fmtTokens(stats.cachedTokens)} tokens`}
              </span>
            </header>
            <ul className="ai00-x-credits-usage__models">
              {stats.models.map((m, i) => {
                const pct = stats.modelTotal > 0 ? (m.cost / stats.modelTotal) * 100 : 0;
                return (
                  <li key={m.model} className="ai00-x-credits-usage__model">
                    <div className="ai00-x-credits-usage__model-row">
                      <span className="ai00-x-credits-usage__model-dot" data-rank={Math.min(i, 3)} />
                      <span
                        className="ai00-x-credits-usage__model-name"
                        title={`${m.model} · ${fmtTokens(m.tokens)} tokens${m.cachedTokens > 0 ? `（缓存 ${fmtTokens(m.cachedTokens)}）` : ''} · ${m.calls} 次调用`}
                      >
                        {m.model}
                      </span>
                      <span className="ai00-x-credits-usage__model-cost ds-data">
                        {m.cost} 积分 · {pct.toFixed(pct < 10 && pct >= 1 ? 1 : 0)}%
                      </span>
                    </div>
                    <div className="ai00-x-credits-usage__model-bar">
                      <span
                        className="ai00-x-credits-usage__model-bar-fill"
                        data-rank={Math.min(i, 3)}
                        style={{ width: `${Math.max(pct, 1.5)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* 最近消耗记录 */}
          <section className="ai00-x-credits-usage__chart-card" aria-label="最近消耗">
            <header className="ai00-x-credits-usage__card-head">
              <h3 className="ai00-x-credits-usage__card-title">最近消耗</h3>
              <span className="ai00-x-credits-usage__card-note ds-data">
                已扣 {chargedCredits}
                {pendingCredits > 0 && ` · 待结清 ${pendingCredits}`}
                {ledgerTotal > 0 && ` · 共 ${ledgerTotal} 条`}
              </span>
              <Button
                variant="ghost"
                size="small"
                onClick={() => {
                  void load();
                  void loadLocal();
                  loadSummary();
                }}
              >
                <RefreshCw size={13} aria-hidden />
                刷新
              </Button>
            </header>
            {stats.recent.length === 0 ? (
              <p className="ai00-x-credits-usage__empty">
                {ledger === null ? '最近记录加载失败' : '最近没有计费记录。'}
              </p>
            ) : (
              <ul className="ai00-x-credits-usage__records">
                {stats.recent.map(e => (
                  <li key={e.id} className="ai00-x-credits-usage__record">
                    <span className="ai00-x-credits-usage__record-model" title={e.model}>{e.model}</span>
                    {e.status === 'pending' && (
                      <span className="ai00-x-credits-usage__flag ai00-x-credits-usage__flag--pending">待结清</span>
                    )}
                    {e.is_estimated && (
                      <span className="ai00-x-credits-usage__flag ai00-x-credits-usage__flag--estimated">估算</span>
                    )}
                    <span className="ai00-x-credits-usage__record-tokens ds-data">
                      {fmtTokens(e.prompt_tokens + e.completion_tokens)} tokens
                      {e.cached_tokens > 0 && ` · 缓存 ${fmtTokens(e.cached_tokens)}`}
                    </span>
                    <span className="ai00-x-credits-usage__record-source ds-data">
                      {e.deducted_from_subscription > 0 ? '套餐' : e.deducted_from_recharge > 0 ? '充值' : '—'}
                    </span>
                    <span className="ai00-x-credits-usage__record-time ds-data">
                      {shortDate(e.created_at.slice(0, 10))} {shortTime(e.created_at)}
                    </span>
                    <span className="ai00-x-credits-usage__record-cost ds-data">-{e.cost_credits}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default UsageView;
