import { describe, expect, it } from 'vitest';
import {
  buildClock,
  buildHeatGrid,
  buildMilestones,
  fmtDurationHuman,
  formatDay,
  hasFingerprintContent,
  parseDay,
} from './fingerprint';

const DAY = 86_400_000;
const today = Date.UTC(2026, 9, 4); // 2026-10-04 是周日

describe('日期工具', () => {
  it('parseDay / formatDay 往返一致（UTC 语义）', () => {
    for (const d of ['2026-10-04', '2026-01-01', '2024-02-29']) {
      expect(formatDay(parseDay(d)), d).toBe(d);
    }
  });

  it('非法日期返回 NaN 而不是 0（0 会被当成 1970 画进热力图）', () => {
    for (const bad of ['', 'nope', '2026-13-01', '2026-1-1', '26-01-01']) {
      expect(Number.isNaN(parseDay(bad)), bad).toBe(true);
    }
  });
});

describe('buildHeatGrid 周桶切分', () => {
  it('网格按 7 天一列、列内周日→周六排列', () => {
    const g = buildHeatGrid([], today);
    expect(g.weeks.every((w) => w.length === 7)).toBe(true);
    // 第一格应落在周日（UTC weekday 0）
    expect(new Date(parseDay(g.weeks[0]![0]!.day)).getUTCDay()).toBe(0);
  });

  it('可见格子恒为 365 天；周对齐不产生多余可见格', () => {
    // startMs = today - 364 天。364 = 52 周，所以当 today 是周日時
    // startMs 恰好也是周日，网格对齐后没有前置空格——这是正确行为，
    // 断言可见格恒为 365 才能锁住"不多画一天"。
    const g = buildHeatGrid([], today);
    expect(g.weeks.flat().filter((c) => c.level >= 0).length).toBe(365);
    // 网格永远补满整周（末列含 today 之后的占位格，level=-1）
    const lastWeek = g.weeks[g.weeks.length - 1]!;
    expect(lastWeek[0]!.day).toBe('2026-10-04');
    expect(lastWeek[0]!.level).toBeGreaterThanOrEqual(0);
    expect(lastWeek.slice(1).every((c) => c.level === -1)).toBe(true);
  });

  it('today 在周中时，该周之后的格子标记 -1（前补空格也不计入可见）', () => {
    const wed = Date.UTC(2026, 9, 7);
    const g = buildHeatGrid([], wed);
    const col = g.weeks.find((w) => w.some((c) => c.day === '2026-10-07'))!;
    expect(col.filter((c) => c.level === -1).length).toBe(3);
    expect(g.weeks.flat().filter((c) => c.level >= 0).length).toBe(365);
  });

  it('今天一定在网格里且 level >= 0', () => {
    const g = buildHeatGrid([], today);
    const flat = g.weeks.flat();
    const cell = flat.find((c) => c.day === '2026-10-04');
    expect(cell).toBeDefined();
    expect(cell!.level).toBeGreaterThanOrEqual(0);
  });

  it('日计数落到正确格子并合并 posts+songs', () => {
    const g = buildHeatGrid(
      [
        { day: '2026-10-04', posts: 2, songs: 1 },
        { day: '2026-10-02', posts: 5, songs: 0 },
      ],
      today,
    );
    const flat = g.weeks.flat();
    expect(flat.find((c) => c.day === '2026-10-04')!.total).toBe(3);
    expect(flat.find((c) => c.day === '2026-10-02')!.total).toBe(5);
  });

  it('强度分档是长尾友好的（0/1/2/3-4/5+ 五档）', () => {
    const mk = (n: number) => buildHeatGrid([{ day: '2026-10-04', posts: n, songs: 0 }], today)
      .weeks.flat().find((c) => c.day === '2026-10-04')!.level;
    expect(mk(0)).toBe(0);
    expect(mk(1)).toBe(1);
    expect(mk(2)).toBe(2);
    expect(mk(4)).toBe(3);
    expect(mk(5)).toBe(4);
    expect(mk(999)).toBe(4);
  });

  it('服务端漏发的日子按 0 处理，不留空洞', () => {
    const g = buildHeatGrid([{ day: '2026-10-04', posts: 1, songs: 0 }], today);
    const flat = g.weeks.flat().filter((c) => c.level >= 0);
    expect(flat.length).toBe(365);
    expect(flat.filter((c) => c.total === 0).length).toBe(364);
  });
});

