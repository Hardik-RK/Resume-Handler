import { useEffect } from 'react';

// The gliding hover highlight for the dropdown menus (.menu) and the activity list: one ghost per list slides to the item
// under the pointer or the keyboard focus. Delegated, so lists rendered anywhere get it without changing their markup.
const GLIDE_HOST = '.menu, .up-entries';
const GLIDE_ITEM = '.menu .menu-item, .up-entries > .up-entry';

export function useMenuGlide(): void {
  useEffect(() => {
    const place = (item: HTMLElement) => {
      const host = item.closest<HTMLElement>(GLIDE_HOST);
      if (!host) return;
      let ghost = host.querySelector<HTMLElement>(':scope > .menu-ghost');
      const fresh = !ghost;
      if (!ghost) {
        ghost = document.createElement('span');
        ghost.className = 'menu-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        host.prepend(ghost);
        host.classList.add('has-ghost');
      }
      if (fresh || !ghost.classList.contains('on')) ghost.style.transition = 'none';
      const box = item.getBoundingClientRect();
      const area = host.getBoundingClientRect();
      ghost.style.left = `${box.left - area.left + host.scrollLeft - host.clientLeft}px`;
      ghost.style.width = `${box.width}px`;
      ghost.style.height = `${box.height}px`;
      ghost.style.transform = `translateY(${box.top - area.top + host.scrollTop - host.clientTop}px)`;
      if (ghost.style.transition) { void ghost.offsetWidth; ghost.style.transition = ''; }
      ghost.classList.add('on');
    };
    const hide = (host: Element | null) => host?.querySelector(':scope > .menu-ghost')?.classList.remove('on');
    const itemOf = (event: Event) => (event.target as Element | null)?.closest?.<HTMLElement>(GLIDE_ITEM) ?? null;
    const over = (event: MouseEvent) => { const item = itemOf(event); if (item && !(item as HTMLButtonElement).disabled) place(item); };
    const focus = (event: FocusEvent) => { const item = itemOf(event); if (item && (event.target as Element).matches(':focus-visible')) place(item); };
    const out = (event: MouseEvent) => {
      const host = (event.target as Element | null)?.closest?.(GLIDE_HOST) ?? null;
      if (host && !host.contains(event.relatedTarget as Node | null)) hide(host);
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('mouseout', out);
    document.addEventListener('focusin', focus);
    return () => { document.removeEventListener('mouseover', over); document.removeEventListener('mouseout', out); document.removeEventListener('focusin', focus); };
  }, []);
}
