/**
 * 桌宠表情系统（素材来自岛仔 Daozai，MIT；见 public/pet/doll2/expressions/ATTRIBUTION.md）。
 *
 * 借鉴点：12 种表情 × 16 帧序列图、状态驱动、按需加载/播完释放、
 * 冷却与安静间隔、浅色主题眼睛改色、跟随系统减动效。
 *
 * 设计：
 * - 每张序列图 144×1440（16 帧竖排，每帧 144×90，3 倍密度）。
 * - 只在播放某表情时 fetch + 解码那一张，播完释放 Image 引用（浏览器缓存仍可复用）。
 * - 调度由 activity/mood 触发；悬停/日常待机各自冷却；专注/睡眠等状态让位不播。
 * - 不直接依赖 PIXI：只产出「当前该画哪一帧」的 Image + 取帧矩形，
 *   由 DollAvatar 在 bone-doll render 之后用 canvas 2D 合成（天然跟随镜像/缩放）。
 */

import type { AvatarActivity, AvatarMood } from '../world/types';

export type ExpressionName =
  | 'wink' | 'smug' | 'blush' | 'delighted' | 'sideGlance' | 'praised'
  | 'heart' | 'giggle' | 'shyPeek' | 'scan' | 'peek' | 'search';

interface ExpressionDef {
  name: ExpressionName;
  file: string;
  /** 每帧时长（秒），16 项 */
  times: [number, number, number, number, number, number, number, number,
          number, number, number, number, number, number, number, number];
}

const SHORT_TIMES: ExpressionDef['times'] = [
  0.35, 0.12, 0.12, 0.12, 0.13, 0.13, 0.14, 0.40,
  0.18, 0.14, 0.12, 0.12, 0.12, 0.14, 0.14, 0.45,
];
const LONG_TIMES: ExpressionDef['times'] = [
  0.35, 0.13, 0.15, 0.18, 0.35, 0.28, 0.16, 0.11,
  0.11, 0.16, 0.35, 0.28, 0.16, 0.14, 0.20, 0.35,
];

const EXPRESSIONS: ExpressionDef[] = [
  { name: 'wink',       file: '00-wink.png',       times: SHORT_TIMES },
  { name: 'smug',       file: '01-smug.png',       times: SHORT_TIMES },
  { name: 'blush',      file: '02-blush.png',      times: SHORT_TIMES },
  { name: 'delighted',  file: '03-delighted.png',  times: SHORT_TIMES },
  { name: 'sideGlance', file: '04-side-glance.png', times: SHORT_TIMES },
  { name: 'praised',    file: '05-praised.png',    times: SHORT_TIMES },
  { name: 'heart',      file: '06-heart.png',      times: SHORT_TIMES },
  { name: 'giggle',     file: '07-giggle.png',     times: SHORT_TIMES },
  { name: 'shyPeek',    file: '08-shy-peek.png',   times: SHORT_TIMES },
  { name: 'scan',       file: '09-scan.png',       times: LONG_TIMES },
  { name: 'peek',       file: '10-peek.png',       times: LONG_TIMES },
  { name: 'search',     file: '11-search.png',     times: LONG_TIMES },
];

const BY_NAME = new Map<ExpressionName, ExpressionDef>(EXPRESSIONS.map((e) => [e.name, e]));

/** 帧规格：144×1440，16 帧竖排 */
const FRAME_W = 144;
const FRAME_H = 90;
const FRAME_COUNT = 16;

/** 触发→表情轮播表（借鉴岛仔 react()/step()） */
const MOOD_POOL: Partial<Record<AvatarMood, ExpressionName[]>> = {
  happy: ['praised', 'smug', 'delighted', 'giggle'],
  curious: ['wink', 'blush', 'sideGlance', 'shyPeek'],
  social: ['heart', 'delighted', 'wink'],
};
const ACTIVITY_POOL: Partial<Record<AvatarActivity, ExpressionName[]>> = {
  reading: ['scan', 'search'],
  watering: ['smug', 'delighted'],
  harvesting: ['delighted', 'heart'],
  planting: ['blush', 'peek'],
  photographing: ['shyPeek', 'smug'],
  greeting: ['wink', 'delighted'],
  playing: ['giggle', 'heart'],
  chatting: ['smug', 'wink'],
};
/** 日常待机轮播（安静间隔更长） */
const IDLE_POOL: ExpressionName[] = ['scan', 'delighted', 'peek', 'smug', 'search', 'giggle', 'praised', 'shyPeek'];
/** 让位状态：不播表情 */
const SUPPRESS_ACTIVITIES: AvatarActivity[] = ['resting', 'flying', 'jumping', 'rolling', 'visiting', 'returning'];

