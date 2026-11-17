/** 工作台列表的通用展示小工具（相对时间 / 目录尾段）。 */

/** 相对时间：刚刚 / Nm / Nh / Nd（超过 30 天显示日期）。 */
export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 目录尾段（列表里显示项目位置）。 */
export function dirTail(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}
