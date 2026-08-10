/**
 * CollapsibleBlock — generic expand/collapse card with header + body.
 *
 * Used to compress long LLM outputs (lyrics drafts, creation plans, long
 * explanations) into a single-line header that expands on click. Modeled
 * after flow_chat's ModelThinkingDisplay pattern but simpler and reusable.
 */

import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import './CollapsibleBlock.scss';

interface CollapsibleBlockProps {
  title: string;
  /** Optional summary shown when collapsed (e.g. line count, plan caption). */
  summary?: string;
  /** Icon element before the title. */
  icon?: React.ReactNode;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

export const CollapsibleBlock: React.FC<CollapsibleBlockProps> = ({
  title,
  summary,
  icon,
  defaultExpanded = false,
  children,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      className={`ace-collapsible ${expanded ? 'ace-collapsible--open' : ''}`}
    >
      <button
        type="button"
        className="ace-collapsible__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <ChevronRight size={12} className="ace-collapsible__chevron" />
        {icon && <span className="ace-collapsible__icon">{icon}</span>}
        <span className="ace-collapsible__title">{title}</span>
        {!expanded && summary && (
          <span className="ace-collapsible__summary">{summary}</span>
        )}
      </button>
      {expanded && <div className="ace-collapsible__body">{children}</div>}
    </div>
  );
};
