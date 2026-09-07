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

  // 跨窗口设置同步：监听主窗口的 theme:changed / language:changed 广播（不 start 则本窗口不跟随主应用切主题）
  const { settingsSyncService } = await import('./infrastructure/services/infra/SettingsSyncService');
  settingsSyncService.start();

  // 引导 themeStore（幂等）：否则 CommunityMDEditor 等直接读 store 的组件拿到 null 主题，
  // Vditor 会一直用亮色皮肤，直到用户碰过设置页才自愈
  const { useThemeStore } = await import('./infrastructure/theme/store/themeStore');
  await useThemeStore.getState().initialize();

  const { I18nProvider } = await import('./infrastructure/i18n');
  const { ToastProvider, ConfirmDialogRenderer } = await import('@/component-library');
  const AppErrorBoundary = (await import('./app/components/AppErrorBoundary')).default;
  const MemberChatApp = (await import('./app/MemberChatApp')).default;

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <AppErrorBoundary>
      <I18nProvider>
        <ToastProvider />
        <MemberChatApp />
        <ConfirmDialogRenderer />
      </I18nProvider>
    </AppErrorBoundary>
  );

  log.info('Member chat window started successfully');
}

void startMemberChatWindow();
