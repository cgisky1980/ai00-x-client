/**
 * 社区相对时间格式化（feed/详情/通知共用）
 *
 * 规则：<1min 刚刚；<1h N 分钟前；<1d N 小时前；<7d N 天前；
 * 超过 7d 显示日期（同年省略年份）。输出给 .ds-data（mono+tabular）渲染。
 */

export function formatRelTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const d = new Date(t);
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日`;
}
