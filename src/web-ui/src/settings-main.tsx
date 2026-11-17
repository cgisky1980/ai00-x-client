import { bootstrapWindowPage } from './infrastructure/windows/bootstrapWindowPage';

// 「设置」独立窗口入口（窗口 label 为 settings；原名「策」tasks，2026-11-08 回退为设置）。
//
// 注意 toast: false —— 到点提醒等提示统一由常驻 overlay 窗口的「策运行时」
// （tools/todo 里的 TodoOverlay）弹出；本窗口只渲染设置界面。
// ConfirmDialogRenderer 仍由 bootstrapWindowPage 挂载——原生 confirm/prompt
// 必须被接管，与 toast 无关。
void bootstrapWindowPage({
  name: 'SettingsWindow',
  load: () => import('./app/SettingsWindowApp'),
  toast: false,
  titleBar: { title: '设置' },
});
