import React, { useMemo, useRef, useEffect } from 'react';

interface Props {
  config: Record<string, unknown>;
  style: React.CSSProperties;
}

/** HTML5 video background */
export function VideoBackground({ config, style }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const src = useMemo(() => {
    const s = config.src;
    return typeof s === 'string' && s.length > 0 ? s : undefined;
  }, [config.src]);

  const muted = useMemo(() => config.muted !== false, [config.muted]);
  const loop = useMemo(() => config.loop !== false, [config.loop]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    video.play().catch(() => {
      // autoplay may be blocked
    });
  }, [src]);

  if (!src) {
    return <div style={{ ...style, background: '#000' }} />;
  }

  const videoStyle: React.CSSProperties = {
    ...style,
    objectFit: 'cover',
  };

  return (
    <video
      ref={videoRef}
      src={src}
      style={videoStyle}
      muted={muted}
      loop={loop}
      playsInline
    />
  );
}