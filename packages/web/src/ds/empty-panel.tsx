import type { ReactNode } from 'react';

// The empty / error block: dot-matrix mark + title + text + optional action. Built from the generated lattice (4px pitch)
// so there is no hard-coded SVG path. tone="warn" lights the mark in the warning colour.
const COLS = 16;
const ROWS = 6;
const LIT = new Set(['5,3', '8,2', '11,3']);

interface EmptyPanelProps {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: 'warn';
}

export function EmptyPanel({ title, children, action, tone }: EmptyPanelProps) {
  const off: string[] = [];
  const on: string[] = [];
  for (let x = 0; x < COLS; x += 1) {
    for (let y = 0; y < ROWS; y += 1) (LIT.has(`${x},${y}`) ? on : off).push(`M${x * 4 + 2} ${y * 4 + 2}h0`);
  }
  return (
    <div className="empty" role={tone === 'warn' ? 'alert' : undefined}>
      <svg className="dm" width="64" height="24" viewBox="0 0 64 24" aria-hidden="true">
        <path className="off" d={off.join('')} />
        <g className="data"><path className={tone === 'warn' ? 'on warn' : 'on'} d={on.join('')} /></g>
      </svg>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
