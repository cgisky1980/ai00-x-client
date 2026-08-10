// ========================================================================
// 统一 KV 存储 Adapter（替代 localStorage/sessionStorage）
// ========================================================================
// 统一实现见 packages/shared/src/storage.ts（@ai00-x/shared）。
// 此处 re-export 以保持既有导入路径（@/lib/storage）不变。
// ========================================================================
export { storage, type KvStore, type KvChangedEvent } from '@ai00-x/shared';