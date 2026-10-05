/**
 * LyricParticles — 音频律动粒子层（星尘风格，桌面歌词浮窗专用）。
 *
 * 数据源：Rust AudioMixer `audio_get_spectrum`（24 频段能量 0~1，轮询 20fps）。
 * 粒子被真实音乐驱动：低音（0-5 段）做节拍检测，中频（6-13）控密度，高频（14+）控速度。
 *
 * ⚠️ 实现说明：桌面歌词浮窗是**透明窗口**，WebView2 里 <canvas> 合成会破坏
 * alpha 通道（画布区域整块变白）。因此浮窗粒子用 **DOM div + transform/opacity**
 * 实现（与歌词文字同渲染路径，透明性可靠）；普通不透明窗口里的 SpectrumRing
 * 环形频谱仍用 canvas。
 *
 * 导出：
 *  - `LyricParticles`  星尘光尘粒子层，前后两层夹住歌词文字（背层多 + 前层少，
 *                       z 分层由消费端 SCSS 的 `.lyric-fx-layer(--front)` 决定）。
 *  - `SpectrumRing`    环形频谱（电台唱片外圈径向光柱，仅限不透明窗口）。
 *  - `useRhythmDriver` 直写 style 的低音驱动 hook（氛围缩放 + `--pulse` 变量，不经 re-render）。
 *
 * 性能纪律：30fps 节流；80 个粒子 div；直写 transform/opacity，不经 React re-render；
 * 暂停即熄灭。
 */
/* eslint-disable react-refresh/only-export-components -- 本文件即「粒子组件 + 配套 hook」集合，拆文件反而散 */
import React, { useEffect, useRef } from 'react';
import { audioPlaybackApi } from '../vrm/lib/audioPlaybackApi';

const BANDS = 24;
const FRAME_MS = 33; // 30fps
const POLL_MS = 50; // 频谱轮询 ~20fps
const STARDUST_DIVS = 80;
/** 飘在歌词文字前面的粒子数（其余在文字后面，前少后多避免糊字）。 */
const STARDUST_FRONT_DIVS = 24;

