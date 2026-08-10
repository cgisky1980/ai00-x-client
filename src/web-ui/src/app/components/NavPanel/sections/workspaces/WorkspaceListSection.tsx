import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { notificationService } from '@/shared/notification-system';
import { useModeStore } from '@/app/stores/modeStore';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import WorkspaceItem from './WorkspaceItem';
import './WorkspaceListSection.scss';

interface WorkspaceListSectionProps {
  variant: 'projects';
}

type WorkspaceDragPosition = 'before' | 'after';

interface WorkspaceDragPayload {
  workspaceId: string;
  variant: 'projects';
}

const WORKSPACE_DRAG_MIME_TYPE = 'application/x-ai00-x-workspace';


const WorkspaceListSection: React.FC<WorkspaceListSectionProps> = ({ variant }) => {
  const { t } = useI18n('common');
  const {
    openedWorkspacesList,
    normalWorkspacesList,
    activeWorkspaceId,
    reorderOpenedWorkspacesInSection,
  } = useWorkspaceContext();
  const activeMode = useModeStore(s => s.activeMode);
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    workspaceId: string;
    position: WorkspaceDragPosition;
  } | null>(null);

  const draggedWorkspaceIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<{ workspaceId: string; position: WorkspaceDragPosition } | null>(null);

  // In code mode, filter out task workspaces; in task mode, only show task workspace
  const [taskWorkspacePath, setTaskWorkspacePath] = useState<string | null>(null);
  React.useEffect(() => {
    if (activeMode === 'code' || activeMode === 'task') {
      globalAPI.getTaskWorkspacePath().then(setTaskWorkspacePath).catch(() => {});
    }
  }, [activeMode]);

  const workspaces = useMemo(() => {
    const base = normalWorkspacesList;
    if (!taskWorkspacePath) return base;
    // Normalize paths for comparison (handle trailing slashes and case on Windows)
    const normalizedTaskPath = taskWorkspacePath.replace(/[/\\]+$/, '').toLowerCase();
    if (activeMode === 'code') {
      return base.filter(ws => ws.rootPath.replace(/[/\\]+$/, '').toLowerCase() !== normalizedTaskPath);
    }
    if (activeMode === 'task') {
      return base.filter(ws => ws.rootPath.replace(/[/\\]+$/, '').toLowerCase() === normalizedTaskPath);
    }
    return base;
  }, [normalWorkspacesList, activeMode, taskWorkspacePath]);

  const emptyLabel = t('nav.workspaces.emptyProjects');

  const handleDragStart = useCallback((workspaceId: string) => (event: React.DragEvent<HTMLDivElement>) => {
    const payload: WorkspaceDragPayload = { workspaceId, variant };
    const serializedPayload = JSON.stringify(payload);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(WORKSPACE_DRAG_MIME_TYPE, serializedPayload);
    event.dataTransfer.setData('text/plain', serializedPayload);
    draggedWorkspaceIdRef.current = workspaceId;
    setDraggedWorkspaceId(workspaceId);
  }, [variant]);

  const handleDragEnd = useCallback(() => {
    draggedWorkspaceIdRef.current = null;
    dropTargetRef.current = null;
    setDraggedWorkspaceId(null);
    setDropTarget(null);
  }, []);

  const handleDragOver = useCallback((workspaceId: string) => (event: React.DragEvent<HTMLDivElement>) => {
    const isWorkspaceDrag = event.dataTransfer.types.includes(WORKSPACE_DRAG_MIME_TYPE);
    const currentDraggedId = draggedWorkspaceIdRef.current;

    if (!isWorkspaceDrag || !currentDraggedId || currentDraggedId === workspaceId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';

    const itemEl = event.currentTarget.querySelector<HTMLElement>(
      '.ai00-x-nav-panel__workspace-item'
    );
    const rect = itemEl
      ? itemEl.getBoundingClientRect()
      : event.currentTarget.getBoundingClientRect();

    const position: WorkspaceDragPosition = event.clientY >= rect.top + rect.height / 2
      ? 'after'
      : 'before';

    setDropTarget(current => {
      if (current?.workspaceId === workspaceId && current.position === position) {
        return current;
      }
      const next = { workspaceId, position };
      dropTargetRef.current = next;
      return next;
    });
  }, []);

  const handleDragLeave = useCallback((workspaceId: string) => (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropTarget(current => {
        if (current?.workspaceId !== workspaceId) return current;
        dropTargetRef.current = null;
        return null;
      });
    }
  }, []);

  const handleDrop = useCallback((workspaceId: string) => async (event: React.DragEvent<HTMLDivElement>) => {
    const payloadText =
      event.dataTransfer.getData(WORKSPACE_DRAG_MIME_TYPE) ||
      event.dataTransfer.getData('text/plain');

    if (!payloadText) return;

    let payload: WorkspaceDragPayload;
    try {
      payload = JSON.parse(payloadText) as WorkspaceDragPayload;
    } catch {
      return;
    }

    if (!payload.workspaceId || payload.variant !== variant) return;

    event.preventDefault();
    event.stopPropagation();

    const position =
      dropTargetRef.current?.workspaceId === workspaceId
        ? dropTargetRef.current.position
        : 'after';

    draggedWorkspaceIdRef.current = null;
    dropTargetRef.current = null;
    setDropTarget(null);

    try {
      await reorderOpenedWorkspacesInSection(variant, payload.workspaceId, workspaceId, position);
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.reorderFailed'),
        { duration: 4000 }
      );
    } finally {
      setDraggedWorkspaceId(null);
    }
  }, [reorderOpenedWorkspacesInSection, t, variant]);

  return (
    <div className={`ai00-x-nav-panel__workspace-list${draggedWorkspaceId ? ' is-dragging' : ''}`}>
      {workspaces.length === 0 ? (
        <div className="ai00-x-nav-panel__workspace-list-empty">
          {emptyLabel}
        </div>
      ) : (
        workspaces.map(workspace => (
          <div
            key={workspace.id}
            className={[
              'ai00-x-nav-panel__workspace-drop-target',
              draggedWorkspaceId && draggedWorkspaceId !== workspace.id && 'is-drag-active',
              dropTarget?.workspaceId === workspace.id && 'is-drop-target',
              dropTarget?.workspaceId === workspace.id && dropTarget.position === 'before' && 'is-before',
              dropTarget?.workspaceId === workspace.id && dropTarget.position === 'after' && 'is-after',
            ].filter(Boolean).join(' ')}
            onDragOver={handleDragOver(workspace.id)}
            onDragLeave={handleDragLeave(workspace.id)}
            onDrop={(event) => { void handleDrop(workspace.id)(event); }}
          >
            {dropTarget?.workspaceId === workspace.id && dropTarget.position === 'before' ? (
              <div className="ai00-x-nav-panel__workspace-drop-line" aria-hidden="true" />
            ) : null}
            <WorkspaceItem
              workspace={workspace}
              isActive={workspace.id === activeWorkspaceId}
              isSingle={openedWorkspacesList.length === 1}
              draggable={workspaces.length > 1}
              isDragging={draggedWorkspaceId === workspace.id}
              onDragStart={handleDragStart(workspace.id)}
              onDragEnd={handleDragEnd}
            />
            {dropTarget?.workspaceId === workspace.id && dropTarget.position === 'after' ? (
              <div className="ai00-x-nav-panel__workspace-drop-line" aria-hidden="true" />
            ) : null}
          </div>
        ))
      )}
    </div>
  );
};

export default WorkspaceListSection;
