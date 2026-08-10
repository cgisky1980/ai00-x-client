/**
 * coverImage — 封面图上传前的处理工具。
 *
 * 提供 3 个核心函数：
 *   1. `loadImageFromPath` — 从 Tauri 本地文件路径加载为 HTMLImageElement
 *   2. `cropAndResizeToWebP` — Canvas 裁剪 + 缩放到固定尺寸 + 转 WebP Blob
 *   3. `saveBlobToTempFile` — 把 Blob 写入临时文件，返回路径
 *
 * 设计目的：在 `ArchiveShareDialog` / `PackageDialog` 上传封面时，统一处理为
 * 512×512 WebP（quality=0.85），避免任意尺寸/格式的图片直接上传到服务器。
 *
 * @module coverImage
 */

import { join, appDataDir } from '@tauri-apps/api/path';
import { writeFile, mkdir, exists, readFile } from '@tauri-apps/plugin-fs';

/**
 * 获取封面缓存目录的绝对路径。
 *
 * 使用 Tauri 的 `appDataDir`（对应 `$APPDATA`），确保路径在 Tauri fs scope
 * 允许范围内（`fs:allow-home-write-recursive` + `fs:scope-app-recursive` 均允许）。
 *
 * 路径规则：`{appDataDir}/acestep/cover_uploads/`
 */
async function getCoverCacheDir(): Promise<string> {
  return join(await appDataDir(), 'acestep', 'cover_uploads');
}

/** 固定输出尺寸（正方形边长，像素）。 */
export const COVER_OUTPUT_SIZE = 512;

/** WebP 编码质量（0-1）。0.85 在视觉质量与文件大小间较好平衡。 */
export const COVER_WEBP_QUALITY = 0.85;

/**
 * 从 Tauri 本地文件路径加载为 CanvasImageSource（ImageBitmap）。
 *
 * 用 `readFile` 读取文件 bytes → `Blob` → `createImageBitmap`。
 * `ImageBitmap` 不受 CORS 限制，直接用于 `canvas.drawImage` 不会导致
 * tainted canvas（避免 `toBlob` 抛出 SecurityError）。
 *
 * @param filePath 本地文件绝对路径（如 `C:\...\.cache\abc.jpg`）
 * @returns 已解码的 ImageBitmap（可直接用于 drawImage）
 */
export async function loadImageFromPath(filePath: string): Promise<ImageBitmap> {
  if (!filePath) {
    throw new Error('filePath is empty');
  }
  const bytes = await readFile(filePath);
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
  try {
    return await createImageBitmap(blob);
  } catch {
    throw new Error(`Failed to load image: ${filePath}`);
  }
}

/**
 * Canvas 裁剪 + 缩放到固定尺寸 + 转 WebP Blob。
 *
 * 从源图片的 `cropArea` 区域裁剪，缩放到 `outputSize×outputSize`，编码为 WebP。
 *
 * @param image 源图片（ImageBitmap 或 HTMLImageElement，必须已加载完成）
 * @param cropArea 裁剪区域（源图片坐标系，像素）
 * @param outputSize 输出边长（像素），默认 512
 * @param quality WebP 质量（0-1），默认 0.85
 * @returns WebP Blob
 */
export function cropAndResizeToWebP(
  image: CanvasImageSource,
  cropArea: { x: number; y: number; width: number; height: number },
  outputSize: number = COVER_OUTPUT_SIZE,
  quality: number = COVER_WEBP_QUALITY,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (cropArea.width <= 0 || cropArea.height <= 0) {
      reject(new Error('Invalid crop area: width and height must be positive'));
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = outputSize;
    canvas.height = outputSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Failed to get canvas 2d context'));
      return;
    }
    // 高质量缩放（smoothing + quality）
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      image,
      cropArea.x,
      cropArea.y,
      cropArea.width,
      cropArea.height,
      0,
      0,
      outputSize,
      outputSize,
    );
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('canvas.toBlob returned null — WebP may be unsupported'));
          return;
        }
        resolve(blob);
      },
      'image/webp',
      quality,
    );
  });
}

/**
 * 把 Blob 写入临时文件，返回文件绝对路径。
 *
 * 路径规则：`{appDataDir}/acestep/cover_uploads/{timestamp}_{random}.webp`
 * 目录不存在时自动创建。使用 `appDataDir`（`$APPDATA`）以符合 Tauri fs scope
 * 限制（`songs_dir` 不在允许范围内会触发 `forbidden path` 错误）。
 *
 * @param blob WebP Blob（来自 `cropAndResizeToWebP`）
 * @returns 文件绝对路径
 */
export async function saveBlobToTempFile(blob: Blob): Promise<string> {
  // 1. 获取缓存目录（位于 $APPDATA 下，符合 Tauri fs scope）
  const cacheDir = await getCoverCacheDir();

  // 2. 确保目录存在（递归创建）
  if (!(await exists(cacheDir))) {
    await mkdir(cacheDir, { recursive: true });
  }

  // 3. 构造文件名：{timestamp}_{random}.webp
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const filename = `${timestamp}_${random}.webp`;
  const filePath = await join(cacheDir, filename);

  // 4. Blob → Uint8Array
  const arrayBuffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);

  // 5. 写入文件
  await writeFile(filePath, uint8);

  return filePath;
}

/**
 * 清理过期临时封面文件（可选维护函数）。
 *
 * 扫描 `{appDataDir}/acestep/cover_uploads/` 目录，删除超过 `maxAgeMs` 的文件。
 * 可在应用启动时调用，避免临时文件无限增长。
 *
 * @param maxAgeMs 最大年龄（毫秒），默认 7 天
 */
export async function cleanupOldTempCovers(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  try {
    const cacheDir = await getCoverCacheDir();
    if (!(await exists(cacheDir))) return;

    const { readDir, remove, stat } = await import('@tauri-apps/plugin-fs');
    const entries = await readDir(cacheDir);
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile) continue;
      try {
        const filePath = await join(cacheDir, entry.name);
        const fileStat = await stat(filePath);
        const mtimeMs = fileStat.mtime
          ? new Date(fileStat.mtime).getTime()
          : 0;
        if (mtimeMs > 0 && now - mtimeMs > maxAgeMs) {
          await remove(filePath);
        }
      } catch {
        // 单个文件清理失败不影响其他文件
      }
    }
  } catch {
    // 整体清理失败静默处理（维护性操作，不阻塞主流程）
  }
}