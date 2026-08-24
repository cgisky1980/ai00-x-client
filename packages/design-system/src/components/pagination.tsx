/**
 * Pagination —— 自绘组合（规范 5.8）
 * 页码 mono+tabular-nums；当前页黛青；与 Table 组合而非内嵌。
 */
import { useMemo } from 'react';
import { cn } from '../lib/cn';
import { label } from '../lib/labels';

export interface PaginationProps {
  /** 当前页（1 起） */
  page: number;
  /** 总页数 */
  total: number;
  onChange: (page: number) => void;
  /** 当前页两侧各显示几个页码，默认 1 */
  siblingCount?: number;
  className?: string;
}

/** 生成页码序列：首/尾页 + 当前页邻域 + 省略号占位 */
function buildPages(page: number, total: number, siblingCount: number): (number | '…L' | '…R')[] {
  if (total <= 5 + siblingCount * 2) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages: (number | '…L' | '…R')[] = [1];
  const start = Math.max(2, page - siblingCount);
  const end = Math.min(total - 1, page + siblingCount);
  if (start > 2) pages.push('…L');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < total - 1) pages.push('…R');
  pages.push(total);
  return pages;
}

export const Pagination = ({ page, total, onChange, siblingCount = 1, className }: PaginationProps) => {
  const pages = useMemo(() => buildPages(page, total, siblingCount), [page, total, siblingCount]);

  if (total <= 1) return null;

  return (
    <nav className={cn('ds-pagination', className)} aria-label={label('pagination.label', '分页')}>
      <button
        type="button"
        className="ds-pagination__btn"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label={label('pagination.previous', '上一页')}
      >
        ‹
      </button>
      {pages.map((p) =>
        typeof p === 'number' ? (
          <button
            key={p}
            type="button"
            className={cn('ds-pagination__page', p === page && 'ds-pagination__page--active')}
            onClick={() => onChange(p)}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </button>
        ) : (
          <span key={p} className="ds-pagination__ellipsis" aria-hidden>
            …
          </span>
        ),
      )}
      <button
        type="button"
        className="ds-pagination__btn"
        onClick={() => onChange(page + 1)}
        disabled={page >= total}
        aria-label={label('pagination.next', '下一页')}
      >
        ›
      </button>
    </nav>
  );
};
