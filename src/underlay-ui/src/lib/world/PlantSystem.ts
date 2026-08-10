// ========================================================================
// 植物生长系统（PlantSystem）
// ========================================================================
// 职责：
// - 每帧检查植物是否该推进到下一阶段（基于 stageEnteredAt + 浇水加速）
// - wilting 阶段结束时自动收获/掉落物品，从 GardenManager 移除植物
// - 提供 plantSeed / water / harvest 接口（被未来 UI 调用）
// - 监听 GardenManager 事件，对外广播 PlantEvent
// ========================================================================

import type { GardenManager } from './GardenManager';
import type { Plant, PlantType, PlantStage } from './types';
import { getPlantConfig, getEffectiveDurationMs, nextStage, type PlantConfig } from './data/plants';

/** PlantSystem 对外广播的事件 */
export type PlantEventListener = (
    event:
        | { type: 'plant:stage-advanced'; plantId: string; from: PlantStage; to: PlantStage }
        | { type: 'plant:withered-and-dropped'; plantId: string; droppedItems: string[] }
        | { type: 'plant:watered'; plantId: string; waterCount: number }
        | { type: 'plant:harvested'; plantId: string; fruitSubType: string }
) => void;

export class PlantSystem {
    private gardenManager: GardenManager;
    private listeners: Set<PlantEventListener> = new Set();
    private isRunning = false;
    /** 检查间隔（ms），避免每帧遍历所有植物 */
    private readonly CHECK_INTERVAL_MS = 2000;
    private lastCheckAt = 0;

    constructor(gardenManager: GardenManager) {
        this.gardenManager = gardenManager;
    }

    // ─── 生命周期 ────────────────────────────────────────────────

    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastCheckAt = Date.now();
    }

    stop(): void {
        this.isRunning = false;
    }

    /** 每帧更新（由 ticker 调用） */
    update(): void {
        if (!this.isRunning) return;
        const now = Date.now();
        if (now - this.lastCheckAt < this.CHECK_INTERVAL_MS) return;
        this.lastCheckAt = now;
        void this.checkAllPlants(now);
    }

    // ─── 核心逻辑 ────────────────────────────────────────────────

    private async checkAllPlants(now: number): Promise<void> {
        const plants = this.gardenManager.getSnapshot().plants;
        for (const plant of plants) {
            if (plant.harvested) continue;
            await this.checkSinglePlant(plant, now);
        }
    }

    private async checkSinglePlant(plant: Plant, now: number): Promise<void> {
        const config = getPlantConfig(plant.type);
        const elapsed = now - plant.stageEnteredAt;
        const duration = getEffectiveDurationMs(plant.type, plant.stage, plant.waterCount);

        if (elapsed < duration) return;

        const next = nextStage(plant.stage);
        if (!next) {
            // 已经是 wilting 阶段且时长已到 → 枯萎消失，掉落物品
            await this.handleWither(plant, config);
            return;
        }

        // 推进到下一阶段
        const from = plant.stage;
        await this.gardenManager.changePlantStage(plant.id, next);
        this.emit({ type: 'plant:stage-advanced', plantId: plant.id, from, to: next });

        // 特殊：进入 blooming 时化身可能去欣赏（未来由 AvatarBehaviorController 监听）
        // 特殊：进入 fruiting 时可被收获
    }

    private async handleWither(plant: Plant, config: PlantConfig): Promise<void> {
        const droppedItems: string[] = [];

        // 掉落种子（概率）
        if (Math.random() < config.dropSeedChance) {
            await this.gardenManager.addCollectionItem(
                'seed', config.seedSubType, 'withered',
                `枯萎的${config.name}`, 1,
            );
            droppedItems.push(`seed:${config.seedSubType}`);
        }
        // 掉落果实（概率）
        if (Math.random() < config.dropFruitChance) {
            await this.gardenManager.addCollectionItem(
                'fruit', config.fruitSubType, 'withered',
                `枯萎的${config.name}`, 1,
            );
            droppedItems.push(`fruit:${config.fruitSubType}`);
        }

        // 从 GardenManager 移除植物（连同花盆 plantId 清空）
        await this.gardenManager.harvestPlant(plant.id);
        this.emit({ type: 'plant:withered-and-dropped', plantId: plant.id, droppedItems });
    }

    // ─── 外部接口（被 UI 调用） ──────────────────────────────────

    async plantSeed(
        type: PlantType,
        potId: string,
        source: Plant['source'] = 'self',
        sourceVisitorName?: string,
    ): Promise<Plant> {
        return this.gardenManager.plantSeed(type, potId, source, sourceVisitorName);
    }

    async water(plantId: string): Promise<void> {
        await this.gardenManager.waterPlant(plantId);
        const plant = this.gardenManager.getSnapshot().plants.find(p => p.id === plantId);
        this.emit({ type: 'plant:watered', plantId, waterCount: plant?.waterCount ?? 0 });
    }

    async harvest(plantId: string): Promise<void> {
        const plant = this.gardenManager.getSnapshot().plants.find(p => p.id === plantId);
        if (!plant) return;
        const config = getPlantConfig(plant.type);

        // 只有 blooming / fruiting 阶段可收获
        if (plant.stage !== 'blooming' && plant.stage !== 'fruiting') {
            return;
        }

        // 加入收集册
        await this.gardenManager.addCollectionItem(
            'fruit', config.fruitSubType, 'harvest',
            `收获的${config.name}`, 1,
        );
        // 额外掉落一颗种子（鼓励再种植）
        await this.gardenManager.addCollectionItem(
            'seed', config.seedSubType, 'harvest',
            `收获的${config.name}`, 1,
        );

        // 从花园移除
        await this.gardenManager.harvestPlant(plantId);
        this.emit({ type: 'plant:harvested', plantId, fruitSubType: config.fruitSubType });
    }

    // ─── 查询 ────────────────────────────────────────────────────

    /** 获取指定花盆中的植物 */
    getPlantInPot(potId: string): Plant | undefined {
        return this.gardenManager.getSnapshot().plants.find(p => p.potId === potId);
    }

    /** 获取所有可浇水的植物（非 wilting / 非已收获） */
    getWaterablePlants(): Plant[] {
        return this.gardenManager.getSnapshot().plants.filter(
            p => !p.harvested && p.stage !== 'wilting',
        );
    }

    /** 获取所有可收获的植物（blooming / fruiting 阶段） */
    getHarvestablePlants(): Plant[] {
        return this.gardenManager.getSnapshot().plants.filter(
            p => !p.harvested && (p.stage === 'blooming' || p.stage === 'fruiting'),
        );
    }

    // ─── 事件总线 ────────────────────────────────────────────────

    on(listener: PlantEventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: Parameters<PlantEventListener>[0]): void {
        for (const l of this.listeners) {
            try { l(event); } catch (e) { console.error('[PlantSystem] listener error:', e); }
        }
    }
}
