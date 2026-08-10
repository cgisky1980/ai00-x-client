import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow, LogicalSize, currentMonitor } from '@tauri-apps/api/window';
import { RefreshCw, RotateCw, Pin, PinOff } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { WindowControls } from '@/component-library';
import { EMBEDDED_SERVER_PORT, LOCAL_HOST } from '@/infrastructure/config/constants';
import './WallpaperPreviewApp.scss';

const WALLPAPER_BRIDGE_SCRIPT = `
(function() {
  if (window.Ai00Wallpaper) return;
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
    }
  };
})();
`;

const STORAGE_KEY_RATIO = 'ai00.wallpaper-preview.ratio';
const STORAGE_KEY_PORTRAIT = 'ai00.wallpaper-preview.portrait';
const STORAGE_KEY_SCALE = 'ai00.wallpaper-preview.scale';
const TITLEBAR_HEIGHT = 40;

const SCREEN_RATIOS = [
  { value: '16:9', label: '16:9' },
  { value: '16:10', label: '16:10' },
  { value: '4:3', label: '4:3' },
  { value: '21:9', label: '21:9' },
  { value: '1:1', label: '1:1' },
] as const;

const SCALE_OPTIONS = [
  { value: 0.25, label: '25%' },
  { value: 0.5, label: '50%' },
  { value: 0.75, label: '75%' },
  { value: 1.0, label: '100%' },
] as const;

function parseRatio(ratio: string): [number, number] {
  const [w, h] = ratio.split(':').map(Number);
  return [w, h];
}

function getEffectiveRatio(selectedRatio: string, isPortrait: boolean): [number, number] {
  let [rw, rh] = parseRatio(selectedRatio);
  if (isPortrait) {
    [rw, rh] = [rh, rw];
  }
  return [rw, rh];
}

interface WallpaperPreviewAppProps {
  projectPath?: string;
}

