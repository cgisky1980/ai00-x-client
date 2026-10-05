/**
 * fingerprintViews — 创作指纹的只读视图模型（造物集 D 阶段）
 *
 * 与 FingerprintSection 同源不同层：这里出**可直接渲染的字符串/形状**，
 * 组件层只做拼装。与 fingerprint.ts 的区别是不依赖任何 i18n 运行时，
 * 也没有 JSX —— 因此 H5（单文件 HTML、零构建）可以直接镜像这一层。
 *
 * 纯函数、无 DOM、无 i18n 依赖。
 */

/** 热力图一格（渲染层直接消费） */
export interface FpCell {
  day: string;
  total: number;
  /** -1 = 窗口外/未来，不画 */
  level: number;
}

export interface FpClockBar {
  hour: number;
  count: number;
  ratio: number;
}

export interface FpGenreBar {
  name: string;
  count: number;
  ratio: number;
}

const DAY = 86_400_000;

/** 'YYYY-MM-DD' → UTC 毫秒；非法返回 NaN */
export function fpParseDay(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return NaN;
  const y = +m[1];
  const mo = +m[2];
  const da = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return NaN;
  const ms = Date.UTC(y, mo - 1, da);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== da
  ) {
    return NaN;
  }
  return ms;
}

/** UTC 毫秒 → 'YYYY-MM-DD' */
export function fpFormatDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 长尾友好的五档强度（0/1/2/3-4/5+） */
function fpLevel(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n <= 4) return 3;
  return 4;
}

/**
 * 52 周网格（列 = 周，行 = 周日→周六）
 *
 * @param todayMs 今天 UTC 零点
 * @returns 7×N 的格子矩阵 + 周数
 */
export function fpHeatGrid(
  days: Array<{ day: string; posts: number; songs: number }>,
  todayMs: number,
): { weeks: FpCell[][]; weekCount: number } {
  const byDay = new Map<string, number>();
  for (const d of days) {
    const n = (d.posts ?? 0) + (d.songs ?? 0);
    if (n > 0) byDay.set(d.day, n);
  }
  const startMs = todayMs - 364 * DAY;
  const startDow = new Date(startMs).getUTCDay();
  const gridStart = startMs - startDow * DAY;
  const total = Math.ceil((todayMs - gridStart) / DAY) + 1;
  const weekCount = Math.ceil(total / 7);

  const weeks: FpCell[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const col: FpCell[] = [];
    for (let d = 0; d < 7; d++) {
      const ms = gridStart + (w * 7 + d) * DAY;
      const key = fpFormatDay(ms);
      if (ms > todayMs || ms < startMs) {
        col.push({ day: key, total: 0, level: -1 });
      } else {
        const n = byDay.get(key) ?? 0;
        col.push({ day: key, total: n, level: fpLevel(n) });
      }
    }
    weeks.push(col);
  }
  return { weeks, weekCount };
}

/** 24 桶 → 相对峰值占比（保留 hour 原值：不做时区旋转，服务端给的是 UTC） */
export function fpClock(clock: number[]): FpClockBar[] {
  const clean = Array.from({ length: 24 }, (_, i) => {
    const n = clock[i];
    return Number.isFinite(n) ? (n as number) : 0;
  });
  const peak = Math.max(1, ...clean);
  return clean.map((count, hour) => ({
    hour,
    count,
    ratio: Math.max(0, Math.min(1, count / peak)),
  }));
}

/** 类型分布 → 相对最大值的占比（降序由服务端保证，这里再排一次以防脏数据） */
export function fpGenres(genres: Array<{ name: string; count: number }>): FpGenreBar[] {
  const clean = genres
    .filter((g) => typeof g.name === 'string' && Number.isFinite(g.count) && g.count > 0)
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const max = Math.max(1, ...clean.map((g) => g.count));
  return clean.map((g) => ({ name: g.name, count: g.count, ratio: g.count / max }));
}

