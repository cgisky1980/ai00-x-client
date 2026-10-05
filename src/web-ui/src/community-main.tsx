import { bootstrapWindowPage } from './infrastructure/windows/bootstrapWindowPage';

// 「社区」独立窗口入口（含 rail tab；原 label 为 member-chat，2026-09-12 更名）。
// 启动样板统一走 bootstrapWindowPage —— 主题注入 / 原生弹窗接管 / 跨窗口设置同步 /
// themeStore 引导都在那里，本入口只声明「我是谁、我渲染什么」。
void bootstrapWindowPage({
  name: 'CommunityWindow',
  load: () => import('./app/MemberChatApp'),
  titleBar: { title: '社区' },
});
