import React from 'react';
import { createPortal } from 'react-dom';
import { usePortalContainer } from '@/infrastructure/contexts/PortalContainerContext';
import { Check, ChevronDown } from 'lucide-react';
import { Tooltip } from '@ai00-x/design-system/web';
import { type WorkspaceInfo } from '@/shared/types';

interface ShellNavWorkspaceSwitcherProps {
  workspaceName?: string;
  hasMultipleWorkspaces: boolean;
  workspaceMenuOpen: boolean;
  workspaceMenuPosition: { top: number; left: number } | null;
  openedWorkspacesList: WorkspaceInfo[];
  activeWorkspaceId?: string;
  workspaceMenuRef: React.RefObject<HTMLDivElement | null>;
  workspaceTriggerRef: React.RefObject<HTMLButtonElement | null>;
  switchWorkspaceLabel: string;
  onToggle: () => void;
  onSelectWorkspace: (workspaceId: string) => Promise<void>;
}

function getWorkspaceDisplayName(workspace: WorkspaceInfo): string {
  return workspace.name;
}

const ShellNavWorkspaceSwitcher: React.FC<ShellNavWorkspaceSwitcherProps> = ({
  workspaceName,
  hasMultipleWorkspaces,
  workspaceMenuOpen,
  workspaceMenuPosition,
  openedWorkspacesList,
  activeWorkspaceId,
  workspaceMenuRef,
  workspaceTriggerRef,
  switchWorkspaceLabel,
  onToggle,
  onSelectWorkspace,
}) => {
  const portalContainer = usePortalContainer();
  const portalTarget = portalContainer ?? document.body;
  if (!workspaceName) {
    return null;
  }

  return (
    <div className="ai00-x-shell-nav__workspace-switcher">
      <Tooltip
        content={hasMultipleWorkspaces ? switchWorkspaceLabel : workspaceName}
        placement="bottom"
      >
        <button
          ref={workspaceTriggerRef}
          type="button"
          className={`ai00-x-shell-nav__workspace-trigger${workspaceMenuOpen ? ' is-active' : ''}${hasMultipleWorkspaces ? ' is-switchable' : ''}`}
          onClick={onToggle}
          aria-haspopup={hasMultipleWorkspaces ? 'menu' : undefined}
          aria-expanded={hasMultipleWorkspaces ? workspaceMenuOpen : undefined}
        >
          <span className="ai00-x-shell-nav__workspace-separator">/</span>
          <span className="ai00-x-shell-nav__workspace-name">{workspaceName}</span>
          {hasMultipleWorkspaces ? (
            <ChevronDown size={12} className="ai00-x-shell-nav__workspace-trigger-icon" />
          ) : null}
        </button>
      </Tooltip>

      {workspaceMenuOpen && hasMultipleWorkspaces && workspaceMenuPosition
        ? createPortal(
            <div
              ref={workspaceMenuRef}
              className="ai00-x-shell-nav__workspace-menu"
              data-no-penetrate
              role="menu"
              aria-label={switchWorkspaceLabel}
              style={{
                top: `${workspaceMenuPosition.top}px`,
                left: `${workspaceMenuPosition.left}px`,
              }}
            >
              {openedWorkspacesList.map((workspace) => {
                const isActive = workspace.id === activeWorkspaceId;
                const label = getWorkspaceDisplayName(workspace);

                return (
                  <Tooltip
                    key={workspace.id}
                    content={workspace.rootPath}
                    placement="right"
                    disabled={!workspace.rootPath}
                  >
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      className={`ai00-x-shell-nav__workspace-menu-item${isActive ? ' is-active' : ''}`}
                      onClick={() => { void onSelectWorkspace(workspace.id); }}
                    >
                      <span className="ai00-x-shell-nav__workspace-menu-check" aria-hidden="true">
                        {isActive ? <Check size={12} /> : null}
                      </span>
                      <span className="ai00-x-shell-nav__workspace-menu-text">{label}</span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>,
            portalTarget,
          )
        : null}
    </div>
  );
};

export default ShellNavWorkspaceSwitcher;
