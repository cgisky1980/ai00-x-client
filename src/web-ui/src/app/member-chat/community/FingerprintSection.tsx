/**
 * FingerprintSection — 创作指纹（造物集 D 阶段）
 *
 * 定位：**个性来自真相，不是装饰**。这里没有一处随机数——
 * 热力图是这个人真实的创作日分布，时钟是真实的活跃时段，
 * 类型和里程碑也都是既���数据的聚合。所以这一块天然无法被"套模板"，
 * 也是主页最难被抄走的部分。
 *
 * 数据源：全部是既有数据的聚合，用户不需要填任何东西。
 * - 热力图 ← community_posts.created_at + shared_songs.created_at（近 365 天）
 * - 时钟   ← shared_songs.created_at 的小时分布（**UTC**）
 * - 类型   ← shared_songs.genre（降序 ≤8）
 * - 里程碑 ← 以上全部派生（作品数/活跃天数/连续天数/累计时长）
 *
 * 时钟**不**按用户时区本地化：member_profiles.timezone 存了但无采集来源，
 * 与其编一个假时区（"凌晨三点在写歌"这句话如果是假的，宁可不说），
 * 不如诚实标 UTC。拿到可靠时区来源后再改。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Skeleton } from '@/component-library';
import { communityApi, type CommunityFingerprint } from './communityApi';
import {
  buildClock,
  buildHeatGrid,
  buildMilestones,
  fmtDurationHuman,
  hasFingerprintContent,
} from './fingerprint';

/** 里程碑 key → i18n（服务端只发数值，文案必须留在客户端） */
const MILESTONE_LABEL: Record<string, (v: number) => string> = {
  works: (v) => `${v} 个作品`,
  songs: (v) => `${v} 首歌`,
  posts: (v) => `${v} 篇动态`,
  activeDays: (v) => `${v} 天有创作`,
  streak: (v) => `连续 ${v} 天`,
  minutes: (v) => `${fmtDurationHuman(v * 60)}`,
};

/**
 * @param palette 主题推导色板。**刻意不使用**：指纹块的颜色全部走
 *   `var(--pt-*)` CSS 变量（SCSS 里），所以它在 JS 侧不需要色值。
 *   留这个 prop 是为了将来做"按色板强弱自动选时钟/热力图配色档"时不用改签名；
 *   在那之前不引入未用依赖（TS 会报 TS6133）。
 */
export const FingerprintSection: React.FC<{ memberId: number }> = ({ memberId }) => {
  const { t } = useI18n('community');
  const [fp, setFp] = useState<CommunityFingerprint | null>(null);
  const [loading, setLoading] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 只拉一次：切页签回来不重复请求
  const requested = useRef(false);

  // 滚动到才拉：零作品用户与只看作品墙的人完全不产生请求
  useEffect(() => {
    const el = hostRef.current;
    if (!el || requested.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        requested.current = true;
        io.disconnect();
        setLoading(true);
        void communityApi
          .memberFingerprint(memberId)
          .then((r) => setFp(r))
          .finally(() => setLoading(false));
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [memberId]);

  // today 用本地"今天"的日期串喂给纯函数，但**格子数据按 UTC 日**匹配——
  // 服务端与客户端可能差一天，差一天最多让最后一格空着，不会错位。
  const todayMs = useMemo(() => {
    const now = new Date();
    return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  const heat = useMemo(
    () => (fp ? buildHeatGrid(fp.days, todayMs) : null),
    [fp, todayMs],
  );
  const clock = useMemo(() => (fp ? buildClock(fp.clock) : null), [fp]);
  const milestones = useMemo(() => {
    if (!fp) return [];
    return buildMilestones(fp.milestones, (key, value) => {
      const f = MILESTONE_LABEL[key];
      return f ? f(value) : `${key} ${value}`;
    });
  }, [fp]);

  const empty = fp != null && !hasFingerprintContent(fp);

  return (
    <section
      ref={hostRef}
      className="community-fp"
      aria-label={t('fpTitle', { defaultValue: '创作指纹' })}
    >
      <header className="community-fp__head">
        <h2 className="community-fp__title">
          {t('fpTitle', { defaultValue: '创作指纹' })}
        </h2>
        <span className="community-fp__hint ds-data">
          {t('fpHint', { defaultValue: '来自你的真实创作数据' })}
        </span>
      </header>

      {loading && !fp && <Skeleton style={{ height: 120 }} />}

      {fp && empty && (
        <p className="community-fp__empty">
          {t('fpEmpty', { defaultValue: '还没有创作数据，发布第一篇动态就会出现在这里' })}
        </p>
      )}

      {fp && !empty && (
        <>
          {/* 里程碑行：最直观的"只有你有"的数字 */}
          {milestones.length > 0 && (
            <ul className="community-fp__miles">
              {milestones.map((m) => (
                <li key={m.key} className="community-fp__mile">
                  <span className="community-fp__mile-label">{m.label}</span>
                </li>
              ))}
            </ul>
          )}

          {/* 52 周创作热力图（GitHub 式）：横轴周、纵轴星期 */}
          {heat && (
            <div className="community-fp__heat-wrap">
              <div className="community-fp__heat" role="img" aria-label={t('fpHeat', { defaultValue: '近一年创作热力图' })}>
                {heat.weeks.map((week, wi) => (
                  <div key={wi} className="community-fp__heat-col">
                    {week.map((cell) => (
                      <span
                        key={cell.day}
                        className="community-fp__cell"
                        data-level={cell.level < 0 ? 'void' : cell.level}
                        title={cell.level < 0 ? undefined : `${cell.day} · ${cell.total}`}
                      />
                    ))}
                  </div>
                ))}
              </div>
              <div className="community-fp__heat-legend ds-data">
                <span>{t('fpLess', { defaultValue: '少' })}</span>
                {[0, 1, 2, 3, 4].map((lv) => (
                  <span key={lv} className="community-fp__cell" data-level={lv} />
                ))}
                <span>{t('fpMore', { defaultValue: '多' })}</span>
              </div>
            </div>
          )}

          {/* 创作时钟（UTC）：24 根柱，凌晨活跃会自己说话 */}
          {clock && clock.some((b) => b.count > 0) && (
            <div className="community-fp__clock-wrap">
              <div className="community-fp__clock-title ds-data">
                {t('fpClock', { defaultValue: '创作时段（UTC）' })}
              </div>
              <div className="community-fp__clock">
                {clock.map((b) => (
                  <span
                    key={b.hour}
                    className="community-fp__clock-bar"
                    data-on={b.count > 0 ? 'true' : 'false'}
                    style={{ ['--bar' as string]: String(b.ratio) }}
                    title={`${String(b.hour).padStart(2, '0')}:00 · ${b.count}`}
                  />
                ))}
              </div>
              <div className="community-fp__clock-axis ds-data">
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
                <span>23</span>
              </div>
            </div>
          )}

          {/* 类型构成 */}
          {fp.genres.length > 0 && (
            <div className="community-fp__genres-wrap">
              <div className="community-fp__clock-title ds-data">
                {t('fpGenres', { defaultValue: '类型构成' })}
              </div>
              <ul className="community-fp__genres">
                {fp.genres.map((g) => {
                  const max = Math.max(1, ...fp.genres.map((x) => x.count));
                  return (
                    <li key={g.name} className="community-fp__genre">
                      <span className="community-fp__genre-name">{g.name}</span>
                      <span
                        className="community-fp__genre-bar"
                        style={{ ['--w' as string]: String(g.count / max) }}
                      />
                      <span className="community-fp__genre-count ds-data">{g.count}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
};