describe('buildClock 时钟分布', () => {
  it('恒 24 桶（客户端按固定长度渲染）', () => {
    expect(buildClock([]).length).toBe(24);
    expect(buildClock(new Array(24).fill(3)).length).toBe(24);
  });

  it('ratio 归一化到 0..1，峰值桶为 1', () => {
    const bars = buildClock([
      ...new Array(24).fill(0),
    ]);
    const withPeak = [
      ...new Array(3).fill(0), 7, ...new Array(20).fill(1),
    ];
    const b = buildClock(withPeak);
    expect(b[3]!.ratio).toBe(1);
    expect(b[0]!.ratio).toBe(0);
    for (const x of b) {
      expect(x.ratio).toBeGreaterThanOrEqual(0);
      expect(x.ratio).toBeLessThanOrEqual(1);
    }
    expect(bars.length).toBe(24);
  });

  it('全 0 时不产生 NaN（会画出空白条）', () => {
    for (const b of buildClock(new Array(24).fill(0))) {
      expect(Number.isFinite(b.ratio)).toBe(true);
      expect(b.ratio).toBe(0);
    }
  });

  it('非法输入（NaN/null）被清洗为 0', () => {
    const dirty = [NaN, null as unknown as number, undefined as unknown as number, 3];
    const b = buildClock(dirty);
    expect(b[0]!.count).toBe(0);
    expect(b[1]!.count).toBe(0);
    expect(b[2]!.count).toBe(0);
    expect(b[3]!.count).toBe(3);
  });

  it('不做时区旋转：hour 原样保留（服务端给 UTC，无可信时区来源）', () => {
    const b = buildClock(new Array(24).fill(0));
    expect(b.map((x) => x.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });
});

describe('buildMilestones / fmtDurationHuman', () => {
  it('过滤掉 0 值里程碑（否则页面出现"0 里程碑"）', () => {
    const v = buildMilestones(
      [
        { key: 'works', value: 0 },
        { key: 'streak', value: 7 },
        { key: 'NaN' as string, value: NaN },
      ],
      (k, n) => `${k}=${n}`,
    );
    expect(v.map((x) => x.key)).toEqual(['streak']);
  });

  it('文案由客户端拼（服务端只发数值，i18n 不能在 Rust 里做）', () => {
    const v = buildMilestones([{ key: 'works', value: 24 }], (k, n) => `${n} 个作品`);
    expect(v[0]!.label).toBe('24 个作品');
  });

  it('时长人类可读', () => {
    expect(fmtDurationHuman(0)).toBe('0 分');
    expect(fmtDurationHuman(59)).toBe('0 分');
    expect(fmtDurationHuman(60)).toBe('1 分');
    expect(fmtDurationHuman(3600)).toBe('1 小时');
    expect(fmtDurationHuman(3600 + 20 * 60)).toBe('1 小时 20 分');
    expect(fmtDurationHuman(-5)).toBe('0 分');
    expect(fmtDurationHuman(NaN)).toBe('0 分');
  });
});

describe('hasFingerprintContent 空态判定', () => {
  it('全空 → false（渲染兜底文案而不是空网格）', () => {
    expect(hasFingerprintContent({ days: [], clock: new Array(24).fill(0), genres: [] })).toBe(false);
  });

  it('任一维度有内容 → true', () => {
    expect(hasFingerprintContent({ days: [{ day: 'x' }], clock: [], genres: [] })).toBe(true);
    expect(hasFingerprintContent({ days: [], clock: new Array(24).fill(1), genres: [] })).toBe(true);
    expect(hasFingerprintContent({ days: [], clock: [], genres: [{ name: 'a' }] })).toBe(true);
  });

  it('字段缺失不崩', () => {
    expect(hasFingerprintContent({} as never)).toBe(false);
  });
});

describe('跨零/跨月边界', () => {
  it('跨年热力图不错位（1 月 1 日附近）', () => {
    const jan1 = Date.UTC(2026, 0, 1);
    const g = buildHeatGrid([{ day: '2026-01-01', posts: 3, songs: 0 }], jan1);
    const cell = g.weeks.flat().find((c) => c.day === '2026-01-01');
    expect(cell).toBeDefined();
    expect(cell!.total).toBe(3);
  });

  it('闰日（2024-02-29）正确落格', () => {
    const feb29 = Date.UTC(2024, 1, 29);
    const g = buildHeatGrid([{ day: '2024-02-29', posts: 1, songs: 0 }], feb29);
    expect(g.weeks.flat().find((c) => c.day === '2024-02-29')!.total).toBe(1);
    // 不应出现 2024-03-01 之前/之后的幽灵格导致天数超 365
    expect(g.weeks.flat().filter((c) => c.level >= 0).length).toBe(365);
  });

  it('todayMs 落在周中时，该周仍完整 7 格', () => {
    const wed = Date.UTC(2026, 9, 7); // 2026-10-07 周三
    const g = buildHeatGrid([], wed);
    expect(g.weeks.every((w) => w.length === 7)).toBe(true);
    // 周三所在列：前 3 格有效、后 4 格未来
    const col = g.weeks.find((w) => w.some((c) => c.day === '2026-10-07'))!;
    expect(col.filter((c) => c.level >= 0).length).toBe(4); // 周日~周三
    expect(col.filter((c) => c.level === -1).length).toBe(3);
  });
});

describe('时长单位', () => {
  it('DAY 常量与 parseDay 一致（避免各处硬编码 86400000 写错）', () => {
    expect(parseDay('2026-10-05') - parseDay('2026-10-04')).toBe(DAY);
  });
});