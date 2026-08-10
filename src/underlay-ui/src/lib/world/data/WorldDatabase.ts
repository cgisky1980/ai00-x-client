// ========================================================================
// 花园世界本地数据库（IndexedDB 封装）
// ========================================================================
// 设计原则：
// - 100% 本地存储，无服务器同步
// - 6 个 object store：avatar / plants / pots / collection / traces / outings
// - 不存"当前访客列表"——访客离开即丢弃，仅在 collection/traces 留下纪念
// - 长连接策略：单例 db 连接保持开启，避免每次 tx 都重连
// ========================================================================

import type {
    AvatarPersistentState,
    Plant,
    Pot,
    CollectionItem,
    Trace,
    OutingRecord,
} from '../types';

const DB_NAME = 'ai00-garden';
const DB_VERSION = 1;

const STORE_AVATAR = 'avatar';        // keyPath: 'id' (单例 'singleton')
const STORE_PLANTS = 'plants';        // keyPath: 'id'
const STORE_POTS = 'pots';            // keyPath: 'id'
const STORE_COLLECTION = 'collection';// keyPath: 'id'
const STORE_TRACES = 'traces';        // keyPath: 'id'
const STORE_OUTINGS = 'outings';      // keyPath: 'id'

let _dbPromise: Promise<IDBDatabase> | null = null;

/** 打开数据库（单例长连接，失败或被关闭时自动重连） */
function openDB(): Promise<IDBDatabase> {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_AVATAR)) {
                db.createObjectStore(STORE_AVATAR, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_PLANTS)) {
                const s = db.createObjectStore(STORE_PLANTS, { keyPath: 'id' });
                s.createIndex('potId', 'potId', { unique: false });
                s.createIndex('stage', 'stage', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_POTS)) {
                db.createObjectStore(STORE_POTS, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_COLLECTION)) {
                const s = db.createObjectStore(STORE_COLLECTION, { keyPath: 'id' });
                s.createIndex('type', 'type', { unique: false });
                s.createIndex('subType', 'subType', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_TRACES)) {
                const s = db.createObjectStore(STORE_TRACES, { keyPath: 'id' });
                s.createIndex('expiresAt', 'expiresAt', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_OUTINGS)) {
                const s = db.createObjectStore(STORE_OUTINGS, { keyPath: 'id' });
                s.createIndex('returnedAt', 'returnedAt', { unique: false });
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // 监听连接意外关闭（如版本变更、内存压力），清除缓存以便下次重连
            db.onclose = () => { _dbPromise = null; };
            db.onversionchange = () => {
                db.close();
                _dbPromise = null;
            };
            resolve(db);
        };
        req.onerror = () => {
            // 失败时清除缓存，避免后续永远拿到 rejected promise
            _dbPromise = null;
            reject(req.error);
        };
    });
    return _dbPromise;
}

// ─── 通用工具 ────────────────────────────────────────────────────
// 注意：不在 tx.oncomplete 中调用 db.close()，保持长连接复用

async function txGetAll<T>(store: string): Promise<T[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
    });
}

async function txGetByKey<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
    });
}

