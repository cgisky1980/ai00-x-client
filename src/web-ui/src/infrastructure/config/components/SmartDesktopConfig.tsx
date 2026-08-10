import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageSection,
  ConfigPageRow,
} from './common';
import { Switch } from '@/component-library';
import { configAPI } from '@/infrastructure/api';
import { wallpaperAPI, type WallpaperProject } from '@/infrastructure/api/service-api/WallpaperAPI';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { Paintbrush } from 'lucide-react';
import { EMBEDDED_SERVER_PORT, LOCAL_HOST } from '@/infrastructure/config/constants';
import './SmartDesktopConfig.scss';

interface BgSlot {
  type: 'web';
  config: { src: string };
}

interface BackgroundConfig {
  mode: 'single' | 'per-monitor';
  default: BgSlot;
  monitors?: Record<number, BgSlot>;
}

/** Per-monitor edit state */
interface MonitorEditState {
  webSrc: string;
  expanded: boolean;
}

function slotFromState(state: Partial<MonitorEditState>): BgSlot {
  return { type: 'web', config: { src: state.webSrc ?? '' } };
}

function stateFromSlot(slot: BgSlot | { type: string; config: Record<string, unknown> }): Partial<MonitorEditState> {
  // Backward-compatible: read webSrc from any slot type that has a src config
  const src = String(slot.config?.src ?? '');
  return { webSrc: src };
}

