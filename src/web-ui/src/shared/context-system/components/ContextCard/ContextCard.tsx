 

import React, { useMemo } from 'react';
import { X, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { ContextItem } from '../../../types/context';
import { contextRegistry } from '../../../services/ContextRegistry';
import { useContextStore, selectValidationState, selectIsValidating } from '../../../stores/contextStore';
import { useI18n } from '@/infrastructure/i18n';
import './ContextCard.scss';

export interface ContextCardProps {
  context: ContextItem;
  onRemove?: (id: string) => void;
  compact?: boolean;
  interactive?: boolean;
  showPreview?: boolean;
  className?: string;
}

export const ContextCard: React.FC<ContextCardProps> = ({
  context,
  onRemove,
  compact = false,
  interactive = true,
  showPreview = true,
  className = ''
}) => {
  const { t } = useI18n('components');
  
  const validationState = useContextStore(selectValidationState(context.id));
  const isValidating = useContextStore(selectIsValidating(context.id));
  
  
  const renderer = useMemo(() => {
    return contextRegistry.getRenderer(context.type);
  }, [context.type]);
  
  
  const definition = useMemo(() => {
    return contextRegistry.getDefinition(context.type);
  }, [context.type]);
  
  
  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove?.(context.id);
  };
  
  
  const content = renderer 
    ? renderer.render(context, { compact, interactive, showPreview })
    : (
      <div className="ai00-x-context-card__fallback">
        <div className="ai00-x-context-card__icon">
          <AlertCircle size={20} />
        </div>
        <div className="ai00-x-context-card__content">
          <div className="ai00-x-context-card__title">
            {t('contextSystem.contextCard.unknownType', { type: context.type })}
          </div>
        </div>
      </div>
    );
  
  
  const validationClass = validationState 
    ? validationState.valid 
      ? 'ai00-x-context-card--valid' 
      : 'ai00-x-context-card--invalid'
    : '';
  
  return (
    <div 
      className={`
        ai00-x-context-card
        ai00-x-context-card--${context.type}
        ${validationClass}
        ${compact ? 'ai00-x-context-card--compact' : ''}
        ${interactive ? 'ai00-x-context-card--interactive' : ''}
        ${className}
      `.trim()}
      data-context-id={context.id}
      data-context-type={context.type}
    >
      
      {definition && (
        <div 
          className="ai00-x-context-card__indicator"
          style={{ backgroundColor: definition.color }}
        />
      )}
      
      
      <div className="ai00-x-context-card__body">
        {content}
      </div>
      
      
      {interactive && (
        <div className="ai00-x-context-card__toolbar">
          
          <div className="ai00-x-context-card__validation">
            {isValidating ? (
              <Loader2 size={14} className="ai00-x-context-card__spinner" />
            ) : validationState ? (
              validationState.valid ? (
                <CheckCircle size={14} className="ai00-x-context-card__icon--success" />
              ) : (
                <span title={validationState.error}>
                  <AlertCircle 
                    size={14} 
                    className="ai00-x-context-card__icon--error"
                  />
                </span>
              )
            ) : null}
          </div>
          
          
          {onRemove && (
            <button
              className="ai00-x-context-card__remove-btn"
              onClick={handleRemove}
              title={t('contextSystem.contextCard.removeContext')}
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
      
      
      {validationState && !validationState.valid && validationState.error && (
        <div className="ai00-x-context-card__error">
          <AlertCircle size={12} />
          <span>{validationState.error}</span>
        </div>
      )}
      
      
      {validationState && validationState.valid && validationState.warnings && validationState.warnings.length > 0 && (
        <div className="ai00-x-context-card__warnings">
          {validationState.warnings.map((warning, idx) => (
            <div key={idx} className="ai00-x-context-card__warning">
              <AlertCircle size={12} />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ContextCard;
