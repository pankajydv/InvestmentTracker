import React from 'react';
import { formatDate, formatINR, formatPct, profitColor } from '../utils/formatters';

function rowTitle(metric) {
  const details = [];
  if (metric?.asOfDate) details.push(`As of ${formatDate(metric.asOfDate)}`);
  if (metric?.source) details.push(metric.source);
  if (metric?.usedFallback) details.push('fallback');
  return details.join(' | ');
}

export default function DayChangeRows({ dayChanges, fullLabels = false }) {
  const rows = [
    [fullLabels ? 'Today' : '1D', dayChanges?.oneDay],
    [fullLabels ? 'Yesterday' : 'YD', dayChanges?.yesterday],
  ];

  return (
    <div className="day-change-rows">
      {rows.map(([label, metric]) => {
        const change = Number(metric?.change || 0);
        const changePct = Number(metric?.changePct || 0);
        const colorClass = profitColor(change);
        return (
          <div className="day-change-row" key={label} title={rowTitle(metric)}>
            <span className="day-change-row-label">{label}</span>
            <span className={`day-change-row-value ${colorClass}`}>
              {change > 0 ? '+' : ''}{formatINR(change, 0)}
            </span>
            <span className={`day-change-row-rate ${colorClass}`}>
              {formatPct(changePct)}
            </span>
          </div>
        );
      })}
    </div>
  );
}