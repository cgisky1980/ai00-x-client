import React, { useCallback, useEffect, useMemo, useRef } from 'react';

interface Props {
  config: Record<string, unknown>;
  style: React.CSSProperties;
}

/** Bridge script injected into wallpaper iframes */
const BRIDGE_SCRIPT = `
(function() {
  if (window.Ai00Wallpaper) return; // already injected

  var callbacks = { mouse: [], focus: [], property: [] };
  var state = {
    mouse: { x: 0, y: 0 },
    audio: { enabled: false },
    focused: true,
    properties: {}
  };

  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d) return;
    if (d.type === 'ai00-mouse') {
      state.mouse.x = d.x;
      state.mouse.y = d.y;
      callbacks.mouse.forEach(function(cb) { cb(d.x, d.y); });
    }
    if (d.type === 'ai00-focus') {
      state.focused = d.focused;
      callbacks.focus.forEach(function(cb) { cb(d.focused); });
    }
  });

  window.Ai00Wallpaper = {
    audio: {
      get enabled() { return state.audio.enabled; },
      requestPermission: function() {
        return new Promise(function(resolve) {
          state.audio.enabled = true;
          window.parent.postMessage({ type: 'ai00-request-audio' }, '*');
          resolve(true);
        });
      }
    },
    mouse: {
      get x() { return state.mouse.x; },
      get y() { return state.mouse.y; },
      onMove: function(cb) { callbacks.mouse.push(cb); }
    },
    system: {
      isDesktopFocused: function() { return state.focused; },
      onFocusChange: function(cb) { callbacks.focus.push(cb); }
    },
    properties: {
      get: function(key) { return state.properties[key]; },
      set: function(key, value) {
        state.properties[key] = value;
        callbacks.property.forEach(function(cb) { cb(key, value); });
      },
      onChange: function(cb) { callbacks.property.push(cb); }
    }
  };
})();
`;

/** iframe embedded web content as background (no scroll, no interaction) */
export function WebContentBackground({ config, style }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const injectedRef = useRef(false);

  const src = useMemo(() => {
    const s = config.src;
    return typeof s === 'string' && s.length > 0 ? s : undefined;
  }, [config.src]);

  // Inject Ai00Wallpaper bridge on iframe load
  const handleLoad = useCallback(() => {
    const iframe = ref.current;
    if (!iframe || injectedRef.current) return;
    try {
      (iframe.contentWindow as any)?.eval?.(BRIDGE_SCRIPT);
      injectedRef.current = true;
    } catch {
      // Cross-origin iframes cannot be injected — that's OK
    }
  }, []);

  // Reset injection flag when src changes
  useEffect(() => {
    injectedRef.current = false;
  }, [src]);

  // Reload iframe when page becomes visible again (desktop switch)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // Briefly clear src and restore to force iframe reload
      const prev = el.src;
      if (!prev || prev === 'about:blank') return;
      el.src = 'about:blank';
      requestAnimationFrame(() => {
        el.src = prev;
      });
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, []);

  return (
    <iframe
      ref={ref}
      src={src}
      onLoad={handleLoad}
      // pointerEvents:'none' 让鼠标事件穿透 iframe，到达下层的 PIXI canvas / document。
      // 壁纸交互通过 useRawMouseInjection 的 postMessage 转发，不依赖 iframe 自身接收事件。
      style={{ ...style, border: 'none', overflow: 'hidden', pointerEvents: 'none' }}
      scrolling="no"
      title="background"
    />
  );
}