const SmartDesktopConfig: React.FC = () => {
  const { t } = useTranslation('settings/basics');
  const [underlayEnabled, setUnderlayEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [publishedWallpapers, setPublishedWallpapers] = useState<WallpaperProject[]>([]);

  // Single / default background state
  const [bgMode, setBgMode] = useState<'single' | 'per-monitor'>('single');
  const [webSrc, setWebSrc] = useState('');

  // Per-monitor state
  const [monitorList, setMonitorList] = useState<{ id: number; x: number; y: number; w: number; h: number; primary: boolean }[]>([]);
  const [monitorEdits, setMonitorEdits] = useState<Record<number, MonitorEditState>>({});

  const buildDefaultSlot = useCallback((): BgSlot => {
    return slotFromState({ webSrc });
  }, [webSrc]);

  const buildBgConfig = useCallback((): BackgroundConfig => {
    const cfg: BackgroundConfig = { mode: bgMode, default: buildDefaultSlot() };
    if (bgMode === 'per-monitor') {
      cfg.monitors = {};
      for (const [idStr, edit] of Object.entries(monitorEdits)) {
        cfg.monitors[parseInt(idStr, 10)] = slotFromState(edit);
      }
    }
    return cfg;
  }, [bgMode, buildDefaultSlot, monitorEdits]);

  const loadConfig = useCallback(async () => {
    try {
      const raw = await configAPI.getConfig('app.underlay');
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        setUnderlayEnabled(parsed?.enabled ?? false);

        const bg = parsed?.background as BackgroundConfig | undefined;
        if (bg) {
          const isPerMonitor = bg.mode === 'per-monitor';
          setBgMode(isPerMonitor ? 'per-monitor' : 'single');
          // Load default slot — always web type now
          const defState = stateFromSlot(bg.default || { type: 'web', config: { src: '' } });
          setWebSrc(defState.webSrc ?? '');

          // Load per-monitor state
          if (bg.monitors) {
            const edits: Record<number, MonitorEditState> = {};
            for (const [idStr, slot] of Object.entries(bg.monitors)) {
              const id = parseInt(idStr, 10);
              const slotState = stateFromSlot(slot);
              edits[id] = {
                webSrc: slotState.webSrc ?? '',
                expanded: false,
              };
            }
            setMonitorEdits(edits);
          }

          // If per-monitor mode, also load the monitor list so the UI renders correctly
          if (isPerMonitor) {
            try {
              const list = await invoke<{ id: number; x: number; y: number; width: number; height: number; isPrimary: boolean }[]>('get_monitors');
              if (list && list.length > 0) {
                setMonitorList(list.map(m => ({ id: m.id, x: m.x, y: m.y, w: m.width, h: m.height, primary: m.isPrimary })));
              }
            } catch {
              // Monitor detection failed, per-monitor UI may not show
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load underlay config:', e);
    } finally {
      setIsLoading(false);
    }

    // Load published wallpapers list
    try {
      const projects = await wallpaperAPI.listProjects();
      setPublishedWallpapers(projects || []);
    } catch {
      setPublishedWallpapers([]);
    }
  }, []);

  // Load monitors when switching to per-monitor mode
  const loadMonitors = useCallback(async () => {
    try {
      const list = await invoke<{ id: number; x: number; y: number; width: number; height: number; isPrimary: boolean }[]>('get_monitors');
      if (list && list.length > 0) {
        setMonitorList(list.map(m => ({ id: m.id, x: m.x, y: m.y, w: m.width, h: m.height, primary: m.isPrimary })));
        setMonitorEdits(prev => {
          const next = { ...prev };
          for (const m of list) {
            if (!next[m.id]) {
              next[m.id] = { webSrc, expanded: false };
            }
          }
          return next;
        });
      }
    } catch {
      // fallback
    }
  }, [webSrc]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const syncBackground = useCallback(async (enabled: boolean, cfg: BackgroundConfig) => {
    try {
      await configAPI.setConfig('app.underlay', { enabled, background: cfg });
      try {
        await emit('underlay_background_change', cfg);
      } catch {
        // underlay may not be open
      }
    } catch (err) {
      console.error('Failed to sync background config:', err);
    }
  }, []);

  const doSync = useCallback(async () => {
    await syncBackground(underlayEnabled, buildBgConfig());
  }, [underlayEnabled, buildBgConfig, syncBackground]);

  /** Sync with an explicit new webSrc value (avoids stale state from async setState). */
  const doSyncWithValue = useCallback(async (newSrc: string) => {
    const cfg: BackgroundConfig = {
      mode: bgMode,
      default: { type: 'web', config: { src: newSrc } },
    };
    if (bgMode === 'per-monitor') {
      cfg.monitors = {};
      for (const [idStr, edit] of Object.entries(monitorEdits)) {
        cfg.monitors[parseInt(idStr, 10)] = slotFromState(edit);
      }
    }
    await syncBackground(underlayEnabled, cfg);
  }, [underlayEnabled, bgMode, monitorEdits, syncBackground]);

  const handleToggle = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = e.target.checked;
    try {
      setUnderlayEnabled(enabled);
      await syncBackground(enabled, buildBgConfig());
      if (enabled) {
        await invoke('open_underlay_force');
      } else {
        await invoke('close_underlay');
      }
    } catch (err) {
      console.error('Failed to toggle underlay:', err);
      setUnderlayEnabled(!enabled);
    }
  }, [buildBgConfig, syncBackground]);

  const handleModeChange = useCallback(async (mode: 'single' | 'per-monitor') => {
    setBgMode(mode);
    if (mode === 'per-monitor') {
      await loadMonitors();
    }
    setTimeout(async () => {
      const cfg = buildBgConfig();
      cfg.mode = mode;
      await syncBackground(underlayEnabled, cfg);
    }, 0);
  }, [loadMonitors, syncBackground, underlayEnabled, buildBgConfig]);

  const handleMonitorFieldChange = useCallback((monitorId: number, field: string, value: string) => {
    setMonitorEdits(prev => ({
      ...prev,
      [monitorId]: { ...prev[monitorId], [field]: value },
    }));
  }, []);

  const toggleMonitorExpand = useCallback((monitorId: number) => {
    setMonitorEdits(prev => ({
      ...prev,
      [monitorId]: { ...prev[monitorId], expanded: !prev[monitorId]?.expanded },
    }));
  }, []);

  const inputStyle: React.CSSProperties = {
    padding: '4px 8px', borderRadius: '4px', width: '100%',
    background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)',
  };
  const selectStyle: React.CSSProperties = {
    padding: '4px 8px', borderRadius: '4px', background: 'var(--background)', color: 'var(--foreground)',
  };

  /** Render the wallpaper source selector: published packages dropdown + custom URL input */
  const renderWallpaperSource = (
    currentSrc: string,
    onChange: (value: string) => void,
    onBlur: () => void,
    /** Direct sync with explicit value — avoids stale React state. */
    onSyncValue: (newSrc: string) => void,
  ) => (
    <>
      {/* Published wallpaper packages */}
      <ConfigPageRow label={t('smartDesktop.background.selectWallpaper', { defaultValue: 'Wallpaper Package' })} align="center">
        <select
          value={publishedWallpapers.some(wp => `http://${LOCAL_HOST}:${EMBEDDED_SERVER_PORT}/wallpapers/projects/${wp.id}/index.html` === currentSrc) ? currentSrc : ''}
          onChange={e => {
            if (e.target.value) {
              onChange(e.target.value);
              onSyncValue(e.target.value);
            }
          }}
          disabled={isLoading}
          style={{ ...selectStyle, width: '100%' }}
        >
          <option value="">
            {publishedWallpapers.length > 0
              ? t('smartDesktop.background.selectWallpaperHint', { defaultValue: '-- Select a wallpaper --' })
              : t('smartDesktop.background.noWallpapers', { defaultValue: 'No published wallpapers' })}
          </option>
          {publishedWallpapers.map(wp => (
            <option key={wp.id} value={`http://${LOCAL_HOST}:${EMBEDDED_SERVER_PORT}/wallpapers/projects/${wp.id}/index.html`}>
              {wp.name}
            </option>
          ))}
        </select>
      </ConfigPageRow>

      {/* Custom URL */}
      <ConfigPageRow label={t('smartDesktop.background.customUrl', { defaultValue: 'Custom URL' })}>
        <input
          type="text"
          value={currentSrc}
          onChange={e => onChange(e.target.value)}
          onBlur={onBlur}
          disabled={isLoading}
          placeholder="https://example.com/wallpaper.html"
          style={inputStyle}
        />
      </ConfigPageRow>
    </>
  );

  return (
    <ConfigPageLayout className="ai00-x-smart-desktop-config">
      <ConfigPageHeader title={t('smartDesktop.title')} subtitle={t('smartDesktop.subtitle')} />
      <ConfigPageContent className="ai00-x-smart-desktop-config__content">

        {/* --- Enable toggle --- */}
        <ConfigPageSection title={t('smartDesktop.underlay.title')} description={t('smartDesktop.underlay.description')}>
          <ConfigPageRow label={t('smartDesktop.underlay.enabled')} description={t('smartDesktop.underlay.enabledHint')} align="center">
            <Switch checked={underlayEnabled} onChange={handleToggle} disabled={isLoading} />
          </ConfigPageRow>
        </ConfigPageSection>

        {/* --- Background settings --- */}
        <ConfigPageSection title={t('smartDesktop.background.title')} description={t('smartDesktop.background.description')}>

          {/* AI Wallpaper entry hint */}
          <ConfigPageRow
            label={t('smartDesktop.background.aiCustom')}
            description={t('smartDesktop.background.aiCustomHint')}
            align="center"
          >
            <span className="ai00-x-smart-desktop-config__ai-hint" style={{ color: 'var(--muted-foreground)', fontSize: '13px' }}>
              <Paintbrush size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              {t('smartDesktop.background.aiNavHint')}
            </span>
          </ConfigPageRow>

          {/* Mode selector */}
          <ConfigPageRow label={t('smartDesktop.background.mode')} description={t('smartDesktop.background.modeHint')} align="center">
            <select value={bgMode} onChange={e => handleModeChange(e.target.value as 'single' | 'per-monitor')} disabled={isLoading} style={selectStyle}>
              <option value="single">{t('smartDesktop.background.modeSingle')}</option>
              <option value="per-monitor">{t('smartDesktop.background.modePerMonitor')}</option>
            </select>
          </ConfigPageRow>

          {/* Single mode: wallpaper source selector */}
          {bgMode === 'single' && (
            renderWallpaperSource(webSrc, (v) => setWebSrc(v), doSync, doSyncWithValue)
          )}

          {/* Per-monitor mode */}
          {bgMode === 'per-monitor' && (
            <div style={{ marginTop: '12px' }}>
              {monitorList.length === 0 && (
                <ConfigPageRow label={t('smartDesktop.background.monitorLabel', { id: '' })}>
                  <span style={{ color: 'var(--muted-foreground)', fontSize: '14px' }}>
                    {isLoading ? 'Loading...' : 'No monitor data available'}
                  </span>
                </ConfigPageRow>
              )}
              {monitorList.map(m => {
                const edit = monitorEdits[m.id];
                if (!edit) return null;
                return (
                  <div key={m.id} style={{ marginBottom: '8px', border: '1px solid var(--border)', borderRadius: '6px', padding: '8px' }}>
                    <ConfigPageRow
                      label={`${t('smartDesktop.background.monitorLabel', { id: m.id })}${m.primary ? ` (${t('smartDesktop.background.monitorPrimary')})` : ''}`}
                      description={`${m.w}x${m.h}  (${m.x}, ${m.y})`}
                      align="center"
                    >
                      <button
                        type="button"
                        onClick={() => toggleMonitorExpand(m.id)}
                        style={{ marginLeft: '8px', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', cursor: 'pointer' }}
                      >
                        {edit.expanded ? '-' : '+'}
                      </button>
                    </ConfigPageRow>
                    {edit.expanded && (
                      <div style={{ paddingLeft: '16px' }}>
                        {renderWallpaperSource(
                          edit.webSrc,
                          (v) => handleMonitorFieldChange(m.id, 'webSrc', v),
                          doSync,
                          (newSrc) => {
                            // For per-monitor, update state and sync with explicit value
                            handleMonitorFieldChange(m.id, 'webSrc', newSrc);
                            const updatedEdits = { ...monitorEdits };
                            updatedEdits[m.id] = { ...updatedEdits[m.id], webSrc: newSrc };
                            const cfg: BackgroundConfig = {
                              mode: 'per-monitor',
                              default: buildDefaultSlot(),
                              monitors: {},
                            };
                            for (const [idStr, e] of Object.entries(updatedEdits)) {
                              if (cfg.monitors) {
                                cfg.monitors[parseInt(idStr, 10)] = slotFromState(e as any);
                              }
                            }
                            syncBackground(underlayEnabled, cfg);
                          },
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

        </ConfigPageSection>
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default SmartDesktopConfig;
