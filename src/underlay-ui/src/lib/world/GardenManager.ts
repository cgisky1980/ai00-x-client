// ========================================================================
// 花园世界协调器（GardenManager）
// ========================================================================
// 角色：
// - 持有 WorldSnapshot（内存）+ WorldDatabase（持久化）
// - 作为子系统的协调入口（PlantSystem / VisitorManager / TraceManager / ItemManager 后续步骤接入）
// - 提供事件总线（on/emit），UI 通过订阅 GardenEvent 反应
// - 提供 init()/update()/destroy() 生命周期，由 MicroGardenLayer 调用
//
// 注意：
// - 本文件只做"协调与持久化"，不直接渲染（渲染由后续步骤的 PlantSystem/VisitorManager 负责）
// - 不依赖 PIXI/Matter（纯数据层 + 时间推进），便于测试
// ========================================================================

import type {
    AvatarPersistentState,
    AvatarActivity,
    AvatarMood,
    Plant,
    Pot,
    CollectionItem,
    Trace,
    OutingRecord,
    WorldSnapshot,
    GardenEvent,
    GardenEventListener,
} from './types';
import { getWorldDatabase, genId, type WorldDatabase } from './data/WorldDatabase';

/** 默认化身状态（首次初始化） */
function defaultAvatarState(): AvatarPersistentState {
    return {
        id: 'singleton',
        activity: 'idle',
        mood: 'neutral',
        x: typeof window !== 'undefined' ? window.innerWidth / 2 : 800,
        y: typeof window !== 'undefined' ? window.innerHeight - 100 : 600,
        facing: 1,
        lastOutingAt: 0,
        updatedAt: Date.now(),
    };
}

export class GardenManager {
    private db: WorldDatabase;
    private snapshot: WorldSnapshot;
    private listeners: Set<GardenEventListener> = new Set();
    private isInitialized = false;
    private lastPurgeAt = 0;
    /** 痕迹清理间隔（5 分钟） */
    private readonly PURGE_INTERVAL_MS = 5 * 60 * 1000;

    constructor(db?: WorldDatabase) {
        this.db = db ?? getWorldDatabase();
        this.snapshot = {
            avatar: defaultAvatarState(),
            plants: [],
            pots: [],
            collection: [],
            traces: [],
            activeVisitors: [],
            ongoingOutings: [],
        };
    }

    // ─── 生命周期 ────────────────────────────────────────────────

    async init(): Promise<void> {
        if (this.isInitialized) return;
        this.isInitialized = true;

        // 从 IndexedDB 恢复全部数据（每个 store 独立 try/catch，单个失败不阻断）
        const safe = async <T>(p: Promise<T>, fallback: T, label: string): Promise<T> => {
            try { return await p; }
            catch (e) {
                console.warn(`[GardenManager] init: load ${label} failed, use fallback:`, e);
                return fallback;
            }
        };

        const [avatar, plants, pots, collection, traces, outings] = await Promise.all([
            safe(this.db.getAvatarState(), undefined, 'avatar'),
            safe(this.db.getAllPlants(), [], 'plants'),
            safe(this.db.getAllPots(), [], 'pots'),
            safe(this.db.getAllCollection(), [], 'collection'),
            safe(this.db.getAllTraces(), [], 'traces'),
            safe(this.db.getAllOutings(), [], 'outings'),
        ]);

        this.snapshot.avatar = avatar ?? defaultAvatarState();
        this.snapshot.plants = plants;
        this.snapshot.pots = pots;
        this.snapshot.collection = collection;
        this.snapshot.traces = traces;
        this.snapshot.ongoingOutings = outings.filter(o => o.returnedAt === null);

        // 立即清理一次过期痕迹（失败不阻断）
        try { await this.purgeExpiredTraces(Date.now()); }
        catch (e) { console.warn('[GardenManager] init: purgeExpiredTraces failed:', e); }
    }

