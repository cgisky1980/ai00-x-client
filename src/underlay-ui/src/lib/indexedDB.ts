/**
 * 通用 IndexedDB 封装（underlay-ui 包内复用）
 *
 * 统一 idb.ts / griddb.ts 中重复的 openDB + 事务 Promise 样板。
 * 仅做机械封装，不改变各调用方原有的读写行为。
 */

/** 打开（或创建）一个 IndexedDB，upgrade 用于建表迁移 */
export function openIndexedDB(
  dbName: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, version);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 只读事务：按 key 读取单个值 */
export function dbGet<T>(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

/** 只读事务：读取 store 内全部值 */
export function dbGetAll<T>(
  db: IDBDatabase,
  store: string,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => resolve((r.result as T[]) || []);
    r.onerror = () => reject(r.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

/** 写事务：写入（或更新）一个值 */
export function dbPut(
  db: IDBDatabase,
  store: string,
  value: unknown,
  key?: IDBValidKey,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

/** 写事务：按 key 删除一个值 */
export function dbDelete(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

/** 写事务：清空 store 内全部值 */
export function dbClear(db: IDBDatabase, store: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}