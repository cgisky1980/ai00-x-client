import React, { useEffect, useMemo, useRef } from 'react';

interface Props {
  config: Record<string, unknown>;
  style: React.CSSProperties;
}

/** RAF-driven gradient background — immune to WebView CSS animation throttling */
export function GradientBackground({ config, style }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const rafId = useRef(0);
  const tRef = useRef(0);

  const colors = useMemo(() => {
    const raw = config.colors;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map(String);
    }
    return ['#1a1a2e', '#16213e', '#0f3460'];
  }, [config.colors]);

  const angle = useMemo(() => {
    const a = config.angle;
    return typeof a === 'number' ? a : 135;
  }, [config.angle]);

  const speed = useMemo(() => {
    const s = config.speed;
    return typeof s === 'number' ? s : 20;
  }, [config.speed]);

  // Build the enlarged gradient that shifts horizontally
  const gradientStyle = useMemo(() => {
    // Double the gradient to make it seamless when shifting
    const doubled = [...colors, ...colors].join(', ');
    const seamless = `linear-gradient(${angle}deg, ${doubled})`;
    return seamless;
  }, [colors, angle]);

  // RAF animation loop
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    tRef.current = 0;
    const period = speed * 1000; // speed in seconds → ms for one full cycle

    const animate = (timestamp: number) => {
      // proportion through the cycle (0..1), wrapping
      const p = (timestamp % period) / period;
      // 0→50 maps to 0%→100%, 50→100 maps back to 0%
      const pos = p <= 0.5 ? p * 200 : (1 - p) * 200;
      el.style.backgroundPosition = `${pos}% 50%`;
      rafId.current = requestAnimationFrame(animate);
    };

    rafId.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId.current);
    };
  }, [speed]);

  const divStyle: React.CSSProperties = useMemo(
    () => ({
      ...style,
      background: gradientStyle,
      backgroundSize: '200% 200%',
      willChange: 'background-position',
    }),
    [style, gradientStyle],
  );

  // Ensure initial background position is set
  useEffect(() => {
    const el = ref.current;
    if (el) el.style.backgroundPosition = '0% 50%';
  }, []);

  return <div ref={ref} style={divStyle} />;
}