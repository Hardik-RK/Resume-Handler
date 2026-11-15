import { useLayoutEffect, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icon';
import { usePopover } from './use-popover';

// A button that opens a menu below it. triggerClass swaps the crumb look for another trigger (a form field); menuClass adds to
// the menu; matchWidth makes the menu at least as wide as the trigger; anchor (a selector for an ancestor of the trigger)
// positions and sizes the menu by that element instead, so a menu opened from one crumb of a bar lines up with the whole bar.
interface CrumbMenuProps {
  label: string;
  ariaLabel?: string;
  isTitle?: boolean;
  id: string;
  children: (close: () => void) => ReactNode;
  triggerClass?: string;
  menuClass?: string;
  matchWidth?: boolean;
  anchor?: string;
  disabled?: boolean;
  triggerId?: string;
}

export function CrumbMenu({ label, ariaLabel, isTitle, id, children, triggerClass, menuClass = '', matchWidth = false, anchor = '', disabled = false, triggerId }: CrumbMenuProps) {
  const pop = usePopover();
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0 });
  useLayoutEffect(() => {
    const trigger = pop.trigger.current;
    if (!pop.open || !trigger) return;
    const rect = (anchor ? trigger.closest(anchor) : null)?.getBoundingClientRect() || trigger.getBoundingClientRect();
    // Opens below the trigger; flips above it when the menu does not fit below and there is more room above.
    const height = pop.panel.current?.offsetHeight || 0;
    const below = window.innerHeight - rect.bottom - 14;
    const top = height > below && rect.top > below ? Math.max(8, rect.top - 6 - height) : rect.bottom + 6;
    setPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 300) - 8)), top, width: rect.width });
  }, [pop.open, pop.trigger, pop.panel, anchor]);
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...(pop.panel.current?.querySelectorAll<HTMLElement>('.menu-item') || [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const button = (
    <button ref={pop.trigger} id={triggerId} disabled={disabled} className={triggerClass || `crumb${isTitle ? ' is-title' : ''}`} type="button" aria-haspopup="menu" aria-expanded={pop.open} aria-controls={id} aria-label={ariaLabel} onClick={() => pop.setOpen(!pop.open)}>
      <span>{label}</span><Icon name="chevron" />
    </button>
  );
  return (
    <>
      {isTitle ? <div style={{ margin: 0, display: 'flex' }}>{button}</div> : button}
      {pop.open && createPortal(
        <div ref={pop.panel} id={id} className={`menu glass fx ${menuClass}`.trim()} role="menu" style={{ left: pos.left, top: pos.top, maxHeight: 'min(560px, calc(100vh - 24px))', overflowY: 'auto', minWidth: matchWidth ? Math.max(pos.width, 200) : 264 }} onKeyDown={onKey}>
          {children(() => pop.setOpen(false))}
        </div>, document.body)}
    </>
  );
}
