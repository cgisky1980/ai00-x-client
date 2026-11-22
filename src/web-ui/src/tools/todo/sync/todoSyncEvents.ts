/**
 * 策跨窗口同步的事件名常量。
 *
 * 单独成文件是为了打断循环依赖：`todoStore` 需要在 save 后广播
 * `todo:data-changed`，而 `todoWindowSync` 需要订阅同一批事件并读写 store。
 * 常量放中立模块后，两边都只依赖它。
 */
export const TODO_DATA_CHANGED = 'todo:data-changed';
export const TODO_RUNTIME_STATE = 'todo:runtime-state';
export const TODO_DERIVED_STATE = 'todo:derived-state';

/**
 * 删除墓碑广播：某一窗口删卡后，其它窗口也要记住这些 id。
 *
 * 每个窗口的 store 各有一份内存数据；别的窗口若正处在本轮 save 的防抖窗口里，
 * 它会把「自己那份还带着被删卡的数据」整份写回盘（`todo_store_set` 是整份覆盖），
 * 被删的卡就这样复活（实测：运行中的任务点删除，列表已消失，`data.json` 里又出现）。
 * 广播后各窗口把 id 记进自己的墓碑，save 前过滤掉。
 */
export const TODO_TASKS_DELETED = 'todo:tasks-deleted';

/**
 * 「定位到某张卡片」意图：overlay（工灵所在窗口）→ 策窗口。
 *
 * 与上面三条不同，这是**一次性动作**而非状态同步——策窗口消费后即丢弃，
 * 不做状态回写。因此需要 pending 机制兜住「策窗口尚未打开」的时序（见
 * `windowBus.ts` 的 `queueWindowIntent` / `takePendingIntents`）。
 */
export const TODO_FOCUS_TASK = 'todo:focus-task';