function avgOf(bands: number[], start: number, end: number): number {
  let sum = 0;
  let n = 0;
  for (let i = start; i < end && i < bands.length; i++) {
    sum += bands[i];
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function accentColor(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--color-accent-400').trim();
    if (v) return v;
  } catch {
    // SSR / 非浏览器环境兜底
  }
  return '#60a5fa';
}

interface StardustParticle {
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  scale: number;
  seed: number;
}

/** 星尘粒子层：光尘随人声升起，鼓点瞬间成片爆发提亮 */
export const LyricParticles: React.FC<{ active: boolean; className?: string }> = ({
  active,
  className,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const colorRef = useRef<string>('#60a5fa');

  useEffect(() => {
    colorRef.current = accentColor();
  }, []);

  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    // 前后两层容器内取全部粒子（文档序：背层在前、前层在后，下标与粒子数组对齐）
    const els = Array.from(root.querySelectorAll<HTMLElement>('.lyric-fx-pt'));
    if (els.length === 0) return;

    const w = root.clientWidth;
    const h = root.clientHeight;

    let alive = true;
    let raf = 0;
    let last = performance.now();
    let lastPoll = 0;
    let bands: number[] = new Array<number>(BANDS).fill(0);
    let bassAvg = 0.15;
    let lastBeat = 0;

    const particles: StardustParticle[] = [];

    const spawn = (i: number): void => {
      particles[i] = {
        x: Math.random() * w,
        y: h + 4,
        vy: -(0.5 + avgOf(bands, 14, BANDS) * 1.6) * (0.6 + Math.random() * 0.8),
        life: 0,
        maxLife: 80 + Math.random() * 70,
        scale: 0.6 + avgOf(bands, 14, BANDS) * 1.2 + Math.random() * 0.9,
        seed: Math.random() * Math.PI * 2,
      };
    };

    const tick = (now: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      const dt = Math.min(6, (now - last) / 16.7);
      last = now;
      if (now - lastPoll > POLL_MS) {
        lastPoll = now;
        audioPlaybackApi
          .audioGetSpectrum()
          .then((d) => {
            if (alive && d.length > 0) bands = d.length >= BANDS ? d.slice(0, BANDS) : d.concat(bands.slice(d.length));
          })
          .catch(() => {
            // mixer 未就绪——沿用旧值
          });
      }
      const bass = avgOf(bands, 0, 6);
      const mid = avgOf(bands, 6, 14);
      bassAvg = bassAvg * 0.92 + bass * 0.08;
      let beat = false;
      if (bass > 0.12 && bass > bassAvg * 1.4 && now - lastBeat > 220) {
        beat = true;
        lastBeat = now;
      }
      const glow = Math.min(1, bass * 1.5);

      // 生成：中频驱动密度，节拍爆发
      const spawnRate = (1 + mid * 5 + (beat ? 8 : 0)) * dt;
      let n = spawnRate;
      while (n > 0 && particles.length < STARDUST_DIVS) {
        if (n < 1 && Math.random() > n) break;
        spawn(particles.length);
        n -= 1;
      }

      for (let i = 0; i < STARDUST_DIVS; i++) {
        const el = els[i];
        if (!el) continue;
        const p = particles[i];
        if (!p) {
          el.style.opacity = '0';
          continue;
        }
        p.life += dt;
        p.y += p.vy * dt;
        p.x += Math.sin(p.life * 0.05 + p.seed) * 0.5 * dt;
        if (p.life >= p.maxLife || p.y < -6) {
          spawn(i);
          continue;
        }
        const t = p.life / p.maxLife;
        const a = Math.sin(Math.PI * t) * (0.4 + glow * 0.5);
        el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) scale(${p.scale.toFixed(2)})`;
        el.style.opacity = Math.max(0, Math.min(1, a)).toFixed(2);
      }
    };

    raf = requestAnimationFrame(tick);
    const onVis = () => {
      // 标签页隐藏后恢复时重置时钟，避免 dt 巨突
      last = performance.now();
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [active]);

  return (
    <div ref={rootRef} className={className} aria-hidden="true">
      <div className="lyric-fx-layer">
        {Array.from({ length: STARDUST_DIVS - STARDUST_FRONT_DIVS }, (_, i) => (
          <i key={i} className="lyric-fx-pt" style={{ background: colorRef.current }} />
        ))}
      </div>
      <div className="lyric-fx-layer lyric-fx-layer--front">
        {Array.from({ length: STARDUST_FRONT_DIVS }, (_, i) => (
          <i key={i} className="lyric-fx-pt" style={{ background: colorRef.current }} />
        ))}
      </div>
    </div>
  );
};

/** 环形频谱：48 根径向光柱围一圈（电台唱片外圈；仅限不透明窗口——canvas 在透明窗口会破坏 alpha） */
export const SpectrumRing: React.FC<{ active: boolean; className?: string }> = ({ active, className }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const colorRef = useRef<string>('#60a5fa');
  const smoothRef = useRef<number[]>(new Array(BANDS).fill(0));

  useEffect(() => {
    colorRef.current = accentColor();
  }, []);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let alive = true;
    let raf = 0;
    let last = performance.now();
    let lastPoll = 0;
    let bands: number[] = new Array<number>(BANDS).fill(0);

    const setup = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    setup();
    const ro = new ResizeObserver(setup);
    ro.observe(canvas);

    const tick = (now: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      if (now - lastPoll > POLL_MS) {
        lastPoll = now;
        audioPlaybackApi
          .audioGetSpectrum()
          .then((d) => {
            if (alive && d.length > 0) bands = d.length >= BANDS ? d.slice(0, BANDS) : d;
          })
          .catch(() => {});
      }
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      const smooth = smoothRef.current;
      const bars = BANDS * 2;
      const cx = w / 2;
      const cy = h / 2;
      const maxLen = Math.min(w, h) * 0.14;
      // 内半径要给最长频谱条留出空间，否则条被画布边界截断（画布即矩形，
      // 斜向处的可用距离比正交处更长 → 表现为长短不一的「被切掉」）
      const r0 = Math.min(w, h) / 2 - maxLen - 2;
      ctx.strokeStyle = colorRef.current;
      ctx.lineWidth = 2;
      for (let i = 0; i < bars; i++) {
        const bandIdx = i < bars / 2 ? i : bars - 1 - i;
        const target = bands[bandIdx % BANDS] ?? 0;
        smooth[bandIdx % BANDS] = smooth[bandIdx % BANDS] * 0.75 + target * 0.25;
        const v = smooth[bandIdx % BANDS];
        const len = Math.max(2, v * maxLen);
        const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
        ctx.globalAlpha = Math.min(1, 0.3 + v * 0.7);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0);
        ctx.lineTo(cx + Math.cos(angle) * (r0 + len), cy + Math.sin(angle) * (r0 + len));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
};

/**
 * useRhythmDriver — 低音驱动直写 style（不经 re-render）：
 *  - atmoRef 元素：transform scale 随低音呼吸
 *  - varsRef 元素：写 `--pulse`（0~1）供 CSS 消费（当前行微脉冲）
 */
export function useRhythmDriver(
  active: boolean,
  atmoRef: React.RefObject<HTMLElement | null>,
  varsRef: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) return;
    // cleanup 用局部捕获，避免 ref.current 时点问题
    const atmoEl = atmoRef.current;
    const varsEl = varsRef.current;
    if (!atmoEl && !varsEl) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let bassAvg = 0.15;

    const tick = () => {
      if (!alive) return;
      audioPlaybackApi
        .audioGetSpectrum()
        .then((d) => {
          if (!alive) return;
          const bass = d.length > 0 ? avgOf(d, 0, 6) : 0;
          bassAvg = bassAvg * 0.88 + bass * 0.12;
          const surge = Math.max(0, bass - bassAvg * 0.8);
          const scale = 1 + Math.min(0.07, surge * 0.12);
          if (atmoEl) {
            atmoEl.style.transform = `scale(${scale.toFixed(3)})`;
          }
          if (varsEl) {
            varsEl.style.setProperty('--pulse', Math.min(1, bass * 1.2).toFixed(3));
          }
        })
        .catch(() => {})
        .finally(() => {
          if (alive) timer = setTimeout(tick, 66);
        });
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      // 复位
      if (atmoEl) atmoEl.style.transform = '';
      if (varsEl) varsEl.style.setProperty('--pulse', '0');
    };
  }, [active, atmoRef, varsRef]);
}
