/**
 * NavPanel — navigation sidebar container.
 *
 * Two transition modes depending on the target scene:
 *
 *   file-viewer:
 *     Split-open accordion — MainNav items depart up/down from the anchor
 *     item while SceneNav is revealed via clip-path expanding from the
 *     anchor's Y position. Both layers coexist in the DOM (overlay).
 *
 *   All other scenes (settings, …):
 *     Simple crossfade — MainNav hidden instantly, SceneNav fades in.
 *
 * MainNav is always mounted so its state is preserved across transitions.
 */

import React, { Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { Search } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { useNavSceneStore } from '../../stores/navSceneStore';
import { useModeStore } from '../../stores/modeStore';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import { getSceneNav } from '../../scenes/nav-registry';
import type { SceneTabId } from '../SceneBar/types';
import MainNav from './MainNav';
import PersistentFooterActions from './components/PersistentFooterActions';
import NavSearchResults from './NavSearchResults';
import { SessionSwitcher } from '@/tools/acestep/components/SessionSwitcher';
import './NavPanel.scss';

const SPLIT_OPEN_SCENES: ReadonlySet<SceneTabId> = new Set(['file-viewer']);

interface NavPanelProps {
  className?: string;
  compact?: boolean;
}

const NavPanel: React.FC<NavPanelProps> = ({ className = '', compact = false }) => {
  const { t } = useI18n('common');
  const showSceneNav = useNavSceneStore(s => s.showSceneNav);
  const navSceneId = useNavSceneStore(s => s.navSceneId);
  const activeMode = useModeStore(s => s.activeMode);
  const isTaskMode = activeMode === 'task';
  const isWallpaperMode = activeMode === 'wallpaper';
  const isMusicMode = activeMode === 'music';
  const searchMode = (isTaskMode || isWallpaperMode) ? 'sessions-only' : 'all';

  const [taskWorkspacePath, setTaskWorkspacePath] = useState<string>('');
  useEffect(() => {
    if (isTaskMode) {
      globalAPI.getTaskWorkspacePath().then(setTaskWorkspacePath).catch(() => {});
    }
  }, [isTaskMode]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!searchOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (searchTriggerRef.current?.contains(target)) return;
      const resultsPanel = document.querySelector('.ai00-x-nav-search-dialog__results-panel');
      if (resultsPanel?.contains(target)) return;
      setSearchOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [searchOpen]);

  const toggleNavSearch = useCallback(() => {
    setSearchOpen((v) => !v);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        !e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey ||
        e.key.toLowerCase() !== 'f'
      ) {
        return;
      }
      e.preventDefault();
      toggleNavSearch();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [toggleNavSearch]);

  const [mountedSceneId, setMountedSceneId] = useState<SceneTabId | null>(navSceneId);
  useEffect(() => {
    if (navSceneId) setMountedSceneId(navSceneId);
  }, [navSceneId]);

  const SceneNavComponent = mountedSceneId ? getSceneNav(mountedSceneId) : null;

  const useSplitOpen = !!(showSceneNav && mountedSceneId && SPLIT_OPEN_SCENES.has(mountedSceneId));

  const contentRef = useRef<HTMLDivElement>(null);

  const updateClipOrigin = useCallback(() => {
    const container = contentRef.current;
    if (!container) return;
    const anchor = container.querySelector<HTMLElement>('.ai00-x-nav-panel__item-slot.is-departing-anchor');
    if (anchor) {
      const containerRect = container.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const anchorCenterY = anchorRect.top + anchorRect.height / 2 - containerRect.top;
      const pct = (anchorCenterY / containerRect.height) * 100;
      container.style.setProperty('--clip-origin-top', `${pct}%`);
      container.style.setProperty('--clip-origin-bottom', `${100 - pct}%`);
    }
  }, []);

  useEffect(() => {
    if (useSplitOpen) {
      requestAnimationFrame(updateClipOrigin);
    }
  }, [useSplitOpen, updateClipOrigin]);

  const contentCls = [
    'ai00-x-nav-panel__content',
    showSceneNav && 'is-scene',
    useSplitOpen && 'is-split-open',
  ].filter(Boolean).join(' ');

  const sceneCls = [
    'ai00-x-nav-panel__layer ai00-x-nav-panel__layer--scene',
    showSceneNav && 'is-active',
  ].filter(Boolean).join(' ');

  return (
    <nav className={`ai00-x-nav-panel ${className}`} aria-label={t('nav.aria.mainNav')}>
      <div className="ai00-x-nav-panel__search-section" ref={searchTriggerRef}>
        <div className="ai00-x-nav-panel__search-input-wrap">
          <Search size={13} className="ai00-x-nav-panel__search-input-icon" />
          <input
            ref={searchInputRef}
            type="text"
            className="ai00-x-nav-panel__search-input"
            placeholder={isMusicMode
              ? t('nav.search.musicPlaceholder', { defaultValue: '搜索会话...' })
              : t('nav.search.triggerPlaceholder')}
            value={searchQuery}
            onChange={e => {
              setSearchQuery(e.target.value);
              setSearchActiveIndex(0);
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setSearchOpen(false);
                searchInputRef.current?.blur();
              }
            }}
          />
          {searchQuery && (
            <button
              type="button"
              className="ai00-x-nav-panel__search-input-clear"
              onClick={() => { setSearchQuery(''); setSearchActiveIndex(0); searchInputRef.current?.focus(); }}
              aria-label={t('nav.search.clear', { defaultValue: 'Clear' })}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          )}
        </div>
        {searchOpen && !isMusicMode && (
          <NavSearchResults
            anchorRef={searchTriggerRef}
            query={searchQuery}
            searchMode={searchMode}
            filterWorkspacePath={isTaskMode ? taskWorkspacePath : undefined}
            excludeWorkspacePaths={(!isTaskMode && !isWallpaperMode && taskWorkspacePath) ? [taskWorkspacePath] : undefined}
            activeIndex={searchActiveIndex}
            setActiveIndex={setSearchActiveIndex}
            onClose={() => setSearchOpen(false)}
          />
        )}
      </div>

      <div ref={contentRef} className={contentCls}>
        {isMusicMode ? (
          <div className="ai00-x-nav-panel__layer ai00-x-nav-panel__layer--music">
            <SessionSwitcher filter={searchQuery} />
          </div>
        ) : (
          <>
            <div className="ai00-x-nav-panel__layer ai00-x-nav-panel__layer--main">
              <MainNav
                isDeparting={useSplitOpen}
                anchorNavSceneId={useSplitOpen ? mountedSceneId : null}
              />
            </div>

            {SceneNavComponent && (
              <div className={sceneCls}>
                <Suspense fallback={null}>
                  <div key={mountedSceneId} className="ai00-x-nav-panel__scene-inner">
                    <SceneNavComponent />
                  </div>
                </Suspense>
              </div>
            )}
          </>
        )}
      </div>
      <PersistentFooterActions compact={compact} />
    </nav>
  );
};

export default NavPanel;
