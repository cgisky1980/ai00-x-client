// ========================================================================
// 植物配置数据（5 种 MVP 植物）
// ========================================================================
// 设计原则：
// - 每种植物 6 个生长阶段，每阶段有 emoji + 持续时间
// - 浇水可加速生长（durationMs × (1 - waterCount × 0.1)，最低 0.5x）
// - 枯萎后会掉落种子（概率 dropSeedChance）或果实（概率 dropFruitChance）
// - 所有时间单位毫秒，方便与 Date.now() 对比
// ========================================================================

import type { PlantType, PlantStage } from '../types';

/** 单个阶段的配置 */
export interface PlantStageConfig {
    /** 该阶段的 emoji（用于 PIXI.Text 渲染） */
    emoji: string;
    /** 该阶段持续时长（ms），超过则推进到下一阶段 */
    durationMs: number;
    /** 该阶段植物相对花盆顶部的 Y 偏移（屏幕像素，正值向下） */
    yOffset: number;
    /** 渲染缩放（0.5-1.5） */
    scale: number;
}

/** 单种植物的配置 */
export interface PlantConfig {
    /** 植物类型 ID */
    type: PlantType;
    /** 中文名 */
    name: string;
    /** 英文名 */
    nameEn: string;
    /** 简介描述 */
    description: string;
    /** 6 个阶段的配置，按生长顺序 */
    stages: Record<PlantStage, PlantStageConfig>;
    /** 收获时获得的果实子类型（加入 collection） */
    fruitSubType: string;
    /** 收获时获得的种子子类型 */
    seedSubType: string;
    /** 枯萎后掉落种子的概率（0-1） */
    dropSeedChance: number;
    /** 枯萎后掉落果实的概率（0-1） */
    dropFruitChance: number;
    /** 该植物对水分的偏好（影响生长速度，1.0 标准） */
    waterAffinity: number;
}

// ─── 5 种植物配置 ────────────────────────────────────────────────

