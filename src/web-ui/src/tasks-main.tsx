import { bootstrapWindowPage } from './infrastructure/windows/bootstrapWindowPage';
import { TitleMeta } from './tools/todo/components/TitleMeta';

// 「策」完整看板独立窗口入口（窗口 label 为 tasks；原 label 为 todo，2026-09-12 更名）。
//
// 注意 toast: false —— 到点提醒等提示统一由常驻 overlay 窗口的「策运行时」
// （tools/todo 里的 TodoOverlay）弹出；本窗口只渲染界面，避免同一事件
// 弹两次（且 overlay 的提示是置顶可见的，本窗口在后台时看不到）。
// ConfirmDialogRenderer 仍然由 bootstrapWindowPage 挂载——原生 confirm/prompt
// 必须被接管，与 toast 无关。
void bootstrapWindowPage({
  name: 'TasksWindow',
  load: () => import('./app/TasksWindowApp'),
  toast: false,
  titleBar: { title: '策', leading: <TitleMeta /> },
});
