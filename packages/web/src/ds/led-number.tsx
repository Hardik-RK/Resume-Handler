import type { CSSProperties } from 'react';

// The odometer: one rolling digit column per digit, separators as plain spans.
// Usage: <LedNumber value={1936} className="kpi-value" delay={120} />. Null/NaN renders an em dash.
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

interface LedNumberProps {
  value: number | string | null | undefined;
  className?: string;
  delay?: number;
  locale?: string;
}

export function LedNumber({ value, className = 'kpi-value', delay = 0, locale = 'en-IN' }: LedNumberProps) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n)) return <span className={`led-num ${className}`.trim()} role="img" aria-label="No data">—</span>;
  const text = n.toLocaleString(locale);
  let k = 0;
  return (
    <span className={`led-num odo ${className}`.trim()} role="img" aria-label={text} style={{ '--d': `${delay}ms` } as CSSProperties}>
      {[...text].map((ch, i) => (/\d/.test(ch)
        ? <span key={i} className="od" aria-hidden="true"><span className="od-s" style={{ '--n': Number(ch), '--k': k++ } as CSSProperties}>{DIGITS.map((d) => <span key={d}>{d}</span>)}</span></span>
        : <span key={i} aria-hidden="true">{ch}</span>))}
    </span>
  );
}
