import React, { useCallback, useMemo } from 'react';
import { getComponentCategories } from '../data/components';
import { MermaidComponent } from '../types';
import { useI18n } from '@/infrastructure/i18n';
import './MermaidComponentLibrary.css';

export interface MermaidComponentLibraryProps {
  onComponentSelect: (component: MermaidComponent) => void;
  className?: string;
}

export const MermaidComponentLibrary: React.FC<MermaidComponentLibraryProps> = ({
  onComponentSelect,
  className = ''
}) => {
  const { t } = useI18n('mermaid-editor');
  
  const componentCategories = useMemo(() => getComponentCategories(t), [t]);
  
  const handleComponentClick = useCallback((component: MermaidComponent) => {
    onComponentSelect(component);
  }, [onComponentSelect]);

  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, component: MermaidComponent) => {
    e.dataTransfer.setData('application/json', JSON.stringify(component));
    e.dataTransfer.effectAllowed = 'copy';
  }, []);

  return (
    <div className={`mermaid-component-library ${className}`}>
      <div className="library-header">
        <h4>{t('componentLibrary.title')}</h4>
      </div>
      
      <div className="library-content">
        {componentCategories.map((category) => (
          <div key={category.id} className="component-category">
            <h5 className="category-title">{category.name}</h5>
            
            <div className="component-grid">
              {category.components.map((component) => (
                <div
                  key={component.id}
                  className="component-item"
                  draggable
                  onDragStart={(e) => handleDragStart(e, component)}
                  onClick={() => handleComponentClick(component)}
                  title={component.description}
                >
                  <div className="component-preview">
                    <code>{component.code}</code>
                  </div>
                  <div className="component-info">
                    <span className="component-name">{component.name}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};