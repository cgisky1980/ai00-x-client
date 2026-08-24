import React, { useState } from 'react';
import { FolderOpen, Clock, FileText, Code, Folder } from 'lucide-react';
import { useWorkspaceContext } from '../../../infrastructure/contexts/WorkspaceContext';
import { WorkspaceInfo, WorkspaceType } from '../../../shared/types';
import { Modal, Button } from '@/component-library';
import { i18nService, useI18n } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import { getRecentWorkspaceLineParts } from '@/shared/utils/recentWorkspaceDisplay';
import './WorkspaceManager.css';

const log = createLogger('WorkspaceManager');

interface WorkspaceManagerProps {
  isVisible: boolean;
  onClose: () => void;
  onWorkspaceSelect?: (workspace: WorkspaceInfo) => void;
  modalContainer?: HTMLElement;
}

const WorkspaceManager: React.FC<WorkspaceManagerProps> = ({
  isVisible,
  onClose,
  onWorkspaceSelect,
  modalContainer,
}) => {
  const {
    currentWorkspace,
    recentWorkspaces,
    loading,
    error,
    switchWorkspace,
    closeWorkspace,
    scanWorkspaceInfo
  } = useWorkspaceContext();

  const { t } = useI18n('common');
  const [scanning, setScanning] = useState(false);

  const getWorkspaceIcon = (workspace: WorkspaceInfo) => {
    const type = workspace.workspaceType;
    switch (type) {
      case WorkspaceType.SingleProject:
        return <Code size={16} />;
      case WorkspaceType.Documentation:
        return <FileText size={16} />;
      case WorkspaceType.MultiProject:
        return <Folder size={16} />;
      default:
        return <FolderOpen size={16} />;
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      return i18nService.formatDate(new Date(dateStr), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateStr;
    }
  };

  const handleWorkspaceSelect = async (workspace: WorkspaceInfo) => {
    try {
      await switchWorkspace(workspace);
      onWorkspaceSelect?.(workspace);
      onClose();
    } catch (err) {
      log.error('Failed to switch workspace', { workspaceId: workspace.id, error: err });
    }
  };

  const handleCloseWorkspace = async () => {
    try {
      await closeWorkspace();
    } catch (err) {
      log.error('Failed to close workspace', err);
    }
  };

  const handleScanWorkspace = async () => {
    try {
      setScanning(true);
      await scanWorkspaceInfo();
    } catch (err) {
      log.error('Failed to scan workspace', err);
    } finally {
      setScanning(false);
    }
  };

  return (
    <Modal
      isOpen={isVisible}
      onClose={onClose}
      title={t('workspace.title')}
      size="medium"
      container={modalContainer}
    >
      <div className="workspace-manager">
        {error && (
          <div className="error-message">
            <span>{t('workspace.error')}: {error}</span>
          </div>
        )}

        <div className="current-workspace-section">
          <h3>{t('workspace.currentWorkspace')}</h3>
          {currentWorkspace ? (
            <div className="workspace-card current">
              <div className="workspace-header">
                <div className="workspace-icon">
                  {getWorkspaceIcon(currentWorkspace)}
                </div>
                <div className="workspace-info">
                  <div className="workspace-name">{currentWorkspace.name}</div>
                  <div className="workspace-path">{currentWorkspace.rootPath}</div>
                  <div className="workspace-meta">
                    <span className="workspace-type">{currentWorkspace.workspaceType}</span>
                    {currentWorkspace.lastAccessed && (
                      <span className="workspace-time">
                        <Clock size={12} />
                        {formatDate(currentWorkspace.lastAccessed)}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="workspace-actions">
                <Button
                  variant="secondary"
                  size="small"
                  onClick={handleScanWorkspace}
                  disabled={scanning}
                >
                  {scanning ? t('workspace.scanning') : t('workspace.rescan')}
                </Button>
                <Button
                  variant="danger"
                  size="small"
                  onClick={handleCloseWorkspace}
                  disabled={loading}
                >
                  {t('workspace.closeWorkspace')}
                </Button>
              </div>

              {currentWorkspace.statistics && (
                <div className="workspace-stats">
                  <div className="stat-item">
                    <span className="stat-label">{t('workspace.files')}:</span>
                    <span className="stat-value">{currentWorkspace.statistics.totalFiles}</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">{t('workspace.lines')}:</span>
                    <span className="stat-value">{currentWorkspace.statistics.totalLines?.toLocaleString()}</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">{t('workspace.totalSize')}:</span>
                    <span className="stat-value">{(currentWorkspace.statistics.totalSize / 1024 / 1024).toFixed(2)} MB</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="no-workspace">
              <FolderOpen size={48} />
              <p>{t('workspace.noWorkspaceOpen')}</p>
            </div>
          )}
        </div>

        <div className="recent-workspaces-section">
          <h3>{t('workspace.recentWorkspaces')}</h3>
          {recentWorkspaces.length > 0 ? (
            <div className="workspace-list">
              {recentWorkspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className="workspace-card recent"
                  onClick={() => handleWorkspaceSelect(workspace)}
                >
                  <div className="workspace-header">
                    <div className="workspace-icon">
                      {getWorkspaceIcon(workspace)}
                    </div>
                    <div className="workspace-info">
                      <div className="workspace-name">
                        {(() => {
                          const { hostPrefix } = getRecentWorkspaceLineParts(workspace);
                          return (
                            <>
                              {hostPrefix ? (
                                <span className="workspace-name__ssh-host">{hostPrefix} · </span>
                              ) : null}
                              {workspace.name}
                            </>
                          );
                        })()}
                      </div>
                      <div className="workspace-path">{workspace.rootPath}</div>
                      <div className="workspace-meta">
                        <span className="workspace-type">{workspace.workspaceType}</span>
                        {workspace.lastAccessed && (
                          <span className="workspace-time">
                            <Clock size={12} />
                            {formatDate(workspace.lastAccessed)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="no-recent">
              <p>{t('workspace.noRecentWorkspaces')}</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default WorkspaceManager;
