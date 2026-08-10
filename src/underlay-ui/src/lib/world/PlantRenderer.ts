// ========================================================================
// 植物渲染器（PlantRenderer）
// ========================================================================
// 职责：
// - 监听 GardenManager 事件，自动创建/更新/销毁植物 Sprite
// - MVP 用 PIXI.Text 渲染 emoji（按阶段不同 emoji）
// - 植物挂在花盆上方（yOffset 由 plants.ts 配置）
// - 浇水时显示 💧 动画（短暂显示后消失）
// - 阶段切换时播放 ✨ 闪光动画
// ========================================================================

import * as PIXI from 'pixi.js';
import type { GardenManager } from './GardenManager';
import type { Plant, PlantStage, GardenEventListener } from './types';
import { getStageConfig } from './data/plants';

/** 单株植物的渲染节点 */
interface PlantNode {
    plantId: string;
    /** 所属花盆 ID（用于跟随花盆位置） */
    potId: string;
    container: PIXI.Container;
    text: PIXI.Text;
    /** 当前阶段（用于检测变化） */
    currentStage: PlantStage;
    /** 浇水动画节点 */
    waterEffect: PIXI.Text | null;
    /** 阶段切换闪光动画节点 */
    sparkleEffect: PIXI.Text | null;
}

export class PlantRenderer {
    private app: PIXI.Application;
    private gardenManager: GardenManager;
    private layer: PIXI.Container;
    private nodes: Map<string, PlantNode> = new Map();
    private unsubscribe: (() => void) | null = null;
    private isInitialized = false;

    constructor(app: PIXI.Application, gardenManager: GardenManager, parentLayer?: PIXI.Container) {
        this.app = app;
        this.gardenManager = gardenManager;
        // 植物层级：花盆(5) < 植物(8) < 草地前景(20)
        this.layer = parentLayer ?? new PIXI.Container();
        this.layer.zIndex = 8;
        if (!parentLayer) {
            this.app.stage.addChild(this.layer);
        }
    }

    // ─── 生命周期 ────────────────────────────────────────────────

    start(): void {
        if (this.isInitialized) return;
        this.isInitialized = true;

        // 渲染当前所有已存在的植物
        const plants = this.gardenManager.getSnapshot().plants;
        for (const plant of plants) {
            this.createNode(plant);
        }

        // 订阅 GardenManager 事件
        const listener: GardenEventListener = (event) => {
            if (event.type === 'plant:planted') {
                this.createNode(event.plant);
            } else if (event.type === 'plant:stage-changed') {
                this.updateStage(event.plantId, event.newStage);
            } else if (event.type === 'plant:harvested') {
                this.removeNode(event.plantId);
            }
        };
        this.unsubscribe = this.gardenManager.on(listener);
    }

    stop(): void {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        for (const [, node] of this.nodes) {
            this.destroyNode(node);
        }
        this.nodes.clear();
        this.isInitialized = false;
    }

    // ─── 节点管理 ────────────────────────────────────────────────

    private createNode(plant: Plant): void {
        if (this.nodes.has(plant.id)) return;

        // 找到花盆以确定位置
        const pot = this.gardenManager.getSnapshot().pots.find(p => p.id === plant.potId);
        if (!pot) {
            console.warn(`[PlantRenderer] pot ${plant.potId} not found for plant ${plant.id}`);
            return;
        }

        const stageConfig = getStageConfig(plant.type, plant.stage);
        const container = new PIXI.Container();
        container.x = pot.x;
        container.y = pot.y;

        const text = new PIXI.Text({
            text: stageConfig.emoji,
            style: {
                fontFamily: 'Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif',
                fontSize: 48 * stageConfig.scale,
                fill: 0xffffff,
                align: 'center',
            },
        });
        text.anchor.set(0.5, 1); // 底部居中（植物从花盆顶部向上生长）
        text.y = stageConfig.yOffset;
        container.addChild(text);

        this.layer.addChild(container);

        this.nodes.set(plant.id, {
            plantId: plant.id,
            potId: plant.potId,
            container,
            text,
            currentStage: plant.stage,
            waterEffect: null,
            sparkleEffect: null,
        });
    }

