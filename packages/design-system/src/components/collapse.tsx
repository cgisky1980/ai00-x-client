/**
 * Collapse —— 折叠面板（规范 5.8）
 * grid-rows 0fr→1fr 高度过渡（无 max-height 魔数）；a11y：button[aria-expanded] + region。
 */
import {
  forwardRef,
  isValidElement,
  useId,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';

export interface CollapseItemProps extends HTMLAttributes<HTMLDivElement> {
  /** 受控时由 Collapse 注入 key 提取；非列表用法可单独用 */
  itemKey?: string | number;
  header?: ReactNode;
  children: ReactNode;
  /** 初始展开（非受控） */
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

export interface CollapseProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  children: ReactNode;
  /** 初始展开项（非受控） */
  defaultActiveKeys?: Array<string | number>;
  activeKeys?: Array<string | number>;
  onChange?: (keys: Array<string | number>) => void;
  /** 手风琴：同时只开一个 */
  accordion?: boolean;
}

const getKey = (child: ReactNode, fallback: string | number | undefined, index: number) => {
  if (fallback !== undefined) return fallback;
  if (isValidElement<CollapseItemProps>(child) && child.props.itemKey !== undefined)
    return child.props.itemKey;
  return index;
};

export const CollapseItem = forwardRef<HTMLDivElement, CollapseItemProps>(
  (
    { className, itemKey, header, children, defaultOpen = false, open, onOpenChange, disabled, ...props },
    ref,
  ) => {
    const [innerOpen, setInnerOpen] = useState(defaultOpen);
    const isOpen = open ?? innerOpen;
    const id = useId();

    return (
      <div
        ref={ref}
        className={cn('ds-collapse__item', isOpen && 'is-open', disabled && 'is-disabled', className)}
        {...props}
      >
        <button
          type="button"
          className="ds-collapse__header"
          aria-expanded={isOpen}
          aria-controls={id}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            const next = !isOpen;
            if (open === undefined) setInnerOpen(next);
            onOpenChange?.(next);
          }}
        >
          <span className="ds-collapse__header-text">{header}</span>
          <svg className="ds-collapse__arrow" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div id={id} role="region" className="ds-collapse__panel">
          <div className="ds-collapse__panel-inner">{children}</div>
        </div>
      </div>
    );
  },
);
CollapseItem.displayName = 'CollapseItem';

export const Collapse = forwardRef<HTMLDivElement, CollapseProps>(
  (
    { className, children, defaultActiveKeys = [], activeKeys, onChange, accordion = false, ...props },
    ref,
  ) => {
    const [innerKeys, setInnerKeys] = useState<Array<string | number>>(defaultActiveKeys);
    const keys = activeKeys ?? innerKeys;

    const items = Array.isArray(children) ? children : [children];

    return (
      <div ref={ref} className={cn('ds-collapse', className)} {...props}>
        {items.map((child, i) => {
          if (!isValidElement<CollapseItemProps>(child)) return child;
          const key = getKey(child, child.props.itemKey, i);
          const open = keys.includes(key);
          return (
            <child.type
              key={key}
              {...child.props}
              itemKey={key}
              open={open}
              onOpenChange={(next: boolean) => {
                let nextKeys: Array<string | number>;
                if (accordion) nextKeys = next ? [key] : [];
                else nextKeys = next ? [...keys, key] : keys.filter((k) => k !== key);
                if (activeKeys === undefined) setInnerKeys(nextKeys);
                onChange?.(nextKeys);
                child.props.onOpenChange?.(next);
              }}
            />
          );
        })}
      </div>
    );
  },
);
Collapse.displayName = 'Collapse';
