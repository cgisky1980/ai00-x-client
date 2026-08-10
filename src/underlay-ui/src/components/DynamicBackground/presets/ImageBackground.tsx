import React, { useMemo } from 'react';

interface Props {
  config: Record<string, unknown>;
  style: React.CSSProperties;
}

/** Static image background (supports single image or slideshow) */
export function ImageBackground({ config, style }: Props) {
  const src = useMemo(() => {
    const s = config.src;
    if (typeof s === 'string' && s.length > 0) return s;
    return undefined;
  }, [config.src]);

  const fit = useMemo(() => {
    const f = config.fit;
    return typeof f === 'string' ? f : 'cover';
  }, [config.fit]);

  if (!src) {
    return <div style={{ ...style, background: '#1a1a2e' }} />;
  }

  const imgStyle: React.CSSProperties = {
    ...style,
    objectFit: fit as React.CSSProperties['objectFit'],
  };

  return <img src={src} style={imgStyle} alt="" />;
}