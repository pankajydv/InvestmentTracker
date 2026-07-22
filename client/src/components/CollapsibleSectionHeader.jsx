import React from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Chevron-led collapsible section header.
 * The title (with optional subtitle/summary) is the clickable toggle; a
 * right-hand slot holds any extra controls (e.g. density toggles, filters),
 * and a chevron sits at the far right, rotating when expanded.
 */
export default function CollapsibleSectionHeader({
  expanded,
  onToggle,
  title,
  subtitle = null,
  summary = null,
  right = null,
  titleClassName = 'h6 fw-semibold mb-0',
  className = 'd-flex align-items-center gap-2 mb-3',
  rightClassName = 'd-flex flex-wrap align-items-center gap-2',
}) {
  return (
    <div className={className}>
      <button
        type="button"
        className="btn btn-link p-0 text-decoration-none text-body d-flex flex-column align-items-start text-start flex-grow-1"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="d-flex align-items-center gap-2 flex-wrap">
          <span className={titleClassName}>{title}</span>
          {!expanded && summary ? (
            <span className="text-muted small fw-normal">{summary}</span>
          ) : null}
        </span>
        {subtitle ? <span className="small text-muted">{subtitle}</span> : null}
      </button>
      {right ? <div className={rightClassName}>{right}</div> : null}
      <button
        type="button"
        className="btn btn-link p-0 text-muted flex-shrink-0"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse' : 'Expand'}
      >
        <ChevronDown
          size={18}
          style={{ transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>
    </div>
  );
}