export const PLANT_CONFIGS: Record<PlantType, PlantConfig> = {
    sunflower: {
        type: 'sunflower',
        name: '向日葵',
        nameEn: 'Sunflower',
        description: '永远朝着阳光的方向，象征积极与希望。',
        stages: {
            seed:    { emoji: '🌰', durationMs: 30_000,  yOffset: -10, scale: 0.6 },
            sprout:  { emoji: '🌱', durationMs: 60_000,  yOffset: -20, scale: 0.7 },
            growing: { emoji: '🌿', durationMs: 120_000, yOffset: -35, scale: 0.85 },
            blooming:{ emoji: '🌻', durationMs: 300_000, yOffset: -55, scale: 1.0 },
            fruiting:{ emoji: '🥜', durationMs: 180_000, yOffset: -55, scale: 1.0 },
            wilting: { emoji: '🥀', durationMs: 90_000,  yOffset: -50, scale: 0.95 },
        },
        fruitSubType: 'sunflower_seed',
        seedSubType: 'sunflower',
        dropSeedChance: 0.8,
        dropFruitChance: 0.3,
        waterAffinity: 1.0,
    },
    daisy: {
        type: 'daisy',
        name: '雏菊',
        nameEn: 'Daisy',
        description: '清新淡雅的小花，象征着纯洁与天真。',
        stages: {
            seed:    { emoji: '🌰', durationMs: 25_000,  yOffset: -8,  scale: 0.55 },
            sprout:  { emoji: '🌱', durationMs: 50_000,  yOffset: -18, scale: 0.65 },
            growing: { emoji: '🌿', durationMs: 100_000, yOffset: -30, scale: 0.8 },
            blooming:{ emoji: '🌼', durationMs: 280_000, yOffset: -45, scale: 0.95 },
            fruiting:{ emoji: '🌸', durationMs: 150_000, yOffset: -45, scale: 0.95 },
            wilting: { emoji: '🥀', durationMs: 80_000,  yOffset: -40, scale: 0.9 },
        },
        fruitSubType: 'daisy_seed',
        seedSubType: 'daisy',
        dropSeedChance: 0.75,
        dropFruitChance: 0.35,
        waterAffinity: 0.9,
    },
    lavender: {
        type: 'lavender',
        name: '薰衣草',
        nameEn: 'Lavender',
        description: '紫色的宁静之花，散发舒缓的香气。',
        stages: {
            seed:    { emoji: '🌰', durationMs: 35_000,  yOffset: -8,  scale: 0.55 },
            sprout:  { emoji: '🌱', durationMs: 70_000,  yOffset: -18, scale: 0.65 },
            growing: { emoji: '🌿', durationMs: 140_000, yOffset: -32, scale: 0.8 },
            blooming:{ emoji: '💜', durationMs: 320_000, yOffset: -50, scale: 0.95 },
            fruiting:{ emoji: '🟣', durationMs: 160_000, yOffset: -50, scale: 0.95 },
            wilting: { emoji: '🥀', durationMs: 85_000,  yOffset: -45, scale: 0.9 },
        },
        fruitSubType: 'lavender_seed',
        seedSubType: 'lavender',
        dropSeedChance: 0.7,
        dropFruitChance: 0.4,
        waterAffinity: 0.8,
    },
    mimosa: {
        type: 'mimosa',
        name: '含羞草',
        nameEn: 'Mimosa',
        description: '触碰即合拢的害羞植物，像在和你玩捉迷藏。',
        stages: {
            seed:    { emoji: '🌰', durationMs: 28_000,  yOffset: -8,  scale: 0.55 },
            sprout:  { emoji: '🌱', durationMs: 55_000,  yOffset: -16, scale: 0.65 },
            growing: { emoji: '🌿', durationMs: 110_000, yOffset: -28, scale: 0.8 },
            blooming:{ emoji: '🌸', durationMs: 260_000, yOffset: -42, scale: 0.9 },
            fruiting:{ emoji: '花粉', durationMs: 140_000, yOffset: -42, scale: 0.9 },
            wilting: { emoji: '🥀', durationMs: 75_000,  yOffset: -38, scale: 0.85 },
        },
        fruitSubType: 'mimosa_seed',
        seedSubType: 'mimosa',
        dropSeedChance: 0.78,
        dropFruitChance: 0.25,
        waterAffinity: 1.1,
    },
    cactus: {
        type: 'cactus',
        name: '仙人掌',
        nameEn: 'Cactus',
        description: '坚韧的沙漠植物，象征顽强与独立。',
        stages: {
            seed:    { emoji: '🌰', durationMs: 40_000,  yOffset: -8,  scale: 0.55 },
            sprout:  { emoji: '🌱', durationMs: 80_000,  yOffset: -15, scale: 0.65 },
            growing: { emoji: '🌵', durationMs: 160_000, yOffset: -25, scale: 0.8 },
            blooming:{ emoji: '🌵', durationMs: 280_000, yOffset: -35, scale: 0.95 },
            fruiting:{ emoji: '🍓', durationMs: 200_000, yOffset: -35, scale: 0.95 },
            wilting: { emoji: '🥀', durationMs: 100_000, yOffset: -32, scale: 0.9 },
        },
        fruitSubType: 'cactus_fruit',
        seedSubType: 'cactus',
        dropSeedChance: 0.6,
        dropFruitChance: 0.5,
        waterAffinity: 0.5, // 仙人掌需水少，浇水效果减半
    },
};

/** 阶段推进顺序 */
export const STAGE_ORDER: PlantStage[] = ['seed', 'sprout', 'growing', 'blooming', 'fruiting', 'wilting'];

/** 获取下一阶段（wilting 之后无下一阶段，返回 null） */
export function nextStage(stage: PlantStage): PlantStage | null {
    const idx = STAGE_ORDER.indexOf(stage);
    if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null;
    return STAGE_ORDER[idx + 1];
}

/** 获取植物配置 */
export function getPlantConfig(type: PlantType): PlantConfig {
    return PLANT_CONFIGS[type];
}

/** 获取当前阶段的配置 */
export function getStageConfig(type: PlantType, stage: PlantStage): PlantStageConfig {
    return PLANT_CONFIGS[type].stages[stage];
}

/**
 * 计算当前阶段的实际持续时长（考虑浇水加速）
 * 每次浇水减少 10% 时长，最低 50%（waterAffinity 调节浇水效果）
 */
export function getEffectiveDurationMs(type: PlantType, stage: PlantStage, waterCount: number): number {
    const base = PLANT_CONFIGS[type].stages[stage].durationMs;
    const affinity = PLANT_CONFIGS[type].waterAffinity;
    const reduction = Math.min(0.5, waterCount * 0.1 * affinity); // 最低 0.5x
    return Math.round(base * (1 - reduction));
}
