/**
 * media — 发布媒体辅助（P1.1 编辑器媒体整合）
 *
 * - 视频白名单校验（与后端 VIDEO_HOST_WHITELIST 同集，客户端先行提示）
 * - 正文裸链视频抽取：用户直接把视频链接贴进正文（单独成行）时，
 *   发布前抽出转成 media 数组，正文保持干净文本
 */
import type { CommunityMediaItem } from './communityApi';

/** 客户端侧视频域名白名单（与后端同集；仅用于即时提示，最终以服务端校验为准） */
const VIDEO_HOSTS = ['bilibili.com', 'www.bilibili.com', 'youtu.be', 'www.youtube.com', 'v.qq.com'];

function videoHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return VIDEO_HOSTS.includes(host) ? host : null;
  } catch {
    return null;
  }
}

/** 校验并构造视频 media 项；非法返回 null（调用方提示） */
export function buildVideoItem(url: string): CommunityMediaItem | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const host = videoHost(trimmed);
  if (!host) return null;
  return { type: 'video', url: trimmed, provider: host };
}

/**
 * 从正文中抽出"单独成行"的视频外链（含前后空行收敛），返回净化正文与视频 URL 列表。
 * 命中条件：trim 后整行是一个白名单内视频链接（渲染层不会把它当普通文本展示）。
 */
export function extractVideoLinks(content: string): { content: string; videos: string[] } {
  const videos: string[] = [];
  const lines = content.split('\n');
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (t && videoHost(t)) {
      videos.push(t);
      return false;
    }
    return true;
  });
  // 连续空行收敛为单行（抽行后遗留）
  const cleaned: string[] = [];
  for (const line of kept) {
    if (line.trim() === '' && cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
      continue;
    }
    cleaned.push(line);
  }
  return { content: cleaned.join('\n').trim(), videos };
}
