import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/infrastructure/i18n';
import { RefreshCw, Maximize2, Minimize2, X, RotateCw } from 'lucide-react';
import { EMBEDDED_SERVER_PORT, LOCAL_HOST } from '@/infrastructure/config/constants';
import './WallpaperPreviewWindow.scss';

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

const SCREEN_RATIOS = [
  { value: '16:9', label: '16:9' },
  { value: '16:10', label: '16:10' },
  { value: '4:3', label: '4:3' },
  { value: '21:9', label: '21:9' },
  { value: '1:1', label: '1:1' },
] as const;

function parseRatio(ratio: string): [number, number] {
  const [w, h] = ratio.split(':').map(Number);
  return [w, h];
}

interface WallpaperPreviewWindowProps {
  isOpen: boolean;
  onClose: () => void;
  workspacePath?: string;
}

export const WallpaperPreviewWindow: React.FC<WallpaperPreviewWindowProps> = ({
  isOpen,
  onClose,
  workspacePath,
}) => {
  const { t } = useI18n('scenes/wallpaper');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeInjectedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

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

  // Track parent size so the preview re-flows when the viewport resizes.
  const [parentSize, setParentSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!isOpen) return;
    const update = () => {
      const parentEl = containerRef.current?.parentElement;
      setParentSize({
        width: parentEl?.clientWidth || window.innerWidth,
        height: parentEl?.clientHeight || window.innerHeight,
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [isOpen]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_RATIO, selectedRatio);
  }, [selectedRatio]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_PORTRAIT, String(isPortrait));
  }, [isPortrait]);

  const previewUrl = useMemo(() => {
    if (!workspacePath) return '';
    const parts = workspacePath.replace(/\\/g, '/').split('/');
    const dirName = parts[parts.length - 1];
    return `http://${LOCAL_HOST}:${EMBEDDED_SERVER_PORT}/wallpaper/projects/${dirName}/index.html`;
  }, [workspacePath]);

  const computedDimensions = useMemo(() => {
    let [rw, rh] = parseRatio(selectedRatio);
    if (isPortrait) {
      [rw, rh] = [rh, rw];
    }

    const headerHeight = 36;
    // Title + ratio select + 5 buttons (~28px each) + gaps/padding.
    // Keep the header usable — buttons must not be clipped.
    const minHeaderWidth = 360;

    const parentHeight = parentSize.height || window.innerHeight;
    const parentWidth = parentSize.width || window.innerWidth;

    const maxHeight = parentHeight - headerHeight;
    // Cap width to 45% of parent or 560px, whichever is smaller.
    const maxWidth = Math.min(parentWidth * 0.45, 560);

    const ratioValue = rw / rh;

    let width: number;
    let height: number;

    if (ratioValue >= 1) {
      // Landscape or square — fit to maxWidth, then clamp by maxHeight.
      width = maxWidth;
      height = Math.round(width / ratioValue);
      if (height > maxHeight) {
        height = maxHeight;
        width = Math.round(height * ratioValue);
      }
    } else {
      // Portrait — fit to maxHeight, then clamp by maxWidth.
      height = maxHeight;
      width = Math.round(height * ratioValue);
      if (width > maxWidth) {
        width = maxWidth;
        height = Math.round(width / ratioValue);
      }
    }

    // Guarantee the header has enough room for its controls.
    if (width < minHeaderWidth) {
      width = minHeaderWidth;
      // Recompute height from the clamped width, then clamp by maxHeight.
      height = Math.round(width / ratioValue);
      if (height > maxHeight) {
        height = maxHeight;
      }
    }

    return { width, height };
  }, [selectedRatio, isPortrait, parentSize]);

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

  const handleToggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  const handleTogglePortrait = useCallback(() => {
    setIsPortrait((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isFullscreen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, isFullscreen]);

  if (!isOpen || !previewUrl) return null;

  const showRotateBtn = selectedRatio !== '1:1';

  const content = (
    <div
      ref={containerRef}
      className={[
        'wp-preview',
        isFullscreen && 'wp-preview--fullscreen',
      ].filter(Boolean).join(' ')}
      style={isFullscreen ? undefined : {
        width: computedDimensions.width,
        height: computedDimensions.height + 36,
      }}
    >
      <div className="wp-preview__header">
        <span className="wp-preview__title">
          {t('preview.title', { defaultValue: 'Wallpaper Preview' })}
        </span>
        <select
          className="wp-preview__ratio-select"
          value={selectedRatio}
          onChange={(e) => setSelectedRatio(e.target.value)}
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
        <div className="wp-preview__actions">
          {showRotateBtn && (
            <button
              className={`wp-preview__btn${isPortrait ? ' wp-preview__btn--active' : ''}`}
              onClick={handleTogglePortrait}
              title={t('preview.rotate', { defaultValue: 'Rotate Portrait' })}
              type="button"
            >
              <RotateCw size={14} />
            </button>
          )}
          <button
            className="wp-preview__btn"
            onClick={handleRefresh}
            title={t('preview.refresh', { defaultValue: 'Refresh' })}
            type="button"
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="wp-preview__btn"
            onClick={handleToggleFullscreen}
            title={isFullscreen
              ? t('preview.exitFullscreen', { defaultValue: 'Exit Fullscreen' })
              : t('preview.fullscreen', { defaultValue: 'Fullscreen' })}
            type="button"
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="wp-preview__btn wp-preview__btn--close"
            onClick={onClose}
            title={t('preview.close', { defaultValue: 'Close' })}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="wp-preview__body">
        <iframe
          ref={iframeRef}
          key={refreshKey}
          src={previewUrl}
          onLoad={handleIframeLoad}
          className="wp-preview__iframe"
          title="wallpaper-preview"
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin"
        />
      </div>
    </div>
  );

  if (isFullscreen) {
    return createPortal(content, document.body);
  }

  return content;
};

export default WallpaperPreviewWindow;