    /** 每帧更新（由 ticker 调用，dt 单位毫秒） */
    update(dtMs: number): void {
        if (!this.isInitialized) return;
        const now = Date.now();

        // 定期清理过期痕迹
        if (now - this.lastPurgeAt > this.PURGE_INTERVAL_MS) {
            this.lastPurgeAt = now;
            void this.purgeExpiredTraces(now);
        }

        // 植物生长推进、访客离场、外出返回等时间驱动逻辑
        // 这些会由后续步骤的子系统负责，此处仅保留接口位
        void dtMs;
    }

    destroy(): void {
        this.listeners.clear();
        this.isInitialized = false;
    }

    // ─── 事件总线 ────────────────────────────────────────────────

    on(listener: GardenEventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: GardenEvent): void {
        for (const l of this.listeners) {
            try { l(event); } catch (e) { console.error('[GardenManager] listener error:', e); }
        }
    }

    // ─── 快照访问 ────────────────────────────────────────────────

    getSnapshot(): WorldSnapshot {
        return this.snapshot;
    }

    // ─── Avatar 状态 ─────────────────────────────────────────────

    async setAvatarActivity(activity: AvatarActivity, mood?: AvatarMood): Promise<void> {
        const prev = this.snapshot.avatar;
        this.snapshot.avatar = {
            ...prev,
            activity,
            mood: mood ?? prev.mood,
            updatedAt: Date.now(),
        };
        await this.db.saveAvatarState(this.snapshot.avatar);
        this.emit({ type: 'avatar:activity-changed', activity, mood: this.snapshot.avatar.mood });
    }

    /**
     * 更新化身位置（高频调用，内部节流写库）
     * - 内存快照每次都更新（保证 getSnapshot() 拿到最新位置）
     * - IndexedDB 写入节流：每 2 秒最多一次
     */
    async updateAvatarPosition(x: number, y: number, facing?: 1 | -1): Promise<void> {
        this.snapshot.avatar = {
            ...this.snapshot.avatar,
            x, y,
            facing: facing ?? this.snapshot.avatar.facing,
            updatedAt: Date.now(),
        };
        // 节流写库：距上次持久化 > 2s 才写入
        const now = Date.now();
        if (now - this._lastAvatarFlushAt > 2000) {
            this._lastAvatarFlushAt = now;
            // 不 await，避免阻塞 ticker
            void this.db.saveAvatarState(this.snapshot.avatar).catch(e => {
                console.warn('[GardenManager] saveAvatarState failed:', e);
            });
        }
        // 位置变化不广播（高频，避免性能问题）
    }
    private _lastAvatarFlushAt = 0;

    // ─── Plants ──────────────────────────────────────────────────

    async plantSeed(
        type: Plant['type'],
        potId: string,
        source: Plant['source'] = 'self',
        sourceVisitorName?: string,
    ): Promise<Plant> {
        const now = Date.now();
        const plant: Plant = {
            id: genId('plant'),
            type,
            stage: 'seed',
            potId,
            plantedAt: now,
            stageEnteredAt: now,
            lastWateredAt: 0,
            waterCount: 0,
            harvested: false,
            source,
            sourceVisitorName,
        };
        this.snapshot.plants.push(plant);

        // 同步更新花盆 plantId
        const pot = this.snapshot.pots.find(p => p.id === potId);
        if (pot) {
            pot.plantId = plant.id;
            await this.db.savePot(pot);
        }

        await this.db.savePlant(plant);
        this.emit({ type: 'plant:planted', plant });
        return plant;
    }

    async waterPlant(plantId: string): Promise<void> {
        const plant = this.snapshot.plants.find(p => p.id === plantId);
        if (!plant || plant.harvested) return;
        plant.lastWateredAt = Date.now();
        plant.waterCount += 1;
        await this.db.savePlant(plant);
    }

    async changePlantStage(plantId: string, newStage: Plant['stage']): Promise<void> {
        const plant = this.snapshot.plants.find(p => p.id === plantId);
        if (!plant || plant.stage === newStage) return;
        plant.stage = newStage;
        plant.stageEnteredAt = Date.now();
        await this.db.savePlant(plant);
        this.emit({ type: 'plant:stage-changed', plantId, newStage });
    }