const WallpaperPreviewApp: React.FC<WallpaperPreviewAppProps> = ({ projectPath }) => {
  const { t } = useI18n('scenes/wallpaper');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeInjectedRef = useRef(false);

  const [refreshKey, setRefreshKey] = useState(0);
  const [isPinned, setIsPinned] = useState(false);
  const [screenSize, setScreenSize] = useState({ width: 1920, height: 1080 });

  const [selectedRatio, setSelectedRatio] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_RATIO) || '16:9';
    } catch {
      return '16:9';
    }
  });

  const [isPortrait, setIsPortrait] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_PORTRAIT) === 'true';
    } catch {
      return false;
    }
  });

  const [selectedScale, setSelectedScale] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_SCALE);
      return saved ? parseFloat(saved) : 0.5;
    } catch {
      return 0.5;
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_RATIO, selectedRatio);
  }, [selectedRatio]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_PORTRAIT, String(isPortrait));
  }, [isPortrait]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_SCALE, String(selectedScale));
  }, [selectedScale]);

  useEffect(() => {
    getCurrentWindow().isAlwaysOnTop().then(setIsPinned).catch(() => {});
  }, []);

  useEffect(() => {
    currentMonitor().then((monitor) => {
      if (monitor) {
        setScreenSize({ width: monitor.size.width, height: monitor.size.height });
      }
    }).catch(() => {});
  }, []);

  const previewUrl = useMemo(() => {
    if (!projectPath) return '';
    const parts = projectPath.replace(/\\/g, '/').split('/');
    const dirName = parts[parts.length - 1];
    return `http://${LOCAL_HOST}:${EMBEDDED_SERVER_PORT}/wallpaper/projects/${dirName}/index.html`;
  }, [projectPath]);

  const applyWindowSize = useCallback(async (ratio: string, portrait: boolean, scale: number) => {
    const win = getCurrentWindow();
    try {
      const monitor = await currentMonitor();
      if (!monitor) return;
      const screenW = monitor.size.width;
      const screenH = monitor.size.height;
      const scaleFactor = monitor.scaleFactor;
      const [rw, rh] = getEffectiveRatio(ratio, portrait);

      const logicalScreenW = screenW / scaleFactor;
      const logicalScreenH = screenH / scaleFactor;

      let contentW: number;
      let contentH: number;

      if (rw >= rh) {
        contentW = Math.round(logicalScreenW * scale);
        contentH = Math.round(contentW * rh / rw);
        if (contentH > logicalScreenH * scale) {
          contentH = Math.round(logicalScreenH * scale);
          contentW = Math.round(contentH * rw / rh);
        }
      } else {
        contentH = Math.round(logicalScreenH * scale);
        contentW = Math.round(contentH * rw / rh);
        if (contentW > logicalScreenW * scale) {
          contentW = Math.round(logicalScreenW * scale);
          contentH = Math.round(contentW * rh / rw);
        }
      }

      // Guarantee the title bar has enough room for its controls
      // (title + 2 selects + size info + 2 tool buttons + window controls).
      // Without this, narrow portrait ratios like 9:16 clip the buttons.
      const MIN_WINDOW_WIDTH = 480;
      if (contentW < MIN_WINDOW_WIDTH) {
        contentW = MIN_WINDOW_WIDTH;
      }

      const windowW = contentW;
      const windowH = contentH + TITLEBAR_HEIGHT;

      await win.setSize(new LogicalSize(windowW, windowH));
    } catch {
      // ignore
    }
  }, []);

  const handleRatioChange = useCallback((newRatio: string) => {
    setSelectedRatio(newRatio);
    applyWindowSize(newRatio, isPortrait, selectedScale);
  }, [isPortrait, selectedScale, applyWindowSize]);

  const handleScaleChange = useCallback((newScale: number) => {
    setSelectedScale(newScale);
    applyWindowSize(selectedRatio, isPortrait, newScale);
  }, [selectedRatio, isPortrait, applyWindowSize]);

  const handleTogglePortrait = useCallback(() => {
    setIsPortrait((prev) => {
      const next = !prev;
      applyWindowSize(selectedRatio, next, selectedScale);
      return next;
    });
  }, [selectedRatio, selectedScale, applyWindowSize]);

  useEffect(() => {
    applyWindowSize(selectedRatio, isPortrait, selectedScale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || bridgeInjectedRef.current) return;
    try {
      (iframe.contentWindow as any)?.eval?.(WALLPAPER_BRIDGE_SCRIPT);
      bridgeInjectedRef.current = true;
    } catch {
      // Cross-origin iframes cannot be injected
    }
  }, []);

  useEffect(() => {
    bridgeInjectedRef.current = false;
  }, [previewUrl, refreshKey]);

  const handleRefresh = useCallback(() => {
    bridgeInjectedRef.current = false;
    setRefreshKey((k) => k + 1);
  }, []);

  const handleTogglePin = useCallback(async () => {
    const win = getCurrentWindow();
    const next = !isPinned;
    await win.setAlwaysOnTop(next);
    setIsPinned(next);
  }, [isPinned]);

  const handleClose = useCallback(() => {
    getCurrentWindow().close();
  }, []);

  const handleMinimize = useCallback(() => {
    getCurrentWindow().minimize();
  }, []);

  const showRotateBtn = selectedRatio !== '1:1';

  const sizeInfo = useMemo(() => {
    const [rw, rh] = getEffectiveRatio(selectedRatio, isPortrait);
    const scale = selectedScale;
    const contentW = Math.round(screenSize.width * scale);
    const contentH = Math.round(contentW * rh / rw);
    return `${Math.round(contentW)}×${contentH}`;
  }, [selectedRatio, isPortrait, selectedScale, screenSize]);

  return (
    <div className="wp-preview-app">
      <div className="wp-preview-app__titlebar" data-tauri-drag-region>
        <span className="wp-preview-app__title" data-tauri-drag-region>
          {t('preview.title', { defaultValue: 'Wallpaper Preview' })}
        </span>
        <div
          className="wp-preview-app__titlebar-tools"
          data-tauri-drag-region
        >
          <select
            className="wp-preview-app__ratio-select"
            value={selectedRatio}
            onChange={(e) => handleRatioChange(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            title={t('preview.ratio', { defaultValue: 'Screen Ratio' })}
          >
            {SCREEN_RATIOS.map((r) => (
              <option key={r.value} value={r.value}>
                {isPortrait && r.value !== '1:1'
                  ? r.value.split(':').reverse().join(':')
                  : r.label}
              </option>
            ))}
          </select>
          <select
            className="wp-preview-app__scale-select"
            value={selectedScale}
            onChange={(e) => handleScaleChange(parseFloat(e.target.value))}
            onMouseDown={(e) => e.stopPropagation()}
            title={t('preview.scale', { defaultValue: 'Preview Scale' })}
          >
            {SCALE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="wp-preview-app__size-info" data-tauri-drag-region>
            {sizeInfo}
          </span>
          {showRotateBtn && (
            <button
              className={`wp-preview-app__tool-btn${isPortrait ? ' wp-preview-app__tool-btn--active' : ''}`}
              onClick={handleTogglePortrait}
              title={t('preview.rotate', { defaultValue: 'Rotate Portrait' })}
              type="button"
            >
              <RotateCw size={14} />
            </button>
          )}
          <button
            className="wp-preview-app__tool-btn"
            onClick={handleRefresh}
            title={t('preview.refresh', { defaultValue: 'Refresh' })}
            type="button"
          >
            <RefreshCw size={14} />
          </button>
          <button
            className={`wp-preview-app__tool-btn${isPinned ? ' wp-preview-app__tool-btn--active' : ''}`}
            onClick={handleTogglePin}
            type="button"
            title={isPinned ? t('preview.unpin', { defaultValue: 'Unpin' }) : t('preview.pin', { defaultValue: 'Pin on Top' })}
          >
            {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        </div>
        <div className="wp-preview-app__controls">
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            showMaximize={false}
          />
        </div>
      </div>
      <div className="wp-preview-app__body">
        {previewUrl ? (
          <iframe
            ref={iframeRef}
            key={refreshKey}
            src={previewUrl}
            onLoad={handleIframeLoad}
            className="wp-preview-app__iframe"
            title="wallpaper-preview"
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin"
          />
        ) : (
          <div className="wp-preview-app__empty">
            {t('preview.noProject', { defaultValue: 'No wallpaper project selected' })}
          </div>
        )}
      </div>
    </div>
  );
};

export default WallpaperPreviewApp;
