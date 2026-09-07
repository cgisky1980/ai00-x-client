/**
 * MediaGrid — 动态媒体展示（九宫格图片 + 外链视频嵌入卡）
 *
 * 图片：≤9 张九宫格（1 张大图 / 2-4 张两列 / 5+ 三列），object-fit cover；
 * 视频：白名单域名（bilibili/youtube/qqvideo）URL → iframe embed 转换，
 * 转换失败回退为外链卡。媒体相对 URL 经 resolveMediaUrl 解析到服务器。
 */
import React, { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import { resolveMediaUrl, type CommunityMediaItem } from './communityApi';

/** 白名单域名 → iframe embed URL（与后端 is_allowed_video_host 同集；null=不可嵌入） */
function videoEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'www.bilibili.com' || host === 'bilibili.com') {
      const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      return m ? `https://player.bilibili.com/player.html?bvid=${m[1]}&autoplay=0` : null;
    }
    if (host === 'www.youtube.com' || host === 'youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/embed/${v}`;
      const m = u.pathname.match(/\/(?:shorts|embed)\/([0-9A-Za-z_-]+)/);
      return m ? `https://www.youtube.com/embed/${m[1]}` : null;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '');
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === 'v.qq.com') {
      const m = u.pathname.match(/\/([0-9A-Za-z]+)\.html$/);
      return m ? `https://v.qq.com/txp/iframe/player.html?vid=${m[1]}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 异步解析媒体 src（相对 → 绝对） */
function useMediaSrc(url: string): string {
  const [src, setSrc] = useState(url);
  useEffect(() => {
    let alive = true;
    void resolveMediaUrl(url)
      .then((s) => {
        if (alive) setSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);
  return src;
}

const MediaImage: React.FC<{ item: CommunityMediaItem; className: string }> = ({ item, className }) => {
  // 服务端上传会生成 480px WebP 缩略图（thumb）；九宫格优先用缩略图，详情大图回退原图
  const src = useMediaSrc(item.thumb || item.url);
  return (
    <div className={className}>
      <img src={src} alt="" loading="lazy" draggable={false} />
    </div>
  );
};

export const MediaGrid: React.FC<{ media: CommunityMediaItem[] }> = ({ media }) => {
  const images = media.filter((m) => m.type === 'image').slice(0, 9);
  const videos = media.filter((m) => m.type === 'video').slice(0, 1);
  if (images.length === 0 && videos.length === 0) return null;

  // 九宫格列数：1 张单列大图；2-4 两列；5+ 三列
  const gridCls =
    images.length === 1
      ? 'community-media__grid--n1'
      : images.length <= 4
        ? 'community-media__grid--n2'
        : 'community-media__grid--n3';

  return (
    <div className="community-media">
      {images.length > 0 && (
        <div className={`community-media__grid ${gridCls}`}>
          {images.map((m, i) => (
            <MediaImage key={`${m.url}-${i}`} item={m} className="community-media__cell" />
          ))}
        </div>
      )}
      {videos.map((m, i) => {
        const embed = videoEmbedUrl(m.url);
        return (
          <div key={`${m.url}-${i}`} className="community-media__video">
            {embed ? (
              <iframe
                className="community-media__video-frame"
                src={embed}
                title={m.title || 'video'}
                scrolling="no"
                frameBorder="0"
                allowFullScreen
                sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              />
            ) : (
              <a
                className="community-media__video-link"
                href={m.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Film size={16} aria-hidden />
                <span>{m.title || m.url}</span>
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
};
