/**
 * 策运行时的用户提示出口。
 *
 * 原先这些提示走 `useGrowthStore.showToast(title, sub)`，但 growthStore 的 toast 只在
 * **已下线的「策」窗口**（TodoPanel）里渲染——工作台里没有任何组件渲染它，于是
 * 「待验收 / 待批准 / 执行卡住 / 任务被中断」这类真正需要人动手的提示全部静默消失。
 * 统一改走主窗口真实挂载的全局通知系统（App.tsx 的 `NotificationContainer`）。
 *
 * `tone` 约定：`warning` = 需要你动手（待批准 / 待验收 / 静默告警）；`error` = 需要人工处理
 * （不自动消失）；`info` = 只需知悉。
 *
 * `actions` = 通知上的动作按钮（如「去批准」→ 开工作台并定位到该任务）。点按钮即执行
 * 回调并收起该条通知（NotificationItem 的既有行为）。
 */
import { notificationService } from '@/shared/notification-system';

export interface NotifyAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

export function notifyTask(
  title: string,
  message: string,
  tone: 'info' | 'warning' | 'error' = 'info',
  actions?: NotifyAction[],
): string {
  return notificationService[tone](message, {
    title,
    duration: tone === 'error' ? 0 : 8000,
    ...(actions && actions.length > 0 ? { actions } : {}),
  });
}

/** 收起一条已发出的通知（error 档不自动消失，同一任务重复失败要先收旧条）。 */
export function dismissTaskNotification(id: string): void {
  notificationService.dismiss(id);
}
