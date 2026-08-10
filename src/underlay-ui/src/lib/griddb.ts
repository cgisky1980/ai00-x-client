import type { GridItem, Category } from "@underlay/desktop/types"
import { openIndexedDB, dbGet, dbGetAll, dbPut, dbDelete } from "./indexedDB"
const DB_NAME = "ai00-desktop"
const STORE_GRID = "grid"
const STORE_CATS = "categories"

function openDB(): Promise<IDBDatabase> {
  return openIndexedDB(DB_NAME, 3, (db) => {
    if (!db.objectStoreNames.contains(STORE_GRID)) {
      db.createObjectStore(STORE_GRID, { keyPath: "path" })
    }
    if (!db.objectStoreNames.contains(STORE_CATS)) {
      db.createObjectStore(STORE_CATS, { keyPath: "id" })
    }
  })
}

export async function listGrid(): Promise<GridItem[]> {
  const db = await openDB()
  return dbGetAll<GridItem>(db, STORE_GRID)
}

export async function getGridItem(path: string): Promise<GridItem | undefined> {
  const db = await openDB()
  return dbGet<GridItem>(db, STORE_GRID, path)
}

export async function setGridItem(item: GridItem): Promise<void> {
  const db = await openDB()
  await dbPut(db, STORE_GRID, item)
}

export async function removeGridItem(path: string): Promise<void> {
  const db = await openDB()
  await dbDelete(db, STORE_GRID, path)
}

// Categories API

export async function listCategories(): Promise<Category[]> {
  const db = await openDB()
  try {
    if (!db.objectStoreNames.contains(STORE_CATS)) {
      return []
    }
    return await dbGetAll<Category>(db, STORE_CATS)
  } catch (e) {
    return []
  }
}

export async function getCategory(id: string): Promise<Category | undefined> {
  const db = await openDB()
  try {
    if (!db.objectStoreNames.contains(STORE_CATS)) {
      return undefined
    }
    return await dbGet<Category>(db, STORE_CATS, id)
  } catch (e) {
    return undefined
  }
}

export async function setCategory(cat: Category): Promise<void> {
  const db = await openDB()
  await dbPut(db, STORE_CATS, cat)
}

export async function removeCategory(id: string): Promise<void> {
  const db = await openDB()
  await dbDelete(db, STORE_CATS, id)
}