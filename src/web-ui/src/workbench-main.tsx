import { bootstrapWindowPage } from './infrastructure/windows/bootstrapWindowPage';

// 「工作台」独立窗口入口（窗口 label 为 workbench）。
//
// 存在理由：当前客户端没有主工作台外壳（overlay 是常驻宠物层，策/乐/社区各自
// 独立窗口），插件工作台（manifest.workbench + scene:page）需要一个可见宿主。
// 本窗口左侧列出所有已安装工作台，右侧挂载选中项的 scene 页。
// 见 client/参考/2026-11-06-工作台体系落地文档.md 的「宿主窗口」一节。
void bootstrapWindowPage({
  name: 'WorkbenchWindow',
  load: () => import('./app/WorkbenchWindowApp'),
  titleBar: { title: '工作台' },
});
