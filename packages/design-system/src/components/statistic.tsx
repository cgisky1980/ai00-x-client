/**
 * Statistic —— 数字统计（规范 5.8）
 * 值变化时 rAF count-up（600ms easeOutCubic）；prefers-reduced-motion 直接落位。
 * 数字一律 mono + tabular-nums（机器输出纪律）。
 */
import { forwardRef, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface StatisticProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'prefix'> {
  value: number;
  /** 千分位（默认开） */
  groupSeparator?: string;
  /** 小数位（默认 0） */
  precision?: number;
  title?: ReactNode;
  prefix?: ReactNode;
  suffix?: ReactNode;
  /** 关闭 count-up（静态直出） */
  motion?: boolean;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

const format = (n: number, precision: number, sep: string) =>
  n.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
    useGrouping: sep !== '',
  }).replace(/,/g, sep || ',');

export const Statistic = forwardRef<HTMLDivElement, StatisticProps>(
  (
    { className, value, groupSeparator = ',', precision = 0, title, prefix, suffix, motion = true, ...props },
    ref,
  ) => {
    const [display, setDisplay] = useState(motion ? 0 : value);
    const fromRef = useRef(motion ? 0 : value);
    const rafRef = useRef(0);

    useEffect(() => {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!motion || reduced) {
        fromRef.current = value;
        setDisplay(value);
        return;
      }
      const from = fromRef.current;
      const to = value;
      if (from === to) return;
      const start = performance.now();
      const dur = 600;
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / dur);
        setDisplay(from + (to - from) * easeOutCubic(t));
        if (t < 1) rafRef.current = requestAnimationFrame(tick);
        else fromRef.current = to;
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafRef.current);
    }, [value, motion]);

    return (
      <div ref={ref} className={cn('ds-statistic', className)} {...props}>
        {title != null && <span className="ds-statistic__title">{title}</span>}
        <span className="ds-statistic__value ds-data">
          {prefix}
          {format(display, precision, groupSeparator)}
          {suffix}
        </span>
      </div>
    );
  },
);
Statistic.displayName = 'Statistic';
