import React, { useState, useCallback, useRef } from 'react';
import './StarRating.scss';

export interface StarRatingProps {
  value: number;
  onChange?: (value: number) => void;
  maxStars?: number;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  label?: string;
}

const STAR_FILLED = '\u2605';
const STAR_EMPTY = '\u2606';

export const StarRating: React.FC<StarRatingProps> = ({
  value,
  onChange,
  maxStars = 5,
  size = 'md',
  disabled = false,
  label,
}) => {
  const [hoverValue, setHoverValue] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayValue = hoverValue > 0 ? hoverValue : value;

  const handleClick = useCallback(
    (starIndex: number) => {
      if (disabled || !onChange) return;
      onChange(starIndex);
    },
    [disabled, onChange]
  );

  const handleMouseEnter = useCallback(
    (starIndex: number) => {
      if (disabled) return;
      setHoverValue(starIndex);
    },
    [disabled]
  );

  const handleMouseLeave = useCallback(() => {
    if (disabled) return;
    setHoverValue(0);
  }, [disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled || !onChange) return;
      let newValue = value;

      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        newValue = Math.min(value + 1, maxStars);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        newValue = Math.max(value - 1, 0);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        return;
      }

      if (newValue !== value) {
        onChange(newValue);
      }
    },
    [disabled, onChange, value, maxStars]
  );

  const classNames = [
    'star-rating',
    `star-rating--${size}`,
    disabled && 'star-rating--disabled',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classNames}>
      {label && <span className="star-rating__label">{label}</span>}
      <div
        ref={containerRef}
        className="star-rating__stars"
        role="radiogroup"
        aria-label={label || 'Star rating'}
        onKeyDown={handleKeyDown}
        onMouseLeave={handleMouseLeave}
      >
        {Array.from({ length: maxStars }, (_, i) => {
          const starIndex = i + 1;
          const isFilled = starIndex <= displayValue;

          return (
            <span
              key={starIndex}
              className={`star-rating__star ${isFilled ? 'star-rating__star--filled' : ''}`}
              role="radio"
              aria-checked={starIndex === value}
              aria-label={`${starIndex} star${starIndex !== 1 ? 's' : ''}`}
              tabIndex={starIndex === (value || 1) ? 0 : -1}
              onClick={() => handleClick(starIndex)}
              onMouseEnter={() => handleMouseEnter(starIndex)}
            >
              {isFilled ? STAR_FILLED : STAR_EMPTY}
            </span>
          );
        })}
      </div>
    </div>
  );
};

StarRating.displayName = 'StarRating';
