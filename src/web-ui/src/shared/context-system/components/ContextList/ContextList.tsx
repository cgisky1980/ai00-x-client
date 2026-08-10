 

import React, { useCallback } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { useContextStore, selectContexts } from '../../../stores/contextStore';
import { ContextCard } from '../ContextCard/ContextCard';
import { useI18n } from '@/infrastructure/i18n';
import './ContextList.scss';

export interface ContextListProps {
  compact?: boolean;
  interactive?: boolean;
  showPreview?: boolean;
  maxHeight?: string;
  className?: string;
  onContextClick?: (contextId: string) => void;
}

export const ContextList: React.FC<ContextListProps> = ({
  compact = false,
  interactive = true,
  showPreview = true,
  maxHeight = '200px',
  className = '',
  onContextClick
}) => {
  const { t } = useI18n('components');
  const contexts = useContextStore(selectContexts);
  const removeContext = useContextStore(state => state.removeContext);
  const clearContexts = useContextStore(state => state.clearContexts);
  
  const handleRemove = useCallback((id: string) => {
    removeContext(id);
  }, [removeContext]);
  
  const handleClearAll = useCallback(async () => {
    
    if (await window.confirm(t('contextSystem.contextList.clearAllConfirm', { count: contexts.length }))) {
      clearContexts();
    }
  }, [contexts.length, clearContexts, t]);
  
  const handleCardClick = useCallback((contextId: string) => {
    onContextClick?.(contextId);
  }, [onContextClick]);
  
  if (contexts.length === 0) {
    return (
      <div className={`ai00-x-context-list ai00-x-context-list--empty ${className}`}>
        <div className="ai00-x-context-list__empty-state">
          <AlertCircle size={24} className="ai00-x-context-list__empty-icon" />
          <p className="ai00-x-context-list__empty-text">
            {t('contextSystem.contextList.emptyTitle')}
          </p>
          <p className="ai00-x-context-list__empty-hint">
            {t('contextSystem.contextList.emptyHint')}
          </p>
        </div>
      </div>
    );
  }
  
  return (
    <div className={`ai00-x-context-list ${className}`}>
      
      <div className="ai00-x-context-list__header">
        <div className="ai00-x-context-list__title">
          {t('contextSystem.contextList.title')}
          <span className="ai00-x-context-list__count">
            {contexts.length}
          </span>
        </div>
        
        <button
          className="ai00-x-context-list__clear-btn"
          onClick={handleClearAll}
          title={t('contextSystem.contextList.clearAllTitle')}
        >
          <X size={14} />
          <span>{t('contextSystem.contextList.clearAll')}</span>
        </button>
      </div>
      
      
      <div 
        className="ai00-x-context-list__items"
        style={{ maxHeight }}
      >
        {contexts.map((context) => (
          <div
            key={context.id}
            className="ai00-x-context-list__item"
            onClick={() => handleCardClick(context.id)}
          >
            <ContextCard
              context={context}
              onRemove={handleRemove}
              compact={compact}
              interactive={interactive}
              showPreview={showPreview}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default ContextList;

