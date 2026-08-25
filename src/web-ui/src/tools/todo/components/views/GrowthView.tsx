/**
 * GrowthView — 修行：等级卡 / 今日统计 / 日终回顾 / 勋章墙 / 奖励兑换 / 服务器同步态。
 */
import React, { useState } from 'react';
import { Medal, Sparkles } from 'lucide-react';
import { useTodoStore } from '../../store/todoStore';
import { useGrowthStore } from '../../store/growthStore';
import { BADGES } from '../../api/types';
import { BADGE_TIER_LABELS } from '../../api/labels';
import { dailyReview } from '../../ai/consult';

export const GrowthView: React.FC = () => {
  const data = useTodoStore((s) => s.data);
  const profile = useGrowthStore((s) => s.profile);
  const syncing = useGrowthStore((s) => s.syncing);
  const spendCoins = useGrowthStore((s) => s.spendCoins);
  const addReward = useTodoStore((s) => s.addReward);
  const [rewardName, setRewardName] = useState('');
  const [rewardCost, setRewardCost] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const doneToday = data.tasks.filter((t) => t.completedAt && t.completedAt >= dayStart.getTime());
  const createdToday = data.tasks.filter((t) => t.createdAt >= dayStart.getTime()).length;
  const focusToday = data.focusSessions
    .filter((s) => s.startedAt >= dayStart.getTime())
    .reduce((a, s) => a + s.minutes, 0);
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return data.tasks.filter((t) => t.completedAt && new Date(t.completedAt).toDateString() === d.toDateString()).length;
  });

  const runReview = async () => {
    setReviewBusy(true);
    try {
      const text = await dailyReview({
        doneTitles: doneToday.map((t) => t.title),
        createdCount: createdToday,
        focusMin: focusToday,
      });
      setReview(text || '今日暂无可回顾之事——先去记一笔');
    } finally {
      setReviewBusy(false);
    }
  };

  const commitReward = () => {
    const name = rewardName.trim();
    if (!name) return;
    addReward(name, parseInt(rewardCost, 10) || 10);
    setRewardName('');
    setRewardCost('');
  };

  return (
    <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 0, minHeight: '100%' }}>
      {/* 等级卡 */}
      <div className="td-level-card">
        <span className="td-lv">Lv.{profile.level}</span>
        <div className="td-lvbar">
          <div className="td-lvtrack">
            <span className="td-lvfill" style={{ width: `${Math.round((profile.into / Math.max(1, profile.need)) * 100)}%` }} />
          </div>
          <span className="td-lvtext">{profile.into} / {profile.need} XP</span>
        </div>
        <span className="td-coins" title="金币">{profile.coins}</span>
      </div>

      {!syncing && profile.totalXp === 0 && (
        <div className="td-sync-hint">游戏化数据登录后同步到账号（跨设备）</div>
      )}

      {/* 今日统计 */}
      <div className="td-growth-section">今日</div>
      <div className="td-stats">
        <StatCard num={doneToday.length} label="完成" />
        <StatCard num={createdToday} label="新增" muted />
        <StatCard num={focusToday} label="专注分钟" />
        <StatCard num={profile.streak} label="连续天数" />
      </div>
      <div className="td-stat-label" style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
        近 7 日完成：{week.join(' · ')}
      </div>

      {/* 日终回顾 */}
      <div className="td-growth-section" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        回顾
        <span style={{ flex: 1 }} />
        <button className="td-chip" disabled={reviewBusy} onClick={() => void runReview()}>
          {reviewBusy ? '回顾中…' : <><Sparkles size={11} /> AI 回顾今日</>}
        </button>
      </div>
      {review && (
        <div className="td-goal-why" style={{ margin: '0 0 4px' }}>{review}</div>
      )}

      {/* 勋章墙 */}
      <div className="td-growth-section">勋章（{profile.badges.length}/{BADGES.length}）</div>
      <div className="td-badge-grid">
        {BADGES.map((b) => {
          const unlocked = profile.badges.includes(b.id);
          return (
            <div key={b.id} className={`td-badge${unlocked ? '' : ' is-locked'}`} title={`${b.desc}${unlocked ? '' : '（未解锁）'}`}>
              <Medal size={22} />
              <div className="td-badge-name">{b.name}</div>
              <div className="td-badge-tier">{BADGE_TIER_LABELS[b.tier]}</div>
            </div>
          );
        })}
      </div>

      {/* 奖励 */}
      <div className="td-growth-section">奖励</div>
      {data.rewards.map((r) => (
        <div key={r.id} className="td-reward">
          <span className="td-reward-name">{r.name}</span>
          <span className="td-reward-cost">{r.cost}</span>
          <button className="td-chip" onClick={() => void spendCoins(r.cost, r.name)}>
            兑换
          </button>
        </div>
      ))}
      <div className="td-reward">
        <input
          className="td-reward-name-in"
          placeholder="自定义奖励，如「休息 15 分钟」"
          value={rewardName}
          onChange={(e) => setRewardName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commitReward()}
        />
        <input
          type="number"
          placeholder="价格"
          value={rewardCost}
          onChange={(e) => setRewardCost(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commitReward()}
        />
        <button className="td-chip" onClick={commitReward}>
          添加
        </button>
      </div>
    </div>
  );
};

const StatCard: React.FC<{ num: number; label: string; muted?: boolean }> = ({ num, label, muted }) => (
  <div className="td-stat">
    <span className={`td-stat-num${muted ? ' is-muted' : ''}`}>{num}</span>
    <span className="td-stat-label">{label}</span>
  </div>
);