    async harvestPlant(plantId: string): Promise<Plant | null> {
        const plant = this.snapshot.plants.find(p => p.id === plantId);
        if (!plant || plant.harvested) return null;
        plant.harvested = true;
        await this.db.savePlant(plant);
        // 收获后从快照与花盆移除
        const pot = this.snapshot.pots.find(p => p.id === plant.potId);
        if (pot) {
            pot.plantId = null;
            await this.db.savePot(pot);
        }
        this.snapshot.plants = this.snapshot.plants.filter(p => p.id !== plantId);
        await this.db.deletePlant(plantId);
        this.emit({ type: 'plant:harvested', plantId });
        return plant;
    }

    // ─── Pots ────────────────────────────────────────────────────

    async addPot(x: number, y: number, style: Pot['style'] = 'clay'): Promise<Pot> {
        const pot: Pot = {
            id: genId('pot'),
            x, y,
            style,
            plantId: null,
            createdAt: Date.now(),
        };
        this.snapshot.pots.push(pot);
        await this.db.savePot(pot);
        return pot;
    }

    /** 更新花盆数据（坐标等） */
    async updatePot(pot: Pot): Promise<void> {
        const idx = this.snapshot.pots.findIndex(p => p.id === pot.id);
        if (idx >= 0) {
            this.snapshot.pots[idx] = pot;
        }
        await this.db.savePot(pot);
    }

    async removePot(id: string): Promise<void> {
        const pot = this.snapshot.pots.find(p => p.id === id);
        if (pot?.plantId) {
            // 花盆里有植物，连带删除
            await this.db.deletePlant(pot.plantId);
            this.snapshot.plants = this.snapshot.plants.filter(p => p.id !== pot.plantId);
        }
        this.snapshot.pots = this.snapshot.pots.filter(p => p.id !== id);
        await this.db.deletePot(id);
    }

    // ─── Collection ──────────────────────────────────────────────

    async addCollectionItem(
        type: CollectionItem['type'],
        subType: string,
        source: CollectionItem['source'],
        sourceDetail?: string,
        count = 1,
    ): Promise<CollectionItem> {
        // 可堆叠物品（seed/fruit）：若已有同 subType，则增加 count
        if ((type === 'seed' || type === 'fruit')) {
            const existing = this.snapshot.collection.find(
                c => c.type === type && c.subType === subType && !c.favorited
            );
            if (existing) {
                existing.count += count;
                await this.db.saveCollectionItem(existing);
                this.emit({ type: 'collection:added', item: existing });
                return existing;
            }
        }
        const item: CollectionItem = {
            id: genId('item'),
            type, subType, source,
            sourceDetail,
            count,
            obtainedAt: Date.now(),
            favorited: false,
        };
        this.snapshot.collection.push(item);
        await this.db.saveCollectionItem(item);
        this.emit({ type: 'collection:added', item });
        return item;
    }

    async toggleFavorite(itemId: string): Promise<void> {
        const item = this.snapshot.collection.find(c => c.id === itemId);
        if (!item) return;
        item.favorited = !item.favorited;
        await this.db.saveCollectionItem(item);
    }

    /**
     * 减少可堆叠物品的数量（用于消耗种子/果实）
     * @returns 减少后的剩余数量（-1 表示物品不存在）
     */
    async decrementCollectionItem(itemId: string, count = 1): Promise<number> {
        const item = this.snapshot.collection.find(c => c.id === itemId);
        if (!item) return -1;
        item.count = Math.max(0, item.count - count);
        if (item.count <= 0) {
            // 数量归零，删除物品
            this.snapshot.collection = this.snapshot.collection.filter(c => c.id !== itemId);
            await this.db.deleteCollectionItem(itemId);
            return 0;
        }
        await this.db.saveCollectionItem(item);
        return item.count;
    }

