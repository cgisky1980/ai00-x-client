import ReactDOM from "react-dom/client";
import { createLogger, initLogger, bootstrapLogger } from './shared/utils/logger';
import "./app/styles/index.scss";

bootstrapLogger();
const log = createLogger('MemberChatWindow');

async function startMemberChatWindow(): Promise<void> {
  await initLogger();

  const { initializeFrontendLogLevelSync } = await import('./infrastructure/config/services/FrontendLogLevelSync');
  await initializeFrontendLogLevelSync();

  log.info('Initializing Ai00-X Member Chat Window');

  const { themeService } = await import('./infrastructure/theme');
  await themeService.initialize();
  log.info('Theme system initialized');

  const { I18nProvider } = await import('./infrastructure/i18n');
  const AppErrorBoundary = (await import('./app/components/AppErrorBoundary')).default;
  const MemberChatApp = (await import('./app/MemberChatApp')).default;

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <AppErrorBoundary>
      <I18nProvider>
        <MemberChatApp />
      </I18nProvider>
    </AppErrorBoundary>
  );

  log.info('Member chat window started successfully');
}

void startMemberChatWindow();
