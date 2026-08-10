import { openIndexedDB, dbPut } from "./indexedDB"
const DB_NAME = "ai00-icons"
const STORE = "icons"

function openDB(): Promise<IDBDatabase> {
  return openIndexedDB(DB_NAME, 2, (db) => {
    if (db.objectStoreNames.contains(STORE)) {
      db.deleteObjectStore(STORE)
    }
    db.createObjectStore(STORE)
  })
}

export async function getIcons(names: string[]): Promise<Record<string, string>> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly")
    const store = tx.objectStore(STORE)
    const out: Record<string, string> = {}
    let remaining = names.length
    if (remaining === 0) resolve(out)
    names.forEach((n) => {
      const r = store.get(n)
      r.onsuccess = () => {
        const v = r.result as string | undefined
        if (v) out[n] = v
        else {
          try {
            const delTx = db.transaction(STORE, "readwrite")
            delTx.objectStore(STORE).delete(n)
          } catch { }
        }
        remaining--
        if (remaining === 0) resolve(out)
      }
      r.onerror = () => {
        try {
          const delTx = db.transaction(STORE, "readwrite")
          delTx.objectStore(STORE).delete(n)
        } catch { }
        remaining--
        if (remaining === 0) resolve(out)
      }
    })
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error as any)
  })
}

export async function setIcons(entries: { name: string; icon_base64: string }[]): Promise<void> {
  if (entries.length === 0) return
  // dbPut 完成后会关闭连接，故每个条目独立打开
  for (const e of entries) {
    const db = await openDB()
    await dbPut(db, STORE, e.icon_base64, e.name)
  }
}