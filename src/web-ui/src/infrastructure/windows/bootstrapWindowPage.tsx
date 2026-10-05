/**
 * bootstrapWindowPage — 独立窗口页面的统一启动样板。
 *
 * 背景：每个非主窗口的 entry 原先都要逐字重复同一套启动序列（日志 → 原生弹窗接管 →
 * 主题 → 跨窗口设置同步 → themeStore 引导 → 渲染 + 错误边界）。抽到这里后，
 * 新增一个窗口的 entry 只需 5 行：
 *
 * ```tsx
 * import { bootstrapWindowPage } from './infrastructure/windows/bootstrapWindowPage';
 * void bootstrapWindowPage({ name: 'TodoWindow', load: () => import('./app/TodoWindowApp') });
 * ```
 *
 * 顺序有讲究，不要随意调整：
 * 1. `bootstrapLogger()` 必须最先，`createLogger` 依赖它；
 * 2. `installDialogShim()` 要在任何 UI 渲染前装上，否则窗口内会漏出系统原生
 *    confirm/prompt/alert；
 * 3. `settingsSyncService.start()` 不调用则本窗口不跟随主应用切主题/语言；
 * 4. `useThemeStore.initialize()` 是幂等引导——省略它，直接读 store 的组件会拿到
 *    null 主题（例如 Vditor 会一直用亮色皮肤，直到用户碰过设置页才自愈）。
 */
import type { ComponentType, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { bootstrapLogger, createLogger, initLogger } from '../../shared/utils/logger';
import { installDialogShim } from '../dialog-shim';
import '../../app/styles/index.scss';
// 设计系统 token 层紧随全局样式之后加载：:root 暗档 + [data-theme-type] 亮档覆盖
// 必须赢在级联顺序上（此前乐窗口打包顺序颠倒，Select 边框/滑轨等墨阶变量整体失效）
import '@ai00-x/design-system/styles.css';

export interface WindowPageOptions {
  /** 日志标签（如 'TodoWindow'） */
  name: string;
  /** 窗口根组件（懒加载，保持各窗口 chunk 独立） */
  load: () => Promise<{ default: ComponentType<Record<string, unknown>> }>;
  /** 传给根组件的 props */
  props?: Record<string, unknown>;
  /**
   * 是否挂载 ToastProvider（默认 true）。
   *
   * 若该窗口的提示统一由常驻的 overlay 窗口弹出（避免同一事件弹两次），置 false。
   * `ConfirmDialogRenderer` 始终挂载——它接管原生 confirm/prompt，与 toast 无关。
   */
  toast?: boolean;
  /**
   * 自绘标题栏（WindowTitleBar）。仅适用于注册表里 `decorations:false`
   * 的无边框窗口；传入后 Root 渲染在标题栏下方的内容区，不再占满整窗。
   */
  titleBar?: { title: string; /** 标题后跟随的左侧元信息（如 Lv/积分） */ leading?: ReactNode; actions?: ReactNode };
}

export async function bootstrapWindowPage(options: WindowPageOptions): Promise<void> {
  const { name, load, props, toast = true, titleBar } = options;

  bootstrapLogger();
  installDialogShim();
  const log = createLogger(name);

  await initLogger();

  const { initializeFrontendLogLevelSync } = await import(
    '../config/services/FrontendLogLevelSync'
  );
  await initializeFrontendLogLevelSync();

  log.info(`Initializing ${name}`);

  const { themeService } = await import('../theme');
  await themeService.initialize();

  const { settingsSyncService } = await import('../services/infra/SettingsSyncService');
  settingsSyncService.start();

  const { useThemeStore } = await import('../theme/store/themeStore');
  await useThemeStore.getState().initialize();

  const { I18nProvider } = await import('../i18n');
  const { ToastProvider, ConfirmDialogRenderer } = await import('@/component-library');
  const AppErrorBoundary = (await import('../../app/components/AppErrorBoundary')).default;
  const Root = (await load()).default;

  // titleBar 模式：Root 包进自绘标题栏 shell（children = 窗口内容）
  let content: ReactNode = <Root {...(props ?? {})} />;
  if (titleBar) {
    const { WindowTitleBar } = await import('./WindowTitleBar');
    content = (
      <WindowTitleBar title={titleBar.title} leading={titleBar.leading} actions={titleBar.actions}>
        {content}
      </WindowTitleBar>
    );
  }

  const container = document.getElementById('root');
  if (!container) {
    throw new Error(`${name}: #root element not found`);
  }

  ReactDOM.createRoot(container).render(
    <AppErrorBoundary>
      <I18nProvider>
        {toast && <ToastProvider />}
        {content}
        <ConfirmDialogRenderer />
      </I18nProvider>
    </AppErrorBoundary>
  );

  log.info(`${name} started successfully`);
}
