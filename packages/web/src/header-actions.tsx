import { useLayoutEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './ds/icon';
import { usePopover } from './ds/use-popover';

const FOLDERS = [
  { target: 'input', label: 'Input', note: 'Files waiting for an upload to run' },
  { target: 'output', label: 'Output', note: 'Result CSVs of every upload' },
  { target: 'processed', label: 'Processed', note: 'Input files an upload has finished with' },
  { target: 'database', label: 'Database', note: 'Résumés the JD filter rejected' },
  { target: 'logs', label: 'Logs', note: 'Server logs, no résumé text' },
];

// Controls in the top bar: History (popup, see runs-history.tsx), Folders (menu) and Settings (popup).

// Gear in the line-icon style of the sprite (the sprite has no gear).
function GearIcon() {
  return (
    <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function SettingsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="btn act up-tool" type="button" onClick={onOpen} aria-haspopup="dialog" title="Settings">
      <GearIcon />Settings
    </button>
  );
}

// Opens one of the server's folders on the machine the server runs on (POST /open).
export function FolderMenu({ onOpen, disabled }: { onOpen: (target: string, label: string) => void; disabled: boolean }) {
  const { open, setOpen, trigger, panel } = usePopover();
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const button = trigger.current?.getBoundingClientRect();
    const box = panel.current?.getBoundingClientRect();
    if (!button || !box) return;
    setPos({ left: Math.max(8, Math.min(button.right - box.width, window.innerWidth - box.width - 8)), top: button.bottom + 6 });
    panel.current?.querySelector<HTMLElement>('.menu-item')?.focus();
  }, [open, trigger, panel]);

  function onKeyDown(event: KeyboardEvent) {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('.menu-item') || [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (event.key === 'Tab') setOpen(false);
  }

  return (
    <>
      <button ref={trigger} className="btn act up-tool" type="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        onClick={() => setOpen(!open)} title="Open a server folder on the machine it runs on">
        <Icon name="inbox" size="sm" />Folders<Icon name="chevron" size="sm" className="up-tool-chev" />
      </button>
      {open && createPortal(
        <div ref={panel} className="menu glass fx up-folder-menu" role="menu" aria-label="Open a folder" onKeyDown={onKeyDown}
          style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
          <div className="menu-head"><strong>Open folder</strong><span>Server folders on the machine it runs on</span></div>
          {FOLDERS.map((f) => (
            <button key={f.target} className="menu-item" type="button" role="menuitem" onClick={() => { setOpen(false); onOpen(f.target, f.label); }}>
              <span className="up-mi"><b>{f.label}</b><small>{f.note}</small></span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
