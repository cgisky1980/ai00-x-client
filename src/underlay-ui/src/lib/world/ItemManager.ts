// ========================================================================
// 物品管理器（ItemManager）
// ========================================================================
// 职责：
// - 包装 GardenManager 的 collection 接口，提供面向 UI 的查询
// - 统计种子库存（按类型分组）
// - 提供"是否有某类种子可种"的快捷查询
// - 提供"消耗一颗种子"的事务接口（plantSeed 时调用）
// ========================================================================

import type { GardenManager } from './GardenManager';
import type { CollectionItem, PlantType } from './types';

export class ItemManager {
    private gardenManager: GardenManager;

    constructor(gardenManager: GardenManager) {
        this.gardenManager = gardenManager;
    }

    // ─── 种子库存 ────────────────────────────────────────────────

    /** 获取所有种子（按 subType 分组汇总） */
    getSeeds(): Array<{ subType: string; count: number; items: CollectionItem[] }> {
        const all = this.gardenManager.getSnapshot().collection.filter(c => c.type === 'seed');
        const grouped = new Map<string, CollectionItem[]>();
        for (const item of all) {
            const arr = grouped.get(item.subType) ?? [];
            arr.push(item);
            grouped.set(item.subType, arr);
        }
        const result: Array<{ subType: string; count: number; items: CollectionItem[] }> = [];
        for (const [subType, items] of grouped) {
            const count = items.reduce((s, i) => s + i.count, 0);
            result.push({ subType, count, items });
        }
        return result.sort((a, b) => b.count - a.count);
    }

    /** 获取指定植物类型的种子库存数 */
    getSeedCount(plantType: PlantType): number {
        const all = this.gardenManager.getSnapshot().collection.filter(
            c => c.type === 'seed' && c.subType === plantType,
        );
        return all.reduce((s, i) => s + i.count, 0);
    }

    /**
     * 消耗一颗指定类型的种子（用于种植）
     * 从库存中扣减，如果库存为 0 返回 false
     */
    async consumeSeed(plantType: PlantType): Promise<boolean> {
        const items = this.gardenManager.getSnapshot().collection.filter(
            c => c.type === 'seed' && c.subType === plantType && !c.favorited,
        );
        if (items.length === 0) return false;

        // 按获得时间排序，先消耗最早的
        items.sort((a, b) => a.obtainedAt - b.obtainedAt);
        const item = items[0];
        const remaining = await this.gardenManager.decrementCollectionItem(item.id, 1);
        return remaining >= 0;
    }

    // ─── 收集册查询 ──────────────────────────────────────────────

    /** 获取所有收集物品（按类型分组） */
    getAllCollection(): CollectionItem[] {
        return this.gardenManager.getSnapshot().collection;
    }

    /** 获取指定类型的收集物品 */
    getCollectionByType(type: CollectionItem['type']): CollectionItem[] {
        return this.gardenManager.getSnapshot().collection.filter(c => c.type === type);
    }

    /** 收藏/取消收藏 */
    async toggleFavorite(itemId: string): Promise<void> {
        await this.gardenManager.toggleFavorite(itemId);
    }
}
