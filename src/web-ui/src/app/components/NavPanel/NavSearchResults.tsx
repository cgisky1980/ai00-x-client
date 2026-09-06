import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalContainer } from '@/infrastructure/contexts/PortalContainerContext';
import { FolderOpen } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import './NavSearchDialog.scss';

type ResultKind = 'workspace';

interface SearchResultItem {
  kind: ResultKind;
  id: string;
  label: string;
  sublabel?: string;
  workspaceId?: string;
}

const MAX_PER_GROUP = 20;

const matchesQuery = (query: string, ...fields: (string | undefined | null)[]): boolean => {
  const q = query.toLowerCase();
  return fields.some(f => f && f.toLowerCase().includes(q));
};

interface NavSearchResultsProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  query: string;
  searchMode: 'all' | 'sessions-only';
  filterWorkspacePath?: string;
  excludeWorkspacePaths?: string[];
  activeIndex: number;
  setActiveIndex: (idx: number) => void;
  onClose: () => void;
}

const NavSearchResults: React.FC<NavSearchResultsProps> = ({
  anchorRef,
  query,
  searchMode,
  filterWorkspacePath,
  excludeWorkspacePaths,
  activeIndex,
  setActiveIndex,
  onClose,
}) => {
  const { t } = useI18n('common');
  const { openedWorkspacesList, setActiveWorkspace } = useWorkspaceContext();

  const workspaces = useMemo(() => {
    let list = openedWorkspacesList;
    if (filterWorkspacePath) {
      const normalized = filterWorkspacePath.replace(/[/\\]+$/, '').toLowerCase();
      list = list.filter(w =>
        w.rootPath.replace(/[/\\]+$/, '').toLowerCase() === normalized
      );
    }
    if (excludeWorkspacePaths && excludeWorkspacePaths.length > 0) {
      const normalizedExcludes = excludeWorkspacePaths.map(p => p.replace(/[/\\]+$/, '').toLowerCase());
      list = list.filter(w =>
        !normalizedExcludes.includes(w.rootPath.replace(/[/\\]+$/, '').toLowerCase())
      );
    }
    return list;
  }, [openedWorkspacesList, filterWorkspacePath, excludeWorkspacePaths]);
  const listRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);


  const results = useMemo((): SearchResultItem[] => {
    const items: SearchResultItem[] = [];
    const q = query.trim();
    const showWorkspaces = searchMode === 'all';

    if (!q) {
      if (showWorkspaces) {
        for (const w of workspaces.slice(0, MAX_PER_GROUP)) {
          items.push({ kind: 'workspace', id: w.id, label: w.name, sublabel: w.rootPath });
        }
      }
      return items;
    }

    if (showWorkspaces) {
      const filteredWorkspaces = workspaces
        .filter(w => matchesQuery(q, w.name, w.rootPath))
        .slice(0, MAX_PER_GROUP);
      for (const w of filteredWorkspaces) {
        items.push({ kind: 'workspace', id: w.id, label: w.name, sublabel: w.rootPath });
      }
    }

    return items;
  }, [
    query,
    workspaces,
    searchMode,
  ]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLButtonElement>('.ai00-x-nav-search-dialog__item--active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // Compute position anchored to the search input
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    const anchor = anchorRef.current;
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      setPanelStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        width: Math.max(rect.width, 420),
      });
    }
  }, [anchorRef]);

  const handleSelect = useCallback(async (item: SearchResultItem) => {
    onClose();
    if (item.kind === 'workspace') {
      await setActiveWorkspace(item.id);
    }
  }, [onClose, setActiveWorkspace]);

  const workspaceItems = results.filter(r => r.kind === 'workspace');

  let globalIndex = 0;
  const renderGroup = (
    groupLabel: string,
    items: SearchResultItem[],
    icon: (item: SearchResultItem) => React.ReactNode
  ) => {
    if (items.length === 0) return null;
    const startIndex = globalIndex;
    globalIndex += items.length;
    return (
      <div className="ai00-x-nav-search-dialog__group" key={groupLabel}>
        <div className="ai00-x-nav-search-dialog__group-label">{groupLabel}</div>
        {items.map((item, i) => {
          const idx = startIndex + i;
          return (
            <button
              key={item.id}
              type="button"
              className={`ai00-x-nav-search-dialog__item${idx === activeIndex ? ' ai00-x-nav-search-dialog__item--active' : ''}`}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => void handleSelect(item)}
            >
              <span className="ai00-x-nav-search-dialog__item-icon">{icon(item)}</span>
              <span className="ai00-x-nav-search-dialog__item-content">
                <span className="ai00-x-nav-search-dialog__item-label">{item.label}</span>
                {item.sublabel && (
                  <span className="ai00-x-nav-search-dialog__item-sublabel">{item.sublabel}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  const portalContainer = usePortalContainer();
  const portalTarget = portalContainer ?? document.body;

  return createPortal(
    <div className="ai00-x-nav-search-dialog__results-panel" ref={cardRef} style={panelStyle}>
      <div className="ai00-x-nav-search-dialog__results" ref={listRef}>
        {results.length === 0 ? (
          <div className="ai00-x-nav-search-dialog__empty">{t('nav.search.empty')}</div>
        ) : (
          renderGroup(t('nav.search.groupWorkspaces'), workspaceItems, () => <FolderOpen size={14} />)
        )}
      </div>
    </div>,
    portalTarget
  );
};

export default NavSearchResults;
