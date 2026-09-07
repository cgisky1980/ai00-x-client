/**
 * UsageView — 积分消耗页（积分中心首页）。
 *
 * 参考"使用统计"形态：
 * - 顶部统计条：当前积分 / 本月消耗 / 近 30 日消耗 / 今日消耗
 * - 每日消耗趋势（近 7 日 / 近 30 日切换，纯 SVG 折线，无图表库）
 * - 模型用量占比（按消耗积分聚合，横向比例条）
 * - 最近消耗记录（模型 + token 数 + 消耗积分 + 时间）
 *
 * 数据：GET /me/billing/ledger（模型级计费明细）+ credits/summary。
 * 视觉纪律（新东方极简）：墨阶 token 表面、黛青唯一交互色（折线/占比条）、
 * 数字一律 .ds-data（mono + tabular-nums）、零硬编码色值/px 间距。
 * 口径纪律：只展示积分与 token 数，严禁积分↔人民币换算。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, RefreshCw } from 'lucide-react';
import { Button, Skeleton, toast, toastSuccess, toastWarning } from '@/component-library';
import { listMyLedger, type BillingEntry } from '@/infrastructure/api/service-api/BillingApi';
import { useCreditsStore } from './creditsStore';
import './UsageView.scss';

/** 本地日期键（YYYY-MM-DD），按天聚合用 */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
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
        aria-label={`近 ${series.length} 日每日积分消耗趋势`}
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
  const [entries, setEntries] = useState<BillingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [range, setRange] = useState<RangeKey>(7);
  const [signingIn, setSigningIn] = useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      // 一次拉 500 条足够覆盖 30 日个人用量；服务端分页上限即此
      const resp = await listMyLedger(500, 0);
      setEntries((resp.items ?? []).filter(e => e.status === 'charged'));
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSummary();
    loadSignin();
    void load();
  }, [load, loadSummary, loadSignin]);

  const todaySigned = signinStatus?.today_signed ?? false;

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

  // ── 按本地时区日聚合（created_at 为 UTC ISO，转本地日期） ─────────────────
  const stats = useMemo(() => {
    const now = new Date();
    const perDay = new Map<string, number>();
    const perModel = new Map<string, number>();
    let todayCost = 0;
    let monthCost = 0;
    let monthTokens = 0;

    const todayKey = (() => {
      const d = now;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const monthPrefix = todayKey.slice(0, 7);

    for (const e of entries) {
      const localDay = (() => {
        const d = new Date(e.created_at);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      })();
      const cost = e.cost_credits;
      if (localDay === todayKey) todayCost += cost;
      if (localDay.startsWith(monthPrefix)) {
        monthCost += cost;
        monthTokens += e.prompt_tokens + e.completion_tokens;
      }
      perDay.set(localDay, (perDay.get(localDay) ?? 0) + cost);
      perModel.set(e.model, (perModel.get(e.model) ?? 0) + cost);
    }

    // 趋势序列：range 天（含今日，无消耗补 0）
    const series: { day: string; cost: number }[] = [];
    for (let i = RANGE_DAYS[range] - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      series.push({ day: key, cost: perDay.get(key) ?? 0 });
    }

    const models = [...perModel.entries()]
      .map(([model, cost]) => ({ model, cost }))
      .sort((a, b) => b.cost - a.cost);
    const modelTotal = models.reduce((s, m) => s + m.cost, 0);

    const recent = [...entries]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 8);

    return {
      todayCost,
      monthCost,
      monthTokens,
      rangeCost: series.reduce((s, p) => s + p.cost, 0),
      series,
      models,
      modelTotal,
      recent,
    };
  }, [entries, range]);

  const hasData = !loading && !loadFailed && entries.length > 0;

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

      {/* 顶部统计条 */}
      <section className="ai00-x-credits-usage__stats" aria-label="消耗统计">
        <div className="ai00-x-credits-usage__stat">
          <span className="ai00-x-credits-usage__stat-value ds-data">{stats.monthCost}</span>
          <span className="ai00-x-credits-usage__stat-label">本月消耗</span>
        </div>
        <div className="ai00-x-credits-usage__stat">
          <span className="ai00-x-credits-usage__stat-value ds-data">{fmtTokens(stats.monthTokens)}</span>
          <span className="ai00-x-credits-usage__stat-label">本月 Token 数</span>
        </div>
        <div className="ai00-x-credits-usage__stat">
          <span className="ai00-x-credits-usage__stat-value ds-data">{stats.todayCost}</span>
          <span className="ai00-x-credits-usage__stat-label">今日消耗</span>
        </div>
      </section>

      {/* 每日消耗趋势 */}
      <section className="ai00-x-credits-usage__chart-card" aria-label="消耗趋势">
        <header className="ai00-x-credits-usage__card-head">
          <h3 className="ai00-x-credits-usage__card-title">积分消耗趋势</h3>
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
          <p className="ai00-x-credits-usage__empty">还没有消耗记录，去对话或使用工具产生第一条用量吧。</p>
        ) : (
          <UsageTrendChart series={stats.series} />
        )}
      </section>

      {hasData && (
        <>
          {/* 模型用量占比 */}
          <section className="ai00-x-credits-usage__chart-card" aria-label="模型用量">
            <header className="ai00-x-credits-usage__card-head">
              <h3 className="ai00-x-credits-usage__card-title">模型用量</h3>
              <span className="ai00-x-credits-usage__card-note ds-data">
                累计 {stats.modelTotal} 积分
              </span>
            </header>
            <ul className="ai00-x-credits-usage__models">
              {stats.models.map((m, i) => {
                const pct = stats.modelTotal > 0 ? (m.cost / stats.modelTotal) * 100 : 0;
                return (
                  <li key={m.model} className="ai00-x-credits-usage__model">
                    <div className="ai00-x-credits-usage__model-row">
                      <span className="ai00-x-credits-usage__model-dot" data-rank={Math.min(i, 3)} />
                      <span className="ai00-x-credits-usage__model-name" title={m.model}>{m.model}</span>
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
              <Button
                variant="ghost"
                size="small"
                onClick={() => {
                  void load();
                  loadSummary();
                }}
              >
                <RefreshCw size={13} aria-hidden />
                刷新
              </Button>
            </header>
            <ul className="ai00-x-credits-usage__records">
              {stats.recent.map(e => (
                <li key={e.id} className="ai00-x-credits-usage__record">
                  <span className="ai00-x-credits-usage__record-model" title={e.model}>{e.model}</span>
                  <span className="ai00-x-credits-usage__record-tokens ds-data">
                    {fmtTokens(e.prompt_tokens + e.completion_tokens)} tokens
                  </span>
                  <span className="ai00-x-credits-usage__record-time ds-data">
                    {shortDate(dayKey(e.created_at))} {shortTime(e.created_at)}
                  </span>
                  <span className="ai00-x-credits-usage__record-cost ds-data">-{e.cost_credits}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
};

export default UsageView;