    /** 直接删除收集物品 */
    async removeCollectionItem(itemId: string): Promise<void> {
        const exists = this.snapshot.collection.some(c => c.id === itemId);
        if (!exists) return;
        this.snapshot.collection = this.snapshot.collection.filter(c => c.id !== itemId);
        await this.db.deleteCollectionItem(itemId);
    }

    // ─── Traces ──────────────────────────────────────────────────

    async addTrace(
        type: Trace['type'],
        x: number,
        y: number,
        source: Trace['source'],
        ttlMs: number,
        sourceDetail?: string,
        subType?: string,
    ): Promise<Trace> {
        const now = Date.now();
        const trace: Trace = {
            id: genId('trace'),
            type, x, y,
            createdAt: now,
            expiresAt: now + ttlMs,
            source,
            sourceDetail,
            subType,
        };
        this.snapshot.traces.push(trace);
        await this.db.saveTrace(trace);
        this.emit({ type: 'trace:added', trace });
        return trace;
    }

    private async purgeExpiredTraces(now: number): Promise<void> {
        const expiredIds = await this.db.purgeExpiredTraces(now);
        if (expiredIds.length > 0) {
            const set = new Set(expiredIds);
            this.snapshot.traces = this.snapshot.traces.filter(t => !set.has(t.id));
            for (const id of expiredIds) {
                this.emit({ type: 'trace:expired', traceId: id });
            }
        }
    }

    // ─── Outings ─────────────────────────────────────────────────

    async startOuting(destination: string): Promise<OutingRecord> {
        const outing: OutingRecord = {
            id: genId('outing'),
            startedAt: Date.now(),
            returnedAt: null,
            destination,
        };
        this.snapshot.ongoingOutings.push(outing);
        await this.db.saveOuting(outing);
        this.snapshot.avatar = {
            ...this.snapshot.avatar,
            activity: 'visiting',
            lastOutingAt: Date.now(),
            updatedAt: Date.now(),
        };
        await this.db.saveAvatarState(this.snapshot.avatar);
        this.emit({ type: 'outing:started', destination });
        return outing;
    }

    async finishOuting(
        outingId: string,
        broughtItem: OutingRecord['broughtItem'],
        diaryText: string,
    ): Promise<OutingRecord | null> {
        const outing = this.snapshot.ongoingOutings.find(o => o.id === outingId);
        if (!outing) return null;
        outing.returnedAt = Date.now();
        outing.broughtItem = broughtItem;
        outing.diaryText = diaryText;
        await this.db.saveOuting(outing);
        this.snapshot.ongoingOutings = this.snapshot.ongoingOutings.filter(o => o.id !== outingId);
        this.emit({ type: 'outing:returned', record: outing });
        return outing;
    }

    // ─── Active Visitors（不持久化，仅内存） ───────────────────────
    // 注：访客由后续步骤的 VisitorManager 直接操作 snapshot.activeVisitors
    //      并通过 emit 广播事件，这里仅提供最小接口

    addActiveVisitor(visitor: import('./types').ActiveVisitor): void {
        this.snapshot.activeVisitors.push(visitor);
        this.emit({ type: 'visitor:arrived', visitor });
    }

    removeActiveVisitor(instanceId: string): void {
        this.snapshot.activeVisitors = this.snapshot.activeVisitors.filter(
            v => v.instanceId !== instanceId
        );
        this.emit({ type: 'visitor:left', instanceId });
    }

    // ─── 调试 ────────────────────────────────────────────────────

    async clearAll(): Promise<void> {
        await this.db.clearAll();
        this.snapshot = {
            avatar: defaultAvatarState(),
            plants: [],
            pots: [],
            collection: [],
            traces: [],
            activeVisitors: [],
            ongoingOutings: [],
        };
    }
}

// ─── 单例 ─────────────────────────────────────────────────────────
let _instance: GardenManager | null = null;

export function getGardenManager(): GardenManager {
    if (!_instance) _instance = new GardenManager();
    return _instance;
}
