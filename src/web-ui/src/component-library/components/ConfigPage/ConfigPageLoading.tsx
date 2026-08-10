import React from 'react';
import './ConfigPage.scss';

export interface ConfigPageLoadingProps {
  text: string;
  className?: string;
}

export const ConfigPageLoading: React.FC<ConfigPageLoadingProps> = ({
  text,
  className = '',
}) => {
  return (
    <div className={`ai00-x-config-page-loading ${className}`}>
      {text}
    </div>
  );
};