export interface ExpressionFrame {
  image: HTMLImageElement;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export class ExpressionSystem {
  private baseUrl: string;
  private current: ExpressionDef | null = null;
  private image: HTMLImageElement | null = null;
  private elapsed = 0;
  private poolIndex = 0;
  /** 下次可播时间戳（ms）。冷却 + 安静间隔由调用方设置 */
  private cooldownUntil = 0;
  private hidden = false;
  private reduced = false;
  private lightTheme = false;
  private loadToken = 0;
  private imageCache = new Map<ExpressionName, HTMLImageElement>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '') + '/expressions/';
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const root = document.documentElement;
    // 显式 data-motion 优先：full → 开表情；reduced → 关；未设才回退系统偏好。
    // Windows「自定义动画设置」常让系统偏好误报 reduce，不能让它覆盖产品默认。
    const resolveReduced = (): boolean => {
      const attr = root.dataset.motion;
      return attr === 'reduced' || (attr !== 'full' && mq.matches);
    };
    this.reduced = resolveReduced();
    mq.addEventListener('change', () => {
      this.reduced = resolveReduced();
      if (this.reduced) this.stop();
    });
    this.lightTheme = root.dataset.themeType === 'light';
    new MutationObserver(() => {
      this.lightTheme = document.documentElement.dataset.themeType === 'light';
      this.reduced = resolveReduced();
      if (this.reduced) this.stop();
    }).observe(root, { attributes: true, attributeFilter: ['data-theme-type', 'data-motion'] });
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.stop();
  }

  /** 活动/情绪变化时调用；返回是否触发了表情 */
  react(activity: AvatarActivity, mood: AvatarMood): boolean {
    if (this.hidden || this.reduced) return false;
    if (SUPPRESS_ACTIVITIES.includes(activity)) {
      this.stop();
      return false;
    }
    const pool = ACTIVITY_POOL[activity] ?? MOOD_POOL[mood];
    if (!pool || pool.length === 0) return false;
    if (Date.now() < this.cooldownUntil) return false;
    this.playPool(pool, 0);
    return true;
  }

  /** 日常待机：由外部按低频 tick 调用 */
  idleTick(): boolean {
    if (this.hidden || this.reduced || this.current) return false;
    if (Date.now() < this.cooldownUntil) return false;
    this.playPool(IDLE_POOL, 22000 + Math.floor(Math.random() * 4) * 3000);
    return true;
  }

  /** 悬停/被关注时的即时反应（更短冷却） */
  poke(): boolean {
    if (this.hidden || this.reduced || this.current) return false;
    if (Date.now() < this.cooldownUntil) return false;
    this.playPool(MOOD_POOL.curious!, 18000);
    return true;
  }

  private playPool(pool: ExpressionName[], cooldownMs: number): void {
    const name = pool[this.poolIndex % pool.length];
    this.poolIndex++;
    void this.play(name, cooldownMs);
  }

  private async play(name: ExpressionName, cooldownMs: number): Promise<void> {
    const def = BY_NAME.get(name);
    if (!def) return;
    const token = ++this.loadToken;
    let img = this.imageCache.get(name) ?? null;
    if (!img) {
      const loaded = await new Promise<HTMLImageElement | null>((resolve) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => resolve(null);
        el.src = this.baseUrl + def.file;
      });
      if (loaded) {
        this.imageCache.set(name, loaded);
        img = loaded;
      }
    }
    if (token !== this.loadToken || !img) return;
    this.current = def;
    this.image = img;
    this.elapsed = 0;
    this.cooldownUntil = Date.now() + cooldownMs;
  }

  stop(): void {
    this.loadToken++;
    this.current = null;
    this.image = null;
  }

  /** 每帧推进；返回当前应绘制的帧（无播放返回 null） */
  update(deltaMs: number): ExpressionFrame | null {
    if (!this.current || !this.image || this.hidden) return null;
    this.elapsed += deltaMs / 1000;
    const times = this.current.times;
    let total = 0;
    for (const t of times) total += t;
    if (this.elapsed >= total) {
      this.stop();
      return null;
    }
    let acc = 0;
    let idx = FRAME_COUNT - 1;
    for (let i = 0; i < times.length; i++) {
      acc += times[i];
      if (this.elapsed < acc) { idx = i; break; }
    }
    return {
      image: this.image,
      sx: 0,
      sy: idx * FRAME_H,
      sw: FRAME_W,
      sh: FRAME_H,
    };
  }

  get isLightTheme(): boolean { return this.lightTheme; }
  get isReduced(): boolean { return this.reduced; }
  get isPlaying(): boolean { return this.current !== null; }
}
