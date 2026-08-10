/**
 * useShareCover — 加载分享封面图的可显示 URL。
 *
 * 列表封面由服务器提供：服务端 `SharedSongListItem.coverUrl` 返回相对路径
 * `/api/v1/share/{id}/cover`，前端通过 `getApiBaseUrl()` 拼接完整 URL，
 * 直接用 `<img src>` 从服务器加载（无需下载到本地磁盘缓存）。
 *
 * 模块级 Map 缓存 shareId → URL，同一 shareId 的多个组件实例共享缓存，
 * 不重复解析 baseUrl。无封面的 shareId 也缓存为 null，避免重复判断。
 *
 * ## LRU 淘汰
 *
 * 模块级缓存有大小上限（`COVER_CACHE_MAX`，默认 100），超过时淘汰最早插入的
 * 条目（FIFO，Map 保持插入顺序）。用户浏览广场时每个卡片会调用此 hook，
 * 无上限会导致内存持续增长。
 *
 * @param shareId UUID v4 字符串
 * @param coverUrl 服务端返回的相对封面路径（`/api/v1/share/{id}/cover`），
 *   无封面时为 null / undefined / 空串
 * @returns
 *   - `undefined` 加载中（baseUrl 解析中）
 *   - `null` 无封面（调用方显示占位符）
 *   - `string` 可直接用于 `<img src>` 的完整 URL
 */

import { useEffect, useState } from 'react';
import { getApiBaseUrl } from '@/infrastructure/account/avatarConfigAdapter';

// 模块级缓存：shareId → URL | null（null = 已知无封面）
const coverUrlCache = new Map<string, string | null>();
// 缓存大小上限（浏览广场时 shareId 数量可能很大，超过时淘汰最早插入的条目）
const COVER_CACHE_MAX = 100;

/**
 * 写入缓存，若超过上限则淘汰最早插入的条目（FIFO LRU）。
 *
 * 若 key 已存在，更新值不增加大小（先 delete 再 set 让该 key 成为最新插入）。
 * 若 key 不存在且已达上限，删除 Map 第一个条目（keys().next().value）。
 */
function setCoverCache(key: string, value: string | null): void {
  if (coverUrlCache.has(key)) {
    coverUrlCache.delete(key); // 先删，让 set 后该 key 排在末尾（最近使用）
  } else if (coverUrlCache.size >= COVER_CACHE_MAX) {
    // 淘汰最早插入的条目（Map 保持插入顺序）
    const firstKey = coverUrlCache.keys().next().value;
    if (firstKey !== undefined) {
      coverUrlCache.delete(firstKey);
    }
  }
  coverUrlCache.set(key, value);
}

/** 服务端 cover_url 是否为有效相对路径（非空且以 / 开头）。 */
function isValidCoverUrl(coverUrl?: string | null): boolean {
  return typeof coverUrl === 'string' && coverUrl.length > 0;
}

export function useShareCover(
  shareId: string,
  coverUrl?: string | null,
): string | null | undefined {
  const [coverURL, setCoverURL] = useState<string | null | undefined>(() => {
    if (!isValidCoverUrl(coverUrl)) return null;
    return coverUrlCache.get(shareId); // undefined = 未解析, null = 无封面, string = URL
  });

  useEffect(() => {
    if (!isValidCoverUrl(coverUrl)) {
      setCoverURL(null);
      return;
    }
    // 已缓存（包括 null）
    if (coverUrlCache.has(shareId)) {
      setCoverURL(coverUrlCache.get(shareId) ?? null);
      return;
    }
    let cancelled = false;
    setCoverURL(undefined); // loading
    getApiBaseUrl()
      .then((base) => {
        if (cancelled) return;
        // 保证相对路径开头是单个 `/`
        const path = coverUrl!.startsWith('/') ? coverUrl! : `/${coverUrl}`;
        const full = `${base.replace(/\/$/, '')}${path}`;
        setCoverCache(shareId, full);
        setCoverURL(full);
      })
      .catch(() => {
        if (cancelled) return;
        // 解析失败视为无封面，避免持续重试
        setCoverCache(shareId, null);
        setCoverURL(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shareId, coverUrl]);

  return coverURL;
}

/**
 * 清除指定 shareId 的封面缓存（用于分享被吊销等场景）。
 */
export function clearShareCoverCache(shareId: string): void {
  coverUrlCache.delete(shareId);
}

/**
 * 清除所有封面缓存（用于登出/切换用户等场景）。
 */
export function clearAllShareCoverCache(): void {
  coverUrlCache.clear();
}