/** 秒 → "4 小时 20 分" / "38 分"（渲染层直接用；不用 i18n 因�� H5 无 i18n 运行时） */
export function fpDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0 分';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor(((total % 3600) / 60));
  if (h > 0 && m > 0) return `${h} 小时 ${m} 分`;
  if (h > 0) return `${h} 小时`;
  return `${m} 分`;
}

/** 类型分布 → 直接可渲染的条形数组（fpGenres 的别名，语义更贴渲染层） */
export function fpGenreBars(
  genres: Array<{ name: string; count: number }>,
): FpGenreBar[] {
  return fpGenres(genres);
}

/**
 * 里程碑 → 展示文案
 *
 * 服务端只发 key + 数值，文案在客户端拼（否则 i18n 失效——每种语言都要改 Rust）。
 * H5 镜像同一份 key，避免两端文案分叉。
 */
export function fpMilestoneText(key: string, value: number): string {
  switch (key) {
    case 'works':
      return `${value} 个作品`;
    case 'songs':
      return `${value} 首歌`;
    case 'posts':
      return `${value} 篇动态`;
    case 'activeDays':
      return `${value} 天有创作`;
    case 'streak':
      return `连续 ${value} 天`;
    case 'minutes':
      return fpDuration(value * 60);
    default:
      return `${key} ${value}`;
  }
}

/** 过滤 0 值里程碑 → 展示项（0 值不该显示成"0 里程碑"） */
export function fpMilestones(
  milestones: Array<{ key: string; value: number }>,
): Array<{ key: string; value: number; text: string }> {
  return milestones
    .filter((m) => Number.isFinite(m.value) && m.value > 0)
    .map((m) => ({ key: m.key, value: m.value, text: fpMilestoneText(m.key, m.value) }));
}

/**
 * 热力图 → 直接可渲染的列数组（每列 7 格）
 *
 * 与 fpHeatGrid 同源的便捷包装：渲染层（H5 / 样张）要的是"列"，
 * 不必自己拆 weeks。void 格照常占位，保证列高一致。
 */
export function fpHeatColumns(
  days: Array<{ day: string; posts: number; songs: number }>,
  todayMs: number,
): FpCell[][] {
  return fpHeatGrid(days, todayMs).weeks;
}

/** 是否有内容可画（空 → 渲染兜底文案而非空网格） */
export function fpHasContent(fp: {
  days?: unknown[];
  clock?: number[];
  genres?: unknown[];
}): boolean {
  const days = fp.days?.length ?? 0;
  const clockHit = (fp.clock ?? []).some((n) => Number.isFinite(n) && n > 0);
  const genres = fp.genres?.length ?? 0;
  return days > 0 || clockHit || genres > 0;
}

/**
 * 成员纹章（镜像 memberSeal.ts）
 *
 * H5 没有构建步骤，不能 import TS，所以这里手写同一算法的 JS。
 * ⚠️ 改 memberSeal.ts 时**必须同步这里**，否则两端纹章不一致
 * （判据：seed='alice' 两端输出同一组坐标）。
 */
export function fpSealCells(seed: string): Array<{ x: number; y: number; on: boolean }> {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  h = h >>> 0;
  const cells: Array<{ x: number; y: number; on: boolean }> = [];
  const mid = 2;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x <= mid; x++) {
      const on = ((h >>> (y * (mid + 1) + x)) & 1) === 1;
      cells.push({ x, y, on });
      if (x < mid) cells.push({ x: 4 - x, y, on });
    }
  }
  return cells;
}

/** 纹章 → SVG 字符串（ink 墨色 / seal 朱砂；固定墨阶+一点朱砂，不随主题变） */
export function fpSealSvg(seed: string, ink: string, seal: string, size = 24): string {
  const rects = fpSealCells(seed)
    .filter((c) => c.on)
    .map((c) => {
      const fill = c.y === 1 && c.x === 2 ? seal : ink;
      return `<rect x="${c.x}" y="${c.y}" width="1" height="1" fill="${fill}"/>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" width="${size}" height="${size}" ` +
    `shape-rendering="crispEdges" aria-hidden="true"><g opacity="0.5">${rects}</g></svg>`
  );
}