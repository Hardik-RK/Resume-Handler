import { useId, useState } from 'react';
import { Icon } from './ds/icon';
import { Dialog } from './ds/dialog';
import { DEFAULT_PARALLEL } from './queue-logic';
import { PARALLEL_MAX, PARALLEL_MIN, readParallel, writeParallel } from './format';
import { errorMessage } from './lib/api';

export const MAX_SOURCES = 50;
const MAX_SOURCE_LEN = 60;

// Two settings of every run. The source list is shared: saved on the server (POST /settings with only config.platforms) and
// shown in the form; the server's answer (400 for an invalid value) shows inline. Parallel requests are personal: kept in this
// browser, never on the server.

type Status = 'idle' | 'saved' | 'invalid' | 'error' | 'saving';

export function ParallelField() {
  const ids = { input: useId(), help: useId() };
  const [value, setValue] = useState(() => String(readParallel() ?? DEFAULT_PARALLEL));
  const [state, setState] = useState<{ status: Status; message: string }>({ status: 'idle', message: '' });

  function change(raw: string) {
    setValue(raw);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < PARALLEL_MIN || n > PARALLEL_MAX) { setState({ status: 'invalid', message: `Use a whole number from ${PARALLEL_MIN} to ${PARALLEL_MAX}.` }); return; }
    setState(writeParallel(n) ? { status: 'saved', message: '' } : { status: 'error', message: 'This browser would not keep the setting. It applies until you leave the page.' });
  }

  const step = (d: number) => change(String(Math.max(PARALLEL_MIN, Math.min(PARALLEL_MAX, (Number(value) || DEFAULT_PARALLEL) + d))));
  const note = state.status === 'saved' ? 'Saved for you' : '';
  const bad = state.status === 'invalid' || state.status === 'error';

  return (
    <div className="form-row">
      <label className="lbl" htmlFor={ids.input}>Your parallel requests</label>
      <div className="up-stepper">
        <button className="btn btn-icon" type="button" aria-label="Fewer parallel requests" disabled={Number(value) <= PARALLEL_MIN} onClick={() => step(-1)}><Icon name="minus" size="sm" /></button>
        <input className="input num" id={ids.input} type="number" inputMode="numeric" min={PARALLEL_MIN} max={PARALLEL_MAX} step="1" value={value}
          aria-describedby={ids.help} aria-invalid={bad || undefined} onChange={(e) => change(e.target.value)} />
        <button className="btn btn-icon" type="button" aria-label="More parallel requests" disabled={Number(value) >= PARALLEL_MAX} onClick={() => step(1)}><Icon name="plus" size="sm" /></button>
        <span className="hint" aria-live="polite">{note}</span>
      </div>
      <span className="help" id={ids.help}>Résumés read at the same time, {PARALLEL_MIN} to {PARALLEL_MAX}. It is kept in this browser. Higher is faster but hits rate limits sooner. Default {DEFAULT_PARALLEL}.</span>
      {bad && <span className="help up-invalid" role="alert">{state.message}</span>}
    </div>
  );
}

interface SourcesEditorProps {
  sources: string[];
  onSave: (patch: Record<string, unknown>) => Promise<unknown>;
  autoFocus?: boolean;
}

export function SourcesEditor({ sources, onSave, autoFocus = false }: SourcesEditorProps) {
  const ids = { add: useId(), label: useId(), msg: useId() };
  const [name, setName] = useState('');
  const [state, setState] = useState<{ status: Status; message: string }>({ status: 'idle', message: '' });

  async function saveList(list: string[], verb: string): Promise<boolean> {
    setState({ status: 'saving', message: '' });
    try {
      await onSave({ platforms: list });
      setState({ status: 'saved', message: verb });
      return true;
    } catch (err) {
      setState({ status: 'error', message: errorMessage(err) || 'The sources could not be saved.' });
      return false;
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const value = name.trim().replace(/\s+/g, ' ');
    if (!value) return;
    if (value.length > MAX_SOURCE_LEN) { setState({ status: 'error', message: `A source name can have ${MAX_SOURCE_LEN} characters at most.` }); return; }
    if (sources.some((s) => s.toLowerCase() === value.toLowerCase())) { setState({ status: 'error', message: `${value} is already in the list.` }); return; }
    if (sources.length >= MAX_SOURCES) { setState({ status: 'error', message: `The list holds ${MAX_SOURCES} sources at most. Remove one first.` }); return; }
    if (await saveList([...sources, value], `${value} added.`)) setName('');
  }

  const busy = state.status === 'saving';
  return (
    <div className="form-row up-sources-row">
      <span className="lbl" id={ids.label}>Sources <em>{sources.length} of {MAX_SOURCES}</em></span>
      {sources.length ? (
        <ul className="up-sources" aria-labelledby={ids.label}>
          {sources.map((s) => (
            <li key={s}>
              <span>{s}</span>
              <button className="btn btn-icon btn-bare" type="button" aria-label={`Remove the source ${s}`} title={`Remove ${s}`} disabled={busy}
                onClick={() => saveList(sources.filter((x) => x !== s), `${s} removed.`)}><Icon name="x" size="sm" /></button>
            </li>
          ))}
        </ul>
      ) : <span className="help">No sources yet. Add the job boards your résumés come from, such as Naukri or Unstop.</span>}
      <form className="up-add" onSubmit={add}>
        <label className="sr-only" htmlFor={ids.add}>New source</label>
        <input className="input" id={ids.add} type="text" maxLength={MAX_SOURCE_LEN} placeholder="New source" value={name}
          data-autofocus={autoFocus || undefined} aria-describedby={ids.msg}
          onChange={(e) => { setName(e.target.value); if (state.status === 'error') setState({ status: 'idle', message: '' }); }} />
        <button className="btn" type="submit" disabled={!name.trim() || busy}><Icon name="plus" size="sm" />Add</button>
      </form>
      <span className={`help${state.status === 'error' ? ' up-invalid' : ''}`} id={ids.msg} role={state.status === 'error' ? 'alert' : 'status'} aria-live="polite">
        {busy ? 'Saving…' : state.message}
      </span>
    </div>
  );
}

// Opened from the Source field of the form: the same list, without going through the settings popup.
export function SourcesDialog({ sources, onSave, onClose }: { sources: string[]; onSave: SourcesEditorProps['onSave']; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="Sources" size="xwide"
      actions={<button className="btn" type="button" onClick={onClose}>Done</button>}>
      <p className="dialog-body">The list the Source field offers. Removing a source does not change uploads already queued.</p>
      <SourcesEditor sources={sources} onSave={onSave} autoFocus />
    </Dialog>
  );
}