    private updateStage(plantId: string, newStage: PlantStage): void {
        const node = this.nodes.get(plantId);
        if (!node) {
            // 可能是未渲染的植物（如刚 plant:planted 但 createNode 失败），尝试创建
            const plant = this.gardenManager.getSnapshot().plants.find(p => p.id === plantId);
            if (plant) this.createNode(plant);
            return;
        }

        const oldStage = node.currentStage;
        if (oldStage === newStage) return;
        node.currentStage = newStage;

        // 更新 emoji 与缩放
        const stageConfig = getStageConfig(
            this.getPlantType(plantId),
            newStage,
        );
        node.text.text = stageConfig.emoji;
        node.text.style.fontSize = 48 * stageConfig.scale;
        node.text.y = stageConfig.yOffset;

        // 播放阶段切换闪光
        this.playSparkle(node);
    }

    private removeNode(plantId: string): void {
        const node = this.nodes.get(plantId);
        if (!node) return;
        // 播放消失动画（短暂缩小后销毁）
        this.playWither(node);
    }

    private destroyNode(node: PlantNode): void {
        if (node.waterEffect) {
            node.container.removeChild(node.waterEffect);
            node.waterEffect.destroy();
        }
        if (node.sparkleEffect) {
            node.container.removeChild(node.sparkleEffect);
            node.sparkleEffect.destroy();
        }
        this.layer.removeChild(node.container);
        node.text.destroy();
        node.container.destroy();
    }

    // ─── 工具 ────────────────────────────────────────────────────

    private getPlantType(plantId: string): Plant['type'] {
        const plant = this.gardenManager.getSnapshot().plants.find(p => p.id === plantId);
        return plant?.type ?? 'sunflower';
    }

    /** 浇水动画：在植物上方显示 💧，1.5s 后消失 */
    showWaterEffect(plantId: string): void {
        const node = this.nodes.get(plantId);
        if (!node) return;
        if (node.waterEffect) {
            node.container.removeChild(node.waterEffect);
            node.waterEffect.destroy();
        }
        const water = new PIXI.Text({
            text: '💧',
            style: {
                fontFamily: 'Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif',
                fontSize: 24,
                fill: 0xffffff,
                align: 'center',
            },
        });
        water.anchor.set(0.5, 1);
        water.y = node.text.y - 20;
        water.alpha = 0.9;
        node.container.addChild(water);
        node.waterEffect = water;

        // 1.5s 后消失
        setTimeout(() => {
            if (node.waterEffect === water) {
                node.container.removeChild(water);
                water.destroy();
                node.waterEffect = null;
            }
        }, 1500);
    }

    /** 阶段切换闪光：✨ 闪烁 0.8s 后消失 */
    private playSparkle(node: PlantNode): void {
        if (node.sparkleEffect) {
            node.container.removeChild(node.sparkleEffect);
            node.sparkleEffect.destroy();
        }
        const sparkle = new PIXI.Text({
            text: '✨',
            style: {
                fontFamily: 'Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif',
                fontSize: 28,
                fill: 0xffffff,
                align: 'center',
            },
        });
        sparkle.anchor.set(0.5, 1);
        sparkle.y = node.text.y - 10;
        sparkle.x = 20;
        node.container.addChild(sparkle);
        node.sparkleEffect = sparkle;

        setTimeout(() => {
            if (node.sparkleEffect === sparkle) {
                node.container.removeChild(sparkle);
                sparkle.destroy();
                node.sparkleEffect = null;
            }
        }, 800);
    }

    /** 枯萎消失动画：缩小 + 淡出，0.6s 后销毁 */
    private playWither(node: PlantNode): void {
        const startTime = performance.now();
        const duration = 600;
        const initialScale = node.container.scale.x;
        const tick = () => {
            const elapsed = performance.now() - startTime;
            const t = Math.min(1, elapsed / duration);
            node.container.scale.set(initialScale * (1 - t * 0.5));
            node.container.alpha = 1 - t;
            if (t < 1) {
                requestAnimationFrame(tick);
            } else {
                this.destroyNode(node);
                this.nodes.delete(node.plantId);
            }
        };
        requestAnimationFrame(tick);
    }

    // ─── 每帧更新（如有动画需求） ────────────────────────────────

    update(): void {
        // 每帧同步植物位置到花盆位置（花盆拖动/下落时植物跟随）
        const pots = this.gardenManager.getSnapshot().pots;
        const potMap = new Map(pots.map(p => [p.id, p]));
        for (const [, node] of this.nodes) {
            const pot = potMap.get(node.potId);
            if (!pot) continue;
            node.container.x = pot.x;
            node.container.y = pot.y;
        }
    }

    // ─── 调试 ────────────────────────────────────────────────────

    /** 获取所有渲染节点数 */
    getNodeCount(): number {
        return this.nodes.size;
    }
}
