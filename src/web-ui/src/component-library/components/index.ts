/**
 * Component exports
 *
 * 2026-08-23 物理迁移：29 个基础组件（Button/IconButton/Modal/Input/Select/
 * Tooltip/Tabs/WindowControls/ConfigPage…全套）已迁入 @ai00-x/design-system
 * 的 ./web 出口（props API 原样），此处 re-export——业务调用点零改动。
 * 本地仅保留 web-ui 应用组件（与运行时强耦合，按设计不属于共享包）：
 * Markdown（API/主题/Mermaid 服务）/ CodeEditor（monaco core）。
 */

// 包组件主体样式（.ds-btn 等，css/components.css）——所有消费组件的入口都经过
// 本 barrel，样式在此集中引入一次（包 sideEffects 已声明 *.css）。
import '@ai00-x/design-system/styles.css';

import { setComponentLabels } from '@ai00-x/design-system/web';
import { i18nService } from '@/infrastructure/i18n';

// 包组件文案接入 web-ui i18n：label key 'components.xxx' → i18next 'components:xxx'
// （动态 getter：语言切换后组件重渲染自动取新值；未注册语言时回退包内中文默认）
const LABEL_KEYS = [
  'tooltip.close', 'modal.close',
  'dialog.confirm.ok', 'dialog.confirm.cancel', 'dialog.prompt.placeholder',
  'inputDialog.emptyError',
  'numberInput.increase', 'numberInput.decrease',
  'search.placeholder', 'search.clear',
  'select.placeholder', 'select.search', 'select.emptyText',
  'select.customValueHint', 'select.selectAll', 'select.useCustomValue',
  'toast.close', 'empty.title',
  'drawer.close', 'pagination.label', 'pagination.previous', 'pagination.next',
] as const;

setComponentLabels(
  Object.fromEntries(
    LABEL_KEYS.map((k) => [`components.${k}`, () => i18nService.t(`components:${k}`)]),
  ),
);

// WindowControls 文案走 common 命名空间（原 useTranslation('common')）
setComponentLabels({
  'windowControls.minimize': () => i18nService.t('common:window.minimize'),
  'windowControls.maximize': () => i18nService.t('common:window.maximize'),
  'windowControls.restore': () => i18nService.t('common:window.restore'),
  'windowControls.close': () => i18nService.t('common:window.close'),
});

export * from '@ai00-x/design-system/web';

export * from './Markdown';
export * from './CodeEditor';
