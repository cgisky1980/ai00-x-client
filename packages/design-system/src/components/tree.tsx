/**
 * Tree —— 自研轻量树（规范 5.8）
 * 每级缩进 16px + 竖向 guide line；chevron 0.15s 旋转；选中 accent-50 底。
 * 非虚拟化——大列表由消费方组合 react-virtuoso。
 */
import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface TreeNodeData {
  id: string;
  label: ReactNode;
  children?: TreeNodeData[];
  icon?: ReactNode;
  /** 行尾动作区（hover 显隐由消费方 CSS 决定） */
  actions?: ReactNode;
}

export interface TreeProps {
  nodes: TreeNodeData[];
  defaultExpandedIds?: string[];
  selectedId?: string | null;
  onSelect?: (node: TreeNodeData) => void;
  renderLabel?: (node: TreeNodeData) => ReactNode;
  className?: string;
}

interface TreeItemProps {
  node: TreeNodeData;
  depth: number;
  expandedIds: Set<string>;
  toggle: (id: string) => void;
  selectedId?: string | null;
  onSelect?: (node: TreeNodeData) => void;
  renderLabel?: TreeProps['renderLabel'];
}

const ChevronIcon = ({ open }: { open: boolean }) => (
  <span className={cn('ds-tree__chevron', open && 'ds-tree__chevron--open')} aria-hidden>
    ›
  </span>
);

const TreeItem = ({ node, depth, expandedIds, toggle, selectedId, onSelect, renderLabel }: TreeItemProps) => {
  const hasChildren = !!node.children && node.children.length > 0;
  const isOpen = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;

  return (
    <div className="ds-tree__item-wrapper">
      <div
        role="treeitem"
        aria-expanded={hasChildren ? isOpen : undefined}
        aria-selected={isSelected}
        className={cn('ds-tree__item', isSelected && 'ds-tree__item--selected')}
        style={{ paddingLeft: `calc(var(--size-gap-2) + ${depth * 16}px)` }}
        onClick={() => onSelect?.(node)}
      >
        <span className="ds-tree__indent" aria-hidden />
        {hasChildren ? (
          <button
            type="button"
            className="ds-tree__toggle"
            onClick={(e) => {
              e.stopPropagation();
              toggle(node.id);
            }}
            aria-hidden
            tabIndex={-1}
          >
            <ChevronIcon open={isOpen} />
          </button>
        ) : (
          <span className="ds-tree__toggle ds-tree__toggle--leaf" aria-hidden />
        )}
        {node.icon != null && <span className="ds-tree__icon">{node.icon}</span>}
        <span className="ds-tree__label">{renderLabel ? renderLabel(node) : node.label}</span>
        {node.actions != null && <span className="ds-tree__actions">{node.actions}</span>}
      </div>
      {hasChildren && isOpen && (
        <div role="group">
          {node.children!.map((child) => (
            <TreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              toggle={toggle}
              selectedId={selectedId}
              onSelect={onSelect}
              renderLabel={renderLabel}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const Tree = ({ nodes, defaultExpandedIds, selectedId, onSelect, renderLabel, className }: TreeProps) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(defaultExpandedIds ?? []),
  );

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div role="tree" className={cn('ds-tree', className)}>
      {nodes.map((node) => (
        <TreeItem
          key={node.id}
          node={node}
          depth={0}
          expandedIds={expandedIds}
          toggle={toggle}
          selectedId={selectedId}
          onSelect={onSelect}
          renderLabel={renderLabel}
        />
      ))}
    </div>
  );
};
