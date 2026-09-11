/**
 * TranslatePopup — 划词操作浮层（overlay 窗口常驻，App.tsx 挂载）。
 *
 * Rust 侧监听线程（selection_translate.rs）轮询鼠标拖选，松开后经
 * UIA TextPattern（失败退 WM_COPY）取词并 emit `translate-selection-detected`
 * 携带屏幕物理坐标；此处换算为 overlay 窗口内逻辑坐标，在光标附近弹出
 * 可扩展的操作条（ACTIONS 数组，当前：翻译 / 复制，可继续追加动作）。
 * 点「翻译」展开结果面板。`.no-penetrate` 自动注册点击穿透白名单。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useI18n } from '@/infrastructure/i18n';
import { translateApi } from '@/infrastructure/api/service-api/TranslateApi';
import { createLogger } from '@/shared/utils/logger';
import './TranslatePopup.scss';

const log = createLogger('TranslatePopup');

interface SelectionPayload {
  text: string;
  x: number;
  y: number;
}

interface Anchor {
  left: number;
  top: number;
}

interface TranslateResult {
  source: string;
  translated: string;
  error?: string;
}

type ActionId = 'translate' | 'copy';

const POPUP_WIDTH = 200;
const POPUP_MARGIN = 12;

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

export const TranslatePopup: React.FC = () => {
  const { t } = useI18n('translate');
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [source, setSource] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [flash, setFlash] = useState<ActionId | null>(null);
  const runIdRef = useRef(0);

  const close = useCallback(() => {
    runIdRef.current += 1;
    setAnchor(null);
    setSource('');
    setLoading(false);
    setResult(null);
    setFlash(null);
  }, []);

  /**
   * 屏幕物理坐标 → overlay 窗口内逻辑坐标。多个窗口都会收到事件，但只有
   * 覆盖该屏幕坐标的窗口（通常是全屏 overlay）返回锚点；主窗口等局部窗口
   * 返回 null 以避免渲染错位弹卡。
   */
  const toWindowAnchor = useCallback(async (payload: SelectionPayload): Promise<Anchor | null> => {
    const win = getCurrentWindow();
    let left = payload.x;
    let top = payload.y;
    try {
      const [pos, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
      left = (payload.x - pos.x) / scale;
      top = (payload.y - pos.y) / scale;
    } catch {
      // Fallback: assume fullscreen window at primary origin, scale 1.
    }
    if (left < -8 || top < -8 || left > window.innerWidth + 8 || top > window.innerHeight + 8) {
      return null;
    }
    const maxX = Math.max(0, window.innerWidth - POPUP_WIDTH - POPUP_MARGIN);
    const maxY = Math.max(0, window.innerHeight - POPUP_MARGIN);
    return {
      left: Math.min(Math.max(left, POPUP_MARGIN), maxX),
      top: Math.min(Math.max(top, POPUP_MARGIN), maxY),
    };
  }, []);

  const runTranslate = useCallback(async (text: string) => {
    const runId = ++runIdRef.current;
    setLoading(true);
    setResult(null);
    try {
      const res = await translateApi.translate({ text });
      if (runIdRef.current !== runId) return;
      setResult({ source: text, translated: res.translated });
    } catch (error) {
      if (runIdRef.current !== runId) return;
      setResult({
        source: text,
        translated: '',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (runIdRef.current === runId) setLoading(false);
    }
  }, []);

  /** 操作表：新增划词动作在这里追加即可（label 为 i18n key 后缀）。 */
  const actions: Array<{ id: ActionId; labelKey: string; run: (text: string) => void }> = [
    {
      id: 'translate',
      labelKey: 'actions.translate',
      run: (text) => void runTranslate(text),
    },
    {
      id: 'copy',
      labelKey: 'actions.copy',
      run: (text) => {
        void navigator.clipboard.writeText(text);
        setFlash('copy');
        window.setTimeout(() => setFlash(null), 1200);
      },
    },
  ];

  const showActionBar = useCallback(
    async (payload: SelectionPayload) => {
      log.info('selection event received', { len: payload.text.length });
      const anchor = await toWindowAnchor(payload);
      if (!anchor) return;
      setResult(null);
      setLoading(false);
      setFlash(null);
      setSource(payload.text);
      setAnchor(anchor);
    },
    [toWindowAnchor]
  );

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      const onSelection = await listen<SelectionPayload>(
        'translate-selection-detected',
        (event) => {
          void showActionBar(event.payload);
        }
      );
      if (disposed) {
        onSelection();
        return;
      }
      unlisteners.push(onSelection);

      // 幂等兜底：Rust 端已默认开启监听线程，这里失败不影响事件接收。
      try {
        await translateApi.setEnabled(true);
      } catch (error) {
        log.warn('translate_set_enabled failed (monitor may still be on)', { error });
      }
    };

    void setup();
    return () => {
      disposed = true;
      unlisteners.forEach((off) => off());
    };
  }, [showActionBar]);

  // 关闭通道：Esc / DOM 外点击 / 全局左键点击（overlay 穿透状态下 DOM 收不到
  // 外部点击，用 Rust 侧 global_click 事件判位）/ 空闲超时自动消失。
  const popupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!anchor) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.translate-popup')) close();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [anchor, close]);

  useEffect(() => {
    if (!anchor) return;
    let disposed = false;
    let offClick: (() => void) | undefined;

    void listen<{ x: number; y: number }>('global_click', (event) => {
      void (async () => {
        // 点击在浮层矩形内（如点「翻译」按钮）不关闭
        const el = popupRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const win = getCurrentWindow();
        try {
          const [pos, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
          const lx = (event.payload.x - pos.x) / scale;
          const ly = (event.payload.y - pos.y) / scale;
          if (lx < rect.left || lx > rect.right || ly < rect.top || ly > rect.bottom) close();
        } catch {
          close();
        }
      })();
    }).then((off) => {
      if (disposed) off();
      else offClick = off;
    });

    return () => {
      disposed = true;
      offClick?.();
    };
  }, [anchor, close]);

  // 空闲超时：操作条 8s，结果面板 30s 自动消失
  useEffect(() => {
    if (!anchor) return;
    const timeout = window.setTimeout(close, result !== null || loading ? 30000 : 8000);
    return () => window.clearTimeout(timeout);
  }, [anchor, result, loading, close]);

  if (!anchor) return null;

  const showResult = result !== null || loading;

  return (
    <div
      ref={popupRef}
      className="translate-popup no-penetrate"
      style={{ left: anchor.left, top: anchor.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {showResult ? (
        <div className="translate-popup__result">
          <div className="translate-popup__header">
            <span className="translate-popup__title">{t('result.title')}</span>
            <button
              type="button"
              className="translate-popup__icon-btn"
              onClick={() => {
                // 回到操作条，可继续选其他动作
                setResult(null);
                setLoading(false);
              }}
              aria-label="back"
            >
              ✕
            </button>
          </div>
          {loading && <div className="translate-popup__loading">{t('result.loading')}</div>}
          {!loading && result?.error && (
            <div className="translate-popup__error">
              {t('result.failed')}
              {result.error ? `: ${result.error}` : ''}
            </div>
          )}
          {!loading && result && !result.error && (
            <>
              <div className="translate-popup__text">{result.translated}</div>
              <div className="translate-popup__actions">
                <button
                  type="button"
                  className="translate-popup__btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(result.translated);
                    setFlash('copy');
                    window.setTimeout(() => setFlash(null), 1200);
                  }}
                >
                  {flash === 'copy' ? t('result.copied') : t('result.copy')}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="translate-popup__bar">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`translate-popup__btn${
                action.id === 'translate' ? ' translate-popup__btn--primary' : ''
              }`}
              onClick={() => action.run(source)}
            >
              {flash === action.id ? t('result.copied') : t(action.labelKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default TranslatePopup;
