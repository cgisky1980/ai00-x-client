/**
 * 共享编排模块出口（策 + 工作台）。
 *
 * 一次 import 拿到 loop 需要的全部基件：
 * - 编排者提示（modules.ts）
 * - 任务书组装纯函数与记忆挑选（delegation.ts）
 * - 委托/完工/边界文案与工作台 loop 规约（promptParts.ts）
 */
export * from './modules';
export * from './delegation';
export * from './promptParts';
