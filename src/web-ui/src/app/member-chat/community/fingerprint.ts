/**
 * fingerprint — 创作指纹的数据整形（造物集 D 阶段）
 *
 * 纯函数：把服务端 `CommunityFingerprint` 变成"可以直接画"的形状。
 * 单独成文件是为了可测——热力图的周桶切分、时钟旋转、里程碑排序
 * 都是容易错算的纯逻辑，放组件里就只能靠肉眼验。
 */

/** 热力图一格 */
export interface HeatCell {
  /** YYYY-MM-DD */
  day: string;
  /** posts + songs */
  total: number;
  /** 0..4 强度档（供 CSS 取色） */
  level: number;
}

export interface HeatGrid {
  /** 升序 7×N（每周从周日开始） */
  weeks: HeatCell[][];
  /** 实际周数 */
  weekCount: number;
}

/** 时钟一项 */
export interface ClockBar {
  hour: number;
  count: number;
  /** 0..1 相对峰值 */
  ratio: number;
}

/** 里程碑展示项 */
export interface MilestoneView {
  key: string;
  value: number;
  /** 客户端 i18n 拼好的展示文案 */
  label: string;
}

const DAY_MS = 86_400_000;

/**
 * 'YYYY-MM-DD' → UTC 毫秒（按 UTC 解释，与服务端 date(created_at) 一致）
 *
 * 严格校验：Date.UTC 会把 2026-13-01 静默滚到 2027-01-01，
 * 那样一张脏格子会被画到错误年份的位置上，而这里返回 NaN 让调用方跳过它。
 */
export function parseDay(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return NaN;
  const ms = Date.UTC(y, mo - 1, da);
  // 回读校验：挡住 2 月 30 日这类溢出日期
  if (formatDay(ms) !== day) return NaN;
  return ms;
}

/** 毫秒 → 'YYYY-MM-DD' */
export function formatDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 日计数 → 7×N 周网格 + 强度档
 *
 * 强度分档用**分位数**而非线性：创作是长尾分布（多数日子为 0，偶尔一天 5 篇），
 * 线性分档会把所有有产出的日子都压成同一档，热力图失去信息量。
 * 这里按 0 / 1 / 2 / 3-4 / 5+ 五档，接近 GitHub 的观感。
 */
export function buildHeatGrid(
  days: Array<{ day: string; posts: number; songs: number }>,
  todayMs: number,
): HeatGrid {
  const byDay = new Map<string, number>();
  for (const d of days) {
    byDay.set(d.day, (d.posts ?? 0) + (d.songs ?? 0));
  }

  // 窗口：今天往前 52 周 + 当周补齐（371 天足够覆盖 53 周网格）
  const startMs = todayMs - 364 * DAY_MS;
  // 对齐到周日 0 点
  const startDow = new Date(startMs).getUTCDay();
  const gridStart = startMs - startDow * DAY_MS;

  const levelOf = (n: number): number => {
    if (n <= 0) return 0;
    if (n === 1) return 1;
    if (n === 2) return 2;
    if (n <= 4) return 3;
    return 4;
  };

  const weeks: HeatCell[][] = [];
  const total = Math.ceil((todayMs - gridStart) / DAY_MS) + 1;
  const weekCount = Math.ceil(total / 7);
  for (let w = 0; w < weekCount; w++) {
    const col: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const ms = gridStart + (w * 7 + d) * DAY_MS;
      // 窗口之外（早于起始日 / 晚于今天）不画
      if (ms > todayMs || ms < startMs) {
        col.push({ day: formatDay(ms), total: 0, level: -1 });
        continue;
      }
      const key = formatDay(ms);
      const n = byDay.get(key) ?? 0;
      col.push({ day: key, total: n, level: levelOf(n) });
    }
    weeks.push(col);
  }
  return { weeks, weekCount };
}

/**
 * 24 桶 → 相对峰值的占比
 *
 * 保留原始 hour 字段：**不做时区旋转**。服务端给的是 UTC，
 * 没有可信时区来源时假装本地时间会产出错误结论
 * （"凌晨三点在写歌"这句话如果是假的，宁可不说）。
 */
export function buildClock(clock: number[]): ClockBar[] {
  const peak = Math.max(1, ...clock.map((n) => (Number.isFinite(n) ? n : 0)));
  return Array.from({ length: 24 }, (_, hour) => {
    const raw = clock[hour];
    const count = Number.isFinite(raw) ? (raw as number) : 0;
    return { hour, count, ratio: Math.max(0, Math.min(1, count / peak)) };
  });
}

/**
 * 里程碑 → 展示项
 *
 * 单位文案在这里拼（分钟/小时由客户端决定），因为服务端只发数值——
 * 服务端下发文案会让 i18n 失效（每种语言都要改 Rust）。
 *
 * @param fmt i18n 取值函数（与里程碑 key 一一对应）
 */
export function buildMilestones(
  milestones: Array<{ key: string; value: number }>,
  fmt: (key: string, value: number) => string,
): MilestoneView[] {
  return milestones
    .filter((m) => Number.isFinite(m.value) && m.value > 0)
    .map((m) => ({ key: m.key, value: m.value, label: fmt(m.key, m.value) }));
}

/** 秒 → "4 小时 20 分" / "38 分" */
export function fmtDurationHuman(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0 分';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0 && m > 0) return `${h} 小时 ${m} 分`;
  if (h > 0) return `${h} 小时`;
  return `${m} 分`;
}

/**
 * 指纹是否"有内容"可画
 *
 * 零作品用户：服务端返回空 days + 全 0 clock，客户端据此显示兜底文案
 * 而不是画一张空网格（空网格看起来像 bug，不像"还没有作品"）。
 */
export function hasFingerprintContent(fp: {
  days: unknown[];
  clock: number[];
  genres: unknown[];
}): boolean {
  const dayCount = fp.days?.length ?? 0;
  const songOrPost = (fp.clock ?? []).some((n) => n > 0);
  return dayCount > 0 || songOrPost || (fp.genres?.length ?? 0) > 0;
}