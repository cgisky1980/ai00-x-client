import React from 'react';
import { useBackground } from './BackgroundContext';
import type { BackgroundSlot } from './types';
import { TransparentBackground } from './presets/TransparentBackground';
import { GradientBackground } from './presets/GradientBackground';
import { VideoBackground } from './presets/VideoBackground';
import { ImageBackground } from './presets/ImageBackground';
import { WebContentBackground } from './presets/WebContentBackground';

function renderSlot(slot: BackgroundSlot, key: string, bounds?: { x: number; y: number; w: number; h: number }) {
  const style: React.CSSProperties = bounds
    ? {
        position: 'fixed',
        top: bounds.y,
        left: bounds.x,
        width: bounds.w,
        height: bounds.h,
        overflow: 'hidden',
        zIndex: 0,
      }
    : {
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        zIndex: 0,
      };

  switch (slot.type) {
    case 'gradient':
      return <GradientBackground key={key} config={slot.config} style={style} />;
    case 'video':
      return <VideoBackground key={key} config={slot.config} style={style} />;
    case 'image':
      return <ImageBackground key={key} config={slot.config} style={style} />;
    case 'web':
      return <WebContentBackground key={key} config={slot.config} style={style} />;
    case 'transparent':
    default:
      return <TransparentBackground key={key} style={style} />;
  }
}

export function DynamicBackground() {
  const { config, monitors } = useBackground();

  if (config.mode === 'per-monitor' && monitors.length > 0 && config.monitors) {
    const dpr = window.devicePixelRatio || 1;
    return (
      <>
        {monitors.map((m) => {
          const slot = config.monitors?.[m.id] ?? config.default;
          return renderSlot(slot, `bg-${m.id}`, {
            x: m.x / dpr,
            y: m.y / dpr,
            w: m.width / dpr,
            h: m.height / dpr,
          });
        })}
      </>
    );
  }

  // single mode: one background covering entire window
  return renderSlot(config.default, 'bg-single');
}