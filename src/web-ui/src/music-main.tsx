import { bootstrapWindowPage } from './infrastructure/windows/bootstrapWindowPage';

// 「乐」独立音乐窗口入口（播放端 + SFX + AceStep 创作工作台三合一；
// 原 overlay 内 MusicPopup/SfxPopup 弹层与 acestep 场景页的全部职责）。
// 启动样板统一走 bootstrapWindowPage —— 主题注入 / 原生弹窗接管 / 跨窗口设置同步 /
// themeStore 引导都在那里，本入口只声明「我是谁、我渲染什么」。
void bootstrapWindowPage({
  name: 'MusicWindow',
  load: () => import('./app/MusicWindowApp'),
  titleBar: { title: '乐' },
});
