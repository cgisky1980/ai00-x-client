import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalContainer } from '@/infrastructure/contexts/PortalContainerContext';
import { FolderOpen, MessageSquare } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { findWorkspaceForSession } from '@/flow_chat/utils/workspaceScope';
import { openMainSession } from '@/flow_chat/services/sessionNavigation';
import type { FlowChatState, Session } from '@/flow_chat/types/flow-chat';
import type { SessionMetadata } from '@/shared/types/session-history';
import type { WorkspaceInfo } from '@/shared/types';
import { sessionAPI } from '@/infrastructure/api';
import './NavSearchDialog.scss';

type ResultKind = 'workspace' | 'session';

interface SearchResultItem {
  kind: ResultKind;
  id: string;
  label: string;
  sublabel?: string;
  workspaceId?: string;
}

const MAX_PER_GROUP = 20;

const getTitle = (session: Session): string =>
  session.title?.trim() || `Task ${session.sessionId.slice(0, 6)}`;

const sessionRecencyTime = (session: Session): number =>
  session.updatedAt ?? session.lastActiveAt ?? session.createdAt ?? 0;

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
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() => flowChatStore.getState());
  const [persistedOpenWorkspaceSessions, setPersistedOpenWorkspaceSessions] = useState<
    Array<{ meta: SessionMetadata; workspace: WorkspaceInfo }>
  >([]);
  const listRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = flowChatStore.subscribe(s => setFlowChatState(s));
    return () => unsub();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows: Array<{ meta: SessionMetadata; workspace: WorkspaceInfo }> = [];
        for (const w of workspaces) {
          const list = await sessionAPI.listSessions(
            w.rootPath,
            w.connectionId ?? undefined,
            w.sshHost ?? undefined
          );
          for (const meta of list) {
            rows.push({ meta, workspace: w });
          }
        }
        if (!cancelled) {
          setPersistedOpenWorkspaceSessions(rows);
        }
      } catch {
        if (!cancelled) {
          setPersistedOpenWorkspaceSessions([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaces]);

  const openedWorkspaceIdSet = useMemo(
    () => new Set(workspaces.map(w => w.id)),
    [workspaces]
  );

  const sessionsInOpenedWorkspaces = useMemo((): Array<{ session: Session; workspace: WorkspaceInfo }> => {
    const result: Array<{ session: Session; workspace: WorkspaceInfo }> = [];
    for (const session of flowChatState.sessions.values()) {
      const workspace = findWorkspaceForSession(session, workspaces);
      if (workspace && openedWorkspaceIdSet.has(workspace.id)) {
        result.push({ session, workspace });
      }
    }
    result.sort((a, b) => sessionRecencyTime(b.session) - sessionRecencyTime(a.session));
    return result;
  }, [flowChatState.sessions, workspaces, openedWorkspaceIdSet]);

  const mainLineSessionsOpen = useMemo(
    () => sessionsInOpenedWorkspaces,
    [sessionsInOpenedWorkspaces]
  );

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

    const storeMatches = mainLineSessionsOpen.filter(({ session }) =>
      matchesQuery(q, getTitle(session), session.sessionId)
    );
    const storeIds = new Set(storeMatches.map(({ session }) => session.sessionId));

    const diskMatches = persistedOpenWorkspaceSessions.filter(({ meta, workspace }) => {
      if (!openedWorkspaceIdSet.has(workspace.id)) return false;
      const label = meta.sessionName?.trim() || `Task ${meta.sessionId.slice(0, 6)}`;
      if (!matchesQuery(q, label, meta.sessionId)) return false;
      return !storeIds.has(meta.sessionId);
    });

    const merged: Array<{ session: Session; workspace: WorkspaceInfo } | { disk: SessionMetadata; workspace: WorkspaceInfo }> = [
      ...storeMatches.map(({ session, workspace }) => ({ session, workspace })),
      ...diskMatches.map(({ meta, workspace }) => ({ disk: meta, workspace })),
    ];
    merged.sort((a, b) => {
      const ta =
        'session' in a
          ? sessionRecencyTime(a.session)
          : a.disk.lastActiveAt ?? a.disk.createdAt ?? 0;
      const tb =
        'session' in b
          ? sessionRecencyTime(b.session)
          : b.disk.lastActiveAt ?? b.disk.createdAt ?? 0;
      return tb - ta;
    });

    for (const entry of merged.slice(0, MAX_PER_GROUP)) {
      if ('session' in entry) {
        const { session, workspace } = entry;
        items.push({
          kind: 'session',
          id: session.sessionId,
          label: getTitle(session),
          sublabel: t('nav.search.sessionWorkspaceHint', { workspace: workspace.name }),
          workspaceId: workspace.id,
        });
      } else {
        const { disk: meta, workspace } = entry;
        items.push({
          kind: 'session',
          id: meta.sessionId,
          label: meta.sessionName?.trim() || `Task ${meta.sessionId.slice(0, 6)}`,
          sublabel: t('nav.search.sessionWorkspaceHint', { workspace: workspace.name }),
          workspaceId: workspace.id,
        });
      }
    }

    return items;
  }, [
    query,
    workspaces,
    mainLineSessionsOpen,
    persistedOpenWorkspaceSessions,
    openedWorkspaceIdSet,
    t,
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
    } else if (item.kind === 'session') {
      await openMainSession(item.id, {
        workspaceId: item.workspaceId,
        activateWorkspace: item.workspaceId ? setActiveWorkspace : undefined,
      });
    }
  }, [onClose, setActiveWorkspace]);

  const workspaceItems = results.filter(r => r.kind === 'workspace');
  const sessionItems = results.filter(r => r.kind === 'session');
  const queryTrimmed = query.trim();
  const showDefaultSessionColumn = !queryTrimmed;

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
        {results.length === 0 && !showDefaultSessionColumn ? (
          <div className="ai00-x-nav-search-dialog__empty">{t('nav.search.empty')}</div>
        ) : (
          <>
            {renderGroup(t('nav.search.groupWorkspaces'), workspaceItems, () => <FolderOpen size={14} />)}
            {showDefaultSessionColumn ? (
              <div className="ai00-x-nav-search-dialog__group" key="nav-search-sessions-default">
                <div className="ai00-x-nav-search-dialog__group-label">{t('nav.search.groupSessions')}</div>
                <div className="ai00-x-nav-search-dialog__session-hint" role="status">
                  {t('nav.search.sessionSearchHintDefault')}
                </div>
              </div>
            ) : (
              renderGroup(t('nav.search.groupSessions'), sessionItems, () => <MessageSquare size={14} />)
            )}
          </>
        )}
      </div>
    </div>,
    portalTarget
  );
};

export default NavSearchResults;
