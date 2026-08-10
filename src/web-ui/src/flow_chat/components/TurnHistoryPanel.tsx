import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { snapshotAPI } from '@/infrastructure/api';
import type { TurnSnapshot } from '@/infrastructure/api/service-api/SnapshotAPI';
import { TurnRollbackButton } from './TurnRollbackButton';
import { createLogger } from '@/shared/utils/logger';
import './TurnHistoryPanel.scss';

const log = createLogger('TurnHistoryPanel');

interface TurnHistoryPanelProps {
  sessionId: string;
}

/**
 * Turn history panel.
 * Shows all turns in the current session and allows rollback.
 */
export const TurnHistoryPanel: React.FC<TurnHistoryPanelProps> = ({ sessionId }) => {
  const { t } = useTranslation('flow-chat');
  const [turns, setTurns] = useState<TurnSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentTurnIndex, setCurrentTurnIndex] = useState<number>(-1);

  const loadTurns = useCallback(async () => {
    if (!sessionId) return;
    
    setLoading(true);
    try {
      const turnList = await snapshotAPI.getSessionTurnSnapshots(sessionId);
      setTurns(turnList);
      setCurrentTurnIndex(turnList.length > 0 ? turnList.length - 1 : -1);
    } catch (error) {
      log.error('Failed to load turn snapshots', { sessionId, error });
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadTurns();
  }, [loadTurns]);

  const handleRollbackComplete = () => {
    void loadTurns();
  };

  if (loading) {
    return <div className="turn-history-panel-loading">{t('turnHistory.loading')}</div>;
  }

  if (turns.length === 0) {
    return (
      <div className="turn-history-panel-empty">
        <p>{t('turnHistory.noHistory')}</p>
        <p className="hint">{t('turnHistory.snapshotHint')}</p>
      </div>
    );
  }

  return (
    <div className="turn-history-panel">
      <div className="turn-history-header">
        <h3>{t('turnHistory.title')}</h3>
        <span className="turn-count">{t('turnHistory.turnsCount', { count: turns.length })}</span>
      </div>

      <div className="turn-history-list">
        {turns.map((turn, index) => (
          <div 
            key={`${turn.sessionId}-${turn.turnIndex}`} 
            className={`turn-history-item ${index === currentTurnIndex ? 'current' : ''}`}
          >
            <div className="turn-item-header">
              <span className="turn-index">{t('turnHistory.turnIndex', { index: index + 1 })}</span>
              <TurnRollbackButton
                sessionId={turn.sessionId}
                turnIndex={turn.turnIndex}
                isCurrent={index === currentTurnIndex}
                onRollbackComplete={handleRollbackComplete}
              />
            </div>
            
            {turn.modifiedFiles.length > 0 && (
              <div className="turn-item-files">
                <span className="files-label">{t('turnHistory.modifiedFiles')}</span>
                <ul className="files-list">
                  {turn.modifiedFiles.slice(0, 3).map((file: string, fileIndex: number) => (
                    <li key={fileIndex} className="file-item">{file}</li>
                  ))}
                  {turn.modifiedFiles.length > 3 && (
                    <li className="file-item-more">
                      {t('turnHistory.moreFiles', { count: turn.modifiedFiles.length - 3 })}
                    </li>
                  )}
                </ul>
              </div>
            )}

            <div className="turn-item-time">
              {new Date(turn.timestamp * 1000).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
