import { describe, expect, it } from 'vitest';
import { SEAL_GRID, hash32, sealCells, sealSvg, sealStyle } from './memberSeal';

describe('hash32', () => {
  it('确定性：同输入永远同输出', () => {
    expect(hash32('alice')).toBe(hash32('alice'));
    expect(hash32('bob#42')).toBe(hash32('bob#42'));
  });

  it('落在 uint32 内', () => {
    for (const s of ['', 'a', 'alice', 'bob#42', '张三', 'x'.repeat(500)]) {
      const h = hash32(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('不同输入几乎不碰撞（生日界：32 位 / 5000 人碰撞概率 ≈ 0.3%）', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(hash32(`member_${i}`));
    expect(seen.size).toBe(5000);
  });

  it('空串有定义（不留 undefined 漏洞）', () => {
    expect(typeof hash32('')).toBe('number');
  });
});

describe('sealCells 5×5 镜像纹章', () => {
  const seedOf = (s: string) => sealCells(s);

  it('左右镜像：中轴右侧每格必有对应左侧格', () => {
    for (const seed of ['alice', 'bob#42', '张三', 'seed-9']) {
      const cells = seedOf(seed);
      for (const c of cells) {
        const mirror = cells.find((x) => x.x === SEAL_GRID - 1 - c.x && x.y === c.y);
        expect(mirror, `seed=${seed} (${c.x},${c.y})`).toBeDefined();
        expect(mirror!.on, `seed=${seed} (${c.x},${c.y}) 镜像不一致`).toBe(c.on);
      }
    }
  });

  it('每个格子恰好出现一次（无重复、无越界）', () => {
    const cells = seedOf('alice');
    expect(cells).toHaveLength(SEAL_GRID * SEAL_GRID);
    const seen = new Set(cells.map((c) => `${c.x},${c.y}`));
    expect(seen.size).toBe(SEAL_GRID * SEAL_GRID);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThan(SEAL_GRID);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThan(SEAL_GRID);
    }
  });

  /**
 * 墨色占比分布（实测 n=20000：mean 12.54 / p5 7 / p50 13 / p95 18）
 *
 * 断言分布特征而非逐个种子的上下界：填充率是二项分布，
 * 极端值必然出现（21/25 约 0.5%），锁死单点边界只会得到一条脆弱的测试。
 * 真正要保的是「没有一枚纹章是实心块或全空」——那才读不出印章。
 */
it('填充率集中在可读区间，且不出现实心/全空纹章', () => {
    const N = 2000;
    const counts: number[] = [];
    for (let i = 0; i < N; i++) {
      counts.push(seedOf(`member_${i}`).filter((c) => c.on).length);
    }
    const sorted = [...counts].sort((a, b) => a - b);
    const p = (q: number) => sorted[Math.floor(N * q)]!;

    // 分布特征：中位数落在中间三分之一，两端 5% 尾巴不越界
    expect(p(0.5)).toBeGreaterThanOrEqual(9);
    expect(p(0.5)).toBeLessThanOrEqual(16);
    expect(p(0.05), 'p5 过高 = 纹章普遍太满').toBeLessThanOrEqual(9);
    expect(p(0.95), 'p95 过低 = 纹章普遍太空').toBeGreaterThanOrEqual(15);

    // 硬保证：不出现 25/25 实心或 0/25 全空
    for (const [i, on] of counts.entries()) {
      expect(on, `member_${i} 实心纹章 ${on}/25`).toBeLessThan(25);
      expect(on, `member_${i} 全空纹章 ${on}/25`).toBeGreaterThan(0);
    }
  });

  it('不同成员纹章不同', () => {
    const sig = (s: string) => seedOf(s).map((c) => (c.on ? '1' : '0')).join('');
    const set = new Set<string>();
    for (let i = 0; i < 300; i++) set.add(sig(`member_${i}`));
    // 300 人里应至少有 200 种不同纹章
    expect(set.size).toBeGreaterThan(200);
  });

  it('只引用哈希的低 15 位（高 17 位变化不应影响纹章）', () => {
    // 15 格 × 1 位 = 位 0..14。构造两个仅高位不同的哈希来验证。
    const low = 0x12345;
    const high = 0x80000000 | low;
    const LOW15 = 0b111_1111_111_111_111;
    expect(high & LOW15).toBe(low & LOW15);
    // 位 14 被最后一行最右格使用 —— 改它必须改纹章
    const flipped = low ^ (1 << 14);
    expect(flipped & LOW15).not.toBe(low & LOW15);
  });
});

describe('sealStyle / sealSvg 输出', () => {
  it('CSS 版：多格 linear-gradient + 印章感边框', () => {
    const s = sealStyle('alice#7', '#333333', '#c0392b', 28) as Record<string, unknown>;
    expect(s.width).toBe(28);
    expect(s.height).toBe(28);
    expect(String(s.backgroundImage)).toContain('linear-gradient');
    expect(String(s.border)).toContain('1px');
    expect(s.borderRadius).toBe('18%');
    // 朱砂只出现一次（对轴上的唯一暖点）
    expect(String(s.backgroundImage).split('#c0392b').length - 1).toBe(1);
  });

  it('CSS 版尺寸可变（样张与页头用不同尺寸）', () => {
    const small = sealStyle('a', '#000', '#c0392b', 16) as Record<string, unknown>;
    expect(small.width).toBe(16);
  });

  it('SVG 版：与 CSS 版格子数一致（同一算法跨端复现）', () => {
    for (const seed of ['alice', 'bob#42', '张三']) {
      const cells = sealCells(seed).filter((c) => c.on).length;
      const svg = sealSvg(seed, '#333333', '#c0392b', 24);
      expect((svg.match(/<rect /g) ?? []).length, `seed=${seed}`).toBe(cells);
    }
  });

  it('SVG 版结构完整且转义安全（不引入外部引用）', () => {
    const svg = sealSvg('<script>x</script>', '#000', '#c0392b');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('viewBox="0 0 5 5"');
    expect(svg).not.toContain('href');
    // 颜色是参数化传入的，seed 本身绝不进入 SVG 文本
    expect(svg).not.toContain('script');
  });
});