async function txPut<T>(store: string, value: T): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value as unknown as Record<string, unknown>);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function txDelete(store: string, key: IDBValidKey): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function txClear(store: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ─── 生成 id ──────────────────────────────────────────────────────
function genId(prefix: string): string {
    // 简单 uuid 替代（无依赖）
    const rnd = Math.random().toString(36).slice(2, 10);
    const time = Date.now().toString(36);
    return `${prefix}_${time}${rnd}`;
}

// ========================================================================
// 公共 API
// ========================================================================
export class WorldDatabase {
    // ─── Avatar 单例状态 ──────────────────────────────────────────
    async getAvatarState(): Promise<AvatarPersistentState | undefined> {
        return txGetByKey<AvatarPersistentState>(STORE_AVATAR, 'singleton');
    }

    async saveAvatarState(state: AvatarPersistentState): Promise<void> {
        await txPut(STORE_AVATAR, { ...state, id: 'singleton' });
    }

    // ─── Plants ───────────────────────────────────────────────────
    async getAllPlants(): Promise<Plant[]> {
        return txGetAll<Plant>(STORE_PLANTS);
    }

    async getPlant(id: string): Promise<Plant | undefined> {
        return txGetByKey<Plant>(STORE_PLANTS, id);
    }

    async savePlant(plant: Plant): Promise<void> {
        await txPut(STORE_PLANTS, plant);
    }

    async deletePlant(id: string): Promise<void> {
        await txDelete(STORE_PLANTS, id);
    }

    // ─── Pots ─────────────────────────────────────────────────────
    async getAllPots(): Promise<Pot[]> {
        return txGetAll<Pot>(STORE_POTS);
    }

    async savePot(pot: Pot): Promise<void> {
        await txPut(STORE_POTS, pot);
    }

    async deletePot(id: string): Promise<void> {
        await txDelete(STORE_POTS, id);
    }

    // ─── Collection ───────────────────────────────────────────────
    async getAllCollection(): Promise<CollectionItem[]> {
        return txGetAll<CollectionItem>(STORE_COLLECTION);
    }

    async saveCollectionItem(item: CollectionItem): Promise<void> {
        await txPut(STORE_COLLECTION, item);
    }

    async deleteCollectionItem(id: string): Promise<void> {
        await txDelete(STORE_COLLECTION, id);
    }

    // ─── Traces ───────────────────────────────────────────────────
    async getAllTraces(): Promise<Trace[]> {
        return txGetAll<Trace>(STORE_TRACES);
    }

    async saveTrace(trace: Trace): Promise<void> {
        await txPut(STORE_TRACES, trace);
    }

    async deleteTrace(id: string): Promise<void> {
        await txDelete(STORE_TRACES, id);
    }

    /** 清理已过期痕迹（按 expiresAt 索引扫描） */
    async purgeExpiredTraces(now: number): Promise<string[]> {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_TRACES, 'readwrite');
            const store = tx.objectStore(STORE_TRACES);
            const idx = store.index('expiresAt');
            const range = IDBKeyRange.upperBound(now);
            const expiredIds: string[] = [];
            const cursorReq = idx.openCursor(range);
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (cursor) {
                    const trace = cursor.value as Trace;
                    expiredIds.push(trace.id);
                    cursor.delete();
                    cursor.continue();
                }
            };
            cursorReq.onerror = () => reject(cursorReq.error);
            tx.oncomplete = () => resolve(expiredIds);
            tx.onerror = () => reject(tx.error);
        });
    }

    // ─── Outings ──────────────────────────────────────────────────
    async getAllOutings(): Promise<OutingRecord[]> {
        return txGetAll<OutingRecord>(STORE_OUTINGS);
    }

    async getOngoingOutings(): Promise<OutingRecord[]> {
        const all = await txGetAll<OutingRecord>(STORE_OUTINGS);
        return all.filter(o => o.returnedAt === null);
    }

    async saveOuting(outing: OutingRecord): Promise<void> {
        await txPut(STORE_OUTINGS, outing);
    }

    async deleteOuting(id: string): Promise<void> {
        await txDelete(STORE_OUTINGS, id);
    }

    // ─── 全局清理（debug 用） ────────────────────────────────────
    async clearAll(): Promise<void> {
        await Promise.all([
            txClear(STORE_AVATAR),
            txClear(STORE_PLANTS),
            txClear(STORE_POTS),
            txClear(STORE_COLLECTION),
            txClear(STORE_TRACES),
            txClear(STORE_OUTINGS),
        ]);
    }
}

// ─── 单例 ─────────────────────────────────────────────────────────
let _instance: WorldDatabase | null = null;

export function getWorldDatabase(): WorldDatabase {
    if (!_instance) _instance = new WorldDatabase();
    return _instance;
}

export { genId };
