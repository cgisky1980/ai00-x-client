import React from 'react';
import { useNurseryStore } from '../nurseryStore';
import TemplateConfigPage from './TemplateConfigPage';
import './NurseryView.scss';

const NurseryView: React.FC = () => {
  const { page } = useNurseryStore();

  if (page === 'template') {
    return <TemplateConfigPage />;
  }

  return <TemplateConfigPage />;
};

export default NurseryView;
