/**
 * P2P 下载客户端（Stage 5.13，v9 P2P 重构）
 *
 * 封装 Tauri 命令 `p2p_download_share` / `p2p_cancel_download` / `p2p_get_status`，
 * 对应 Rust 端 `src/apps/desktop/src/api/p2p_api.rs`。
 *
 * # 调用流程
 *
 * 1. `getMeta(shareId)` 拿到 `magnetLink`
 * 2. `downloadShare(shareId, magnetLink, filename)` 发起 BT 下载
 * 3. 轮询 `getStatus(shareId)` 显示进度（可选）
 * 4. 下载完成 → 拿 `filePath` 用 `convertFileSrc` 播放
 * 5. 长期做种（遇则弃）：切歌时默认保留 .a00m 文件并继续做种；仅手动清理时
 *    调 `cancelDownload(shareId)` 停止做种
 *
 * # v9 决策
 *
 * 无 HTTP 降级。P2P 失败时由调用方决定回退策略（playerStore 选择回退到
 * `shareService.downloadAndDecrypt` 走 HTTP 路径，保证可用性）。
 */

import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createTauriCommandError } from '@/infrastructure/api/errors/TauriCommandError';

/**
 * P2P 下载状态（与 Rust 端 `P2pStatus` 枚举对齐，camelCase）。
 *
 * v9 去掉 `fallback`（无 HTTP 降级字段）。
 */
export type P2PStatus = 'idle' | 'connecting' | 'downloading' | 'seeding' | 'error';

/** `p2p_download_share` 的响应 */
export interface P2PDownloadResult {
  /** 下载完成的文件绝对路径（可直接传给 `convertFileSrc` 播放） */
  filePath: string;
  /** 是否走了 P2P 路径（v9 始终为 true，保留字段供未来 HTTP 降级使用） */
  usedP2p: boolean;
  /** 下载用时（毫秒） */
  elapsedMs: number;
  /** 下载字节数（文件大小） */
  downloadedBytes: number;
}

/** `p2p_download_share` 的请求参数 */
export interface P2PDownloadShareParams {
  shareId: string;
  magnetLink: string;
  /** 期望的文件名（如 `{shareId}.flac`），仅用于记录，不影响实际下载文件名 */
  filename: string;
  /** 超时秒数（可选，默认 120，最小 30） */
  timeoutSecs?: number;
}

/** `p2p_get_progress` 的响应（与 Rust 端 `P2pProgress` 对齐，camelCase）。 */
export interface P2pProgress {
  /** 分享 ID */
  shareId: string;
  /** 当前下载状态 */
  status: P2PStatus;
  /** 已下载字节数 */
  downloaded: number;
  /** 总字节数（未知时为 0） */
  total: number;
  /** 下载进度（0.0~1.0） */
  percent: number;
  /** 当前连接节点数 */
  peerCount: number;
  /** 下载速率（字节/秒） */
  downloadRate: number;
  /** 上传速率（字节/秒，做种可视化） */
  uploadRate: number;
  /** 累计上传字节数（做种可视化） */
  uploaded: number;
  /** 下载文件名（如 `{shareId}.flac`） */
  filename: string;
  /** 错误原因（timeout / noSource / torrentError；无错误时为 null） */
  errorReason: string | null;
}

/** `p2p_cache_stats` 的响应（缓存磁盘占用统计）。 */
export interface P2pCacheStats {
  /** 缓存总字节数 */
  totalBytes: number;
  /** 缓存文件数 */
  fileCount: number;
  /** 各分享的缓存占用明细 */
  perShare: Array<{ shareId: string; bytes: number }>;
}

