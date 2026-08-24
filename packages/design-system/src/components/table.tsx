/**
 * Table —— 组合式数据表（规范 5.8）
 *
 * Table/TableHeader/TableBody/TableRow/TableHead/TableCell + dense 变体。
 * 不内建排序/筛选/分页（组合式）；数字列由消费方套 .ds-data（mono+tabular-nums）。
 */
import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export const Table = forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & { dense?: boolean }
>(({ className, dense, ...props }, ref) => (
  <div className="ds-table-wrap">
    <table ref={ref} className={cn('ds-table', dense && 'ds-table--dense', className)} {...props} />
  </div>
));
Table.displayName = 'Table';

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('ds-table__header', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('ds-table__body', className)} {...props} />
));
TableBody.displayName = 'TableBody';

export const TableRow = forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr ref={ref} className={cn('ds-table__row', className)} {...props} />
));
TableRow.displayName = 'TableRow';

export const TableHead = forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th ref={ref} className={cn('ds-table__head', className)} {...props} />
));
TableHead.displayName = 'TableHead';

export const TableCell = forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('ds-table__cell', className)} {...props} />
));
TableCell.displayName = 'TableCell';
