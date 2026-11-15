import type { CSSProperties } from 'react';

// The dot-matrix progress track. Pass percents (0-100) as `parts`: one part is a plain bar, several parts render the
// multi-colour `.stages` variant. Real data only: a zero part draws no lit dots.
interface DotTrackProps {
  parts: number | number[];
  rows?: number;
  delay?: number;
  label?: string;
  className?: string;
}

export function DotTrack({ parts, rows = 2, delay = 0, label, className = '' }: DotTrackProps) {
  const list = (Array.isArray(parts) ? parts : [parts]).map((p) => Math.max(0, Math.min(100, Number(p) || 0)));
  const stages = list.length > 1;
  return (
    <span
      className={`track${stages ? ' stages' : ''} ${className}`.trim()}
      style={{ '--rows': rows, '--d': `${delay}ms` } as CSSProperties}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}
    >
      {list.map((p, i) => (p > 0 ? <i key={i} className="lit" style={{ '--p': p.toFixed(2) } as CSSProperties} /> : null))}
      {!stages && <i className="rest" />}
    </span>
  );
}