export const p2pClient = {
  /**
   * 通过 BT 下载 share 文件。
   *
   * 调用方需先通过 `shareService.getMeta` 获取 `magnetLink`。
   *
   * @param params 下载参数
   * @returns 下载结果（含文件绝对路径）
   */
  async downloadShare(params: P2PDownloadShareParams): Promise<P2PDownloadResult> {
    const { shareId, magnetLink, filename, timeoutSecs } = params;
    try {
      return await api.invoke<P2PDownloadResult>('p2p_download_share', {
        shareId,
        magnetLink,
        filename,
        timeoutSecs: timeoutSecs ?? null,
      });
    } catch (error) {
      throw createTauriCommandError('p2p_download_share', error, params);
    }
  },

  /**
   * 取消指定 share 的 P2P 下载并释放资源。
   *
   * 切歌或用户主动停止时调用。若 `shareId` 不在活跃下载中则静默返回（幂等）。
   *
   * @param shareId UUID v4 字符串
   */
  async cancelDownload(shareId: string): Promise<void> {
    try {
      await api.invoke<void>('p2p_cancel_download', { shareId });
    } catch (error) {
      throw createTauriCommandError('p2p_cancel_download', error, { shareId });
    }
  },

  /**
   * 查询指定 share 的 P2P 下载状态（供 UI 显示进度）。
   *
   * 若 `shareId` 不在活跃下载中则返回 `'idle'`。
   *
   * @param shareId UUID v4 字符串
   */
  async getStatus(shareId: string): Promise<P2PStatus> {
    try {
      return await api.invoke<P2PStatus>('p2p_get_status', { shareId });
    } catch (error) {
      throw createTauriCommandError('p2p_get_status', error, { shareId });
    }
  },

  /**
   * 查询指定 share 的 P2P 下载实时进度（字节/百分比/节点数/速率）。
   *
   * 若 `shareId` 不在活跃下载中则返回 `null`。用于在前端轮询显示进度。
   *
   * @param shareId UUID v4 字符串
   */
  async getProgress(shareId: string): Promise<P2pProgress | null> {
    try {
      return await api.invoke<P2pProgress | null>('p2p_get_progress', { shareId });
    } catch (error) {
      throw createTauriCommandError('p2p_get_progress', error, { shareId });
    }
  },

  /**
   * 列出全部活跃下载/做种条目，供「下载队列进度 + 做种可视化」。
   *
   * P2P 未初始化（非 webtorrent 后端）时返回空数组，不会抛错（后端已处理）。
   */
  async list(): Promise<P2pProgress[]> {
    try {
      return await api.invoke<P2pProgress[]>('p2p_list');
    } catch (error) {
      throw createTauriCommandError('p2p_list', error);
    }
  },

  /**
   * 停止做种/下载并（可选）删除本地缓存文件，将该 share 从活跃列表移除。
   *
   * @param shareId 目标分享 ID
   * @param deleteFile 为 true 时删除本地缓存文件（彻底移除）；为 false 时仅停止做种、保留文件
   */
  async remove(shareId: string, deleteFile: boolean): Promise<void> {
    try {
      await api.invoke<void>('p2p_remove', { shareId, deleteFile });
    } catch (error) {
      throw createTauriCommandError('p2p_remove', error, { shareId, deleteFile });
    }
  },

  /**
   * 缓存占用统计（`{cache_dir}` 下的 `.flac`/`.a00m` 文件）。
   */
  async cacheStats(): Promise<P2pCacheStats> {
    try {
      return await api.invoke<P2pCacheStats>('p2p_cache_stats');
    } catch (error) {
      throw createTauriCommandError('p2p_cache_stats', error);
    }
  },

  /**
   * 批量停止做种并（可选）删除本地缓存文件。
   *
   * @param shareIds 目标分享 ID 列表
   * @param delete 为 true 时删除文件（清空/清理缓存）；为 false 时仅停止做种
   */
  async clearCache(shareIds: string[], delete_: boolean): Promise<void> {
    try {
      await api.invoke<void>('p2p_clear_cache', { shareIds, delete: delete_ });
    } catch (error) {
      throw createTauriCommandError('p2p_clear_cache', error, { shareIds, delete: delete_ });
    }
  },
};
