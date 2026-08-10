/**
 * QuietSegmentedFilter — Patina-style segmented control.
 *
 * Ported from Patina's `shared/components/QuietSegmentedFilter.tsx`.
 */

import React from 'react';

export interface QuietSegmentedFilterOption<T extends string> {
  value: T;
  label: React.ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  value: T;
  options: QuietSegmentedFilterOption<T>[];
  onChange: (nextValue: T) => void;
  variant?: 'compact' | 'separate';
  className?: string;
}

function QuietSegmentedFilter<T extends string>({
  value,
  options,
  onChange,
  variant = 'compact',
  className,
}: Props<T>) {
  const variantClassName =
    variant === 'compact'
      ? 'qp-segmented-filter--compact'
      : 'qp-segmented-filter--separate';

  return (
    <div
      className={[
        'qp-segmented-filter',
        variantClassName,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            aria-pressed={selected}
            aria-label={option.ariaLabel}
            onClick={() => onChange(option.value)}
            className={[
              'qp-segmented-filter__item',
              selected && 'qp-segmented-filter__item--selected',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default QuietSegmentedFilter;
