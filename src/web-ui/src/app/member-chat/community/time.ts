/**
 * 社区相对时间格式化（feed/详情/通知共用）
 *
 * 规则：<1min 刚刚；<1h N 分钟前；<1d N 小时前；<7d N 天前；
 * 超过 7d 显示日期（同年省略年份）。输出给 .ds-data（mono+tabular）渲染。
 * 文案走 community 命名空间（P1 i18n）；非组件上下文直接用 i18next 实例。
 */
import i18next from 'i18next';

const t = (key: string, opts?: Record<string, unknown>): string =>
  i18next.t(`community:${key}`, opts) as string;

export function formatRelTime(iso: string): string {
  const t0 = Date.parse(iso);
  if (Number.isNaN(t0)) return '';
  const diff = Date.now() - t0;
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (diff < MIN) return t('timeJustNow');
  if (diff < HOUR) return t('timeMinutesAgo', { n: Math.floor(diff / MIN) });
  if (diff < DAY) return t('timeHoursAgo', { n: Math.floor(diff / HOUR) });
  if (diff < 7 * DAY) return t('timeDaysAgo', { n: Math.floor(diff / DAY) });
  const d = new Date(t0);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()} / `;
  return `${year}${d.getMonth() + 1}/${d.getDate()}`;
}
