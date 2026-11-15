import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Modal dialog in the .backdrop/.dialog markup: Escape and backdrop-click close it, Tab stays inside, and focus returns to
// whatever opened it. size: '' | 'wide' | 'xwide' (extra classes may follow).
interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: string;
  children?: ReactNode;
  actions?: ReactNode;
}

export function Dialog({ open, onClose, title, size = '', children, actions }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Keep the latest onClose without re-running the focus effect when a parent passes a fresh callback each render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    const box = ref.current;
    if (!box) return undefined;
    const focusable = () => [...box.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    (box.querySelector<HTMLElement>('[data-autofocus]') || focusable()[0] || box).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (opener?.isConnected) opener.focus(); };
  }, [open]);
  if (!open) return null;
  // Rendered into <body>: a dialog opened from the glass top bar would otherwise be confined to it (backdrop-filter makes it the
  // containing block of fixed children).
  return createPortal(
    <div className="backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
      <div ref={ref} className={`dialog ${size}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h3 id={titleId}>{title}</h3>
        {children}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}
