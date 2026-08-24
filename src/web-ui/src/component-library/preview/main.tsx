/**
 * Component preview entry
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { PreviewApp } from './PreviewApp';
import { I18nProvider } from '@/infrastructure/i18n';
import { WorkspaceProvider } from '@/infrastructure/contexts/WorkspaceProvider';
import { themeService } from '@/infrastructure/theme';
import { ToastProvider } from '@/component-library';
import './preview.css';

import '../../app/styles/index.scss';

void themeService.initialize();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <WorkspaceProvider>
        <ToastProvider />
        <PreviewApp />
      </WorkspaceProvider>
    </I18nProvider>
  </React.StrictMode>
);
