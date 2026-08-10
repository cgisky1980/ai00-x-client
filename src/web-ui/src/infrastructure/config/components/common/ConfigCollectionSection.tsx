import React from 'react';
import { ConfigPageSection } from './ConfigPageLayout';
import './ConfigCollectionSection.scss';

export interface ConfigCollectionSectionProps {
  title: string;
  description?: string;
  toolbar?: React.ReactNode;
  filters?: React.ReactNode;
  editor?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export const ConfigCollectionSection: React.FC<ConfigCollectionSectionProps> = ({
  title,
  description,
  toolbar,
  filters,
  editor,
  className = '',
  children,
}) => {
  const hasEditor = Boolean(editor);

  return (
    <ConfigPageSection
      title={title}
      description={description}
      className={`ai00-x-config-collection-section ${hasEditor ? 'ai00-x-config-collection-section--with-editor' : ''} ${className}`}
    >
      <div className="ai00-x-config-collection-section__content">
        {toolbar && (
          <div className="ai00-x-config-collection-section__toolbar">
            {toolbar}
          </div>
        )}
        {editor && (
          <div className="ai00-x-config-collection-section__editor">
            {editor}
          </div>
        )}
        {filters && (
          <div className="ai00-x-config-collection-section__filters">
            {filters}
          </div>
        )}
        <div className="ai00-x-config-collection-section__list">
          {children}
        </div>
      </div>
    </ConfigPageSection>
  );
};

export default ConfigCollectionSection;
