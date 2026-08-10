import ReactDOM from "react-dom/client";
import { createLogger, initLogger, bootstrapLogger } from './shared/utils/logger';
import "./app/styles/index.scss";
import { initializeFrontendLogLevelSync } from './infrastructure/config/services/FrontendLogLevelSync';
import { registerDefaultContextTypes } from './shared/context-system/core/registerDefaultTypes';
import { initRecommendationProviders } from './flow_chat/components/smart-recommendations';
import { themeService } from './infrastructure/theme';
import { settingsSyncService } from './infrastructure/services/infra/SettingsSyncService';
import { I18nProvider } from './infrastructure/i18n';
import { WorkspaceProvider } from './infrastructure/contexts/WorkspaceProvider';
import { ChatProvider } from './infrastructure';
import { ViewModeProvider } from './infrastructure/contexts/ViewModeProvider';
import { SSHRemoteProvider } from './features/ssh-remote';
import ChatWindowApp from './app/ChatWindowApp';
import AppErrorBoundary from './app/components/AppErrorBoundary';

bootstrapLogger();
const log = createLogger('ChatWindow');

async function startChatWindow(): Promise<void> {
  // 1. logger 必须最先初始化（其他模块依赖日志）
  await initLogger();

  log.info('Initializing Ai00-X Chat Window');

  // 2. 并行执行独立的异步初始化
  await Promise.all([
    initializeFrontendLogLevelSync(),
    themeService.initialize(),
  ]);

  // 3. 同步注册（快，无需 await）
  registerDefaultContextTypes();
  initRecommendationProviders();
  settingsSyncService.start();

  log.info('Theme system initialized');
  log.info('Settings sync started');

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sessionId') || undefined;
  const openSettings = params.get('openSettings') === '1';

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <AppErrorBoundary>
      <I18nProvider>
        <WorkspaceProvider>
          <ChatProvider>
            <ViewModeProvider defaultMode="coder">
              <SSHRemoteProvider>
                <ChatWindowApp sessionId={sessionId} openSettings={openSettings} />
              </SSHRemoteProvider>
            </ViewModeProvider>
          </ChatProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </AppErrorBoundary>
  );

  // 并行执行非关键初始化
  Promise.allSettled([
    import('./infrastructure/config').then(({ configManager }) =>
      configManager.getConfig('editor')
    ),
    import('./infrastructure/api/service-api/MCPAPI').then(({ MCPAPI }) =>
      MCPAPI.initializeServers()
    ),
    import('./infrastructure/self-control').then(({ startSelfControlEventListener }) => {
      startSelfControlEventListener();
    }),
  ]).then((results) => {
    const reasons = ['editor config', 'MCP servers', 'self-control listener'];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        log.warn(`Failed to initialize ${reasons[i]}`, r.reason);
      }
    });
    log.info('Chat window post-render init done');
  });

  log.info('Chat window started successfully');
}

void startChatWindow();
