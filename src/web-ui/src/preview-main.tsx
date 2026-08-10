import ReactDOM from "react-dom/client";
import { createLogger, initLogger, bootstrapLogger } from './shared/utils/logger';
import "./app/styles/index.scss";

bootstrapLogger();
const log = createLogger('PreviewWindow');

async function startPreviewWindow(): Promise<void> {
  await initLogger();

  const { initializeFrontendLogLevelSync } = await import('./infrastructure/config/services/FrontendLogLevelSync');
  await initializeFrontendLogLevelSync();

  log.info('Initializing Ai00-X Preview Window');

  const { themeService } = await import('./infrastructure/theme');
  await themeService.initialize();
  log.info('Theme system initialized');

  const { settingsSyncService } = await import('./infrastructure/services/infra/SettingsSyncService');
  settingsSyncService.start();
  log.info('Settings sync started');

  const { I18nProvider } = await import('./infrastructure/i18n');
  const AppErrorBoundary = (await import('./app/components/AppErrorBoundary')).default;

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') || 'wallpaper';
  const projectPath = params.get('projectPath') || undefined;

  let App: React.ComponentType<any>;
  if (mode === 'wallpaper') {
    App = (await import('./app/WallpaperPreviewApp')).default;
  } else {
    App = (await import('./app/WallpaperPreviewApp')).default;
  }

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <AppErrorBoundary>
      <I18nProvider>
        <App projectPath={projectPath} />
      </I18nProvider>
    </AppErrorBoundary>
  );

  log.info('Preview window started successfully', { mode });
}

void startPreviewWindow();
