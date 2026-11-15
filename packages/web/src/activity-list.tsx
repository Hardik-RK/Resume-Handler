import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from './ds/icon';
import { Dialog } from './ds/dialog';
import { DotTrack } from './ds/dot-track';
import { LedNumber } from './ds/led-number';
import { EmptyPanel } from './ds/empty-panel';
import { batchState, readyFiles } from './queue-logic';
import { duration, money, percentOf, PHASE_LABEL, plural } from './format';
import { errorMessage } from './lib/api';
import type { Batch, ResultRow, RunState } from './lib/types';
import type { BatchQueue } from './use-batch-queue';
import type { ToastFn } from './ds/toast';

const STATE: Record<string, { label: string; cls: string }> = {
  uploading: { label: 'Uploading', cls: 'pill' },
  queued: { label: 'Queued', cls: 'pill' },
  running: { label: 'Running', cls: 'pill live' },
  done: { label: 'Done', cls: 'status status-active' },
  failed: { label: 'Failed', cls: 'pill pill-warn' },
  cancelled: { label: 'Cancelled', cls: 'status status-paused' },
};
const FINISHED = new Set(['done', 'failed', 'cancelled']);

const pick = (row: ResultRow, ...keys: string[]): string => {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
};
const isHttps = (url: string): boolean => /^https:\/\//i.test(String(url || ''));

export const entryTitle = (b: Batch): string => {
  const names = b.files.map((f) => f.original || f.name);
  if (names.length <= 1) return names[0] || 'Upload';
  return `${plural(names.length, 'PDF')}`;
};

function downloadCsv(batch: Batch): void {
  const blob = new Blob([batch.csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${entryTitle(batch).replace(/\.(zip|pdf)$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'upload'}-results.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Re-renders every second while something is running, so elapsed times tick.
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

function RowsDialog({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const title = entryTitle(batch);
  return (
    <Dialog open onClose={onClose} title={`Results of ${title}`} size="xwide up-rows-dialog"
      actions={<>
        {batch.csv && <button className="btn" type="button" onClick={() => downloadCsv(batch)}><Icon name="filetext" size="sm" />Download CSV</button>}
        <button className="btn" type="button" onClick={onClose}>Close</button>
      </>}>
      <p className="dialog-body">{plural(batch.rows.length, 'row')}. Kept on this page only until it is reloaded; the CSV is also in the server&apos;s output folder.</p>
      <div className="table-wrap up-rows">
        <table className="data-table" aria-label={`Results of ${title}`}>
          <colgroup><col /><col style={{ width: '30%' }} /><col style={{ width: 130 }} /><col style={{ width: 100 }} /><col style={{ width: 90 }} /></colgroup>
          <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col">Source</th><th scope="col">Résumé</th></tr></thead>
          <tbody>
            {batch.rows.map((row, i) => {
              const name = pick(row, 'Name', 'name') || '—';
              const drive = pick(row, 'Resume', 'driveLink', 'drive_link');
              return (
                <tr key={`${pick(row, 'Lead ID', 'leadId') || name}-${i}`}>
                  <td className="name" title={name}>{name}</td>
                  <td title={pick(row, 'Email Address', 'email')}>{pick(row, 'Email Address', 'email') || '—'}</td>
                  <td className="mono">{pick(row, 'Phone Number', 'phone') || '—'}</td>
                  <td>{pick(row, 'Platform', 'platform') || '—'}</td>
                  <td>{isHttps(drive) ? <a className="link" href={drive} target="_blank" rel="noopener noreferrer">Open<span className="sr-only"> the résumé of {name} in Drive</span></a> : <span className="hint">Not uploaded</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const count = (...values: unknown[]): number => {
  for (const v of values) if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
};

interface CommitSummaryProps {
  batch: Batch;
  run: RunState;
  running: boolean;
  queue: BatchQueue;
  onToast: ToastFn;
}

// What the commit did, under the run's counts: the live line while it runs, then the outcome and a retry when it failed. The
// CSV and the rows are kept either way (a commit failure never fails the run).
function CommitSummary({ batch, run, running, queue, onToast }: CommitSummaryProps) {
  const [busy, setBusy] = useState(false);
  const commit = batch.commit;
  if (running && commit?.enabled) return run.commitLine ? <p className="up-entry-line" role="status" aria-live="polite"><span>{run.commitLine}</span></p> : null;
  if (running) return null;
  // A cancelled run never reaches the commit: say so, instead of an empty "0 added".
  if (batch.status === 'cancelled') return <p className="up-entry-line"><span className="up-entry-result">Cancelled, nothing was added</span></p>;
  if (!commit?.enabled) return <p className="up-entry-line"><span className="hint">Not committed (the rows are in the CSV only).</span></p>;
  const result = batch.commitResult;
  if (!result) return null;
  const label = commit.campaignLabel || `campaign ${commit.campaignId}`;
  if (result.status === 'unsupported') {
    return <p className="up-entry-line up-entry-err" role="alert">This server cannot commit rows to a campaign. The CSV is still written.</p>;
  }
  if (result.status === 'failed') {
    const reason = String(result.lastError || 'unknown error').replace(/[.\s]+$/, '');
    const retry = async () => {
      setBusy(true);
      try {
        await queue.retryCommit(batch.id);
        onToast('Commit done');
      } catch (err) { onToast(errorMessage(err) || 'The commit could not be retried.', 'warn'); } finally { setBusy(false); }
    };
    return (
      <div className="up-entry-err">
        <p className="up-entry-line" role="alert"><span>Commit failed: {reason}.{result.tokenRejected ? ' The access token was refused: replace it in Settings, then retry.' : ''} Nothing was lost: the CSV is still written.</span></p>
        <span className="up-entry-actions">
          <button className="btn" type="button" onClick={retry} disabled={busy}><Icon name="refresh" size="sm" />{busy ? 'Retrying…' : 'Retry commit'}</button>
          {batch.csv && <button className="btn" type="button" onClick={() => downloadCsv(batch)}><Icon name="filetext" size="sm" />Download CSV</button>}
        </span>
      </div>
    );
  }
  if (result.status === 'running') return <p className="up-entry-line" role="status"><span>Adding the rows to {label}…</span></p>;
  const c = result.counts || {};
  const created = count(c.created, c.ready);
  // The server's counts: rows, ready, duplicate, conflict, invalid, inBatchDuplicates, created, skipped.
  // "Duplicates" is what the campaign already had plus what the server dropped before sending (the same person twice).
  const sinkDup = count(c.duplicate);
  const batchDup = count(c.inBatchDuplicates);
  const dup = sinkDup + batchDup;
  const conflict = count(c.conflict);
  const invalid = count(c.invalid);
  const dupDetail = `${sinkDup} already in the campaign, ${batchDup} repeated in this upload`;
  const extras = [dup > 0 && <span key="d" title={dupDetail}>{dup} duplicate{dup === 1 ? '' : 's'}</span>, conflict > 0 && <span key="c">{conflict} conflict{conflict === 1 ? '' : 's'}</span>, invalid > 0 && <span key="i">{invalid} invalid</span>].filter(Boolean);
  return (
    <p className="up-entry-line" role="status">
      <span className="up-entry-dots up-entry-result"><span>{created} added to {label}</span>{extras}</span>
    </p>
  );
}

interface EntryProps {
  batch: Batch;
  run: RunState;
  now: number;
  open: boolean;
  onToggle: () => void;
  queue: BatchQueue;
  onToast: ToastFn;
  onRows: (id: string) => void;
  isNew: boolean;
  ahead: number;
  showCost: boolean;
}

function Entry({ batch, run, now, open, onToggle, queue, onToast, onRows, isNew, ahead, showCost }: EntryProps) {
  const id = useId();
  const state = batchState(batch);
  const title = entryTitle(batch);
  const names = batch.files.map((f) => f.original || f.name);
  const running = batch.status === 'running';
  const finished = FINISHED.has(batch.status);
  const c = batch.counts;
  const elapsed = batch.startedAt ? ((batch.finishedAt || now) - batch.startedAt) / 1000 : null;
  const uploading = batch.files.filter((f) => f.status === 'uploading');
  const upPercent = uploading.length ? (batch.files.reduce((s, f) => s + (f.status === 'uploading' ? f.progress || 0 : 1), 0) / batch.files.length) * 100 : 0;
  const percent = percentOf(run.done, run.total);
  const cancelling = running && (queue.stopping || run.status === 'cancelling');
  const where = [batch.campaignType, batch.source || 'No source', batch.folderName || batch.driveFolderId].filter(Boolean);
  const canRetry = (batch.status === 'failed' || batch.status === 'cancelled') && readyFiles(batch).length > 0;

  function cancelQueued() {
    queue.cancelQueued(batch.id);
    onToast(`${title} cancelled. Its files stay in the input folder.`);
  }

  async function cancel() {
    try { await queue.cancel(); onToast('Cancelling this upload. The rest stay queued.'); } catch (err) { onToast(errorMessage(err) || 'The upload could not be cancelled.', 'warn'); }
  }

  return (
    <li className={`up-entry is-${state}${open ? ' is-open' : ''}${isNew ? ' is-new' : ''}`} onClick={(e) => { if (!(e.target as Element).closest('a, button, input')) onToggle(); }}>
      <button className="up-entry-head" type="button" aria-expanded={open} aria-controls={`${id}-d`} onClick={onToggle}>
        <span className="up-entry-name" title={names.join('\n')}>{title}</span>
        <span className={STATE[state]?.cls || 'pill'}>{STATE[state]?.label || state}</span>
        {finished
          ? <span className="up-entry-sub">{[batch.source || 'No source', batch.finishedAt && clock(batch.finishedAt), elapsed != null && duration(elapsed), showCost && batch.cost && batch.cost.usd > 0 && money(batch.cost.usd)].filter((w): w is string => Boolean(w)).map((w) => <span key={w}>{w}</span>)}</span>
          : <span className="up-entry-sub">{where.map((w) => <span key={w}>{w}</span>)}</span>}
        {!finished && (
          <span className="up-entry-time tnum">
            {elapsed != null ? <><span className="sr-only">elapsed </span>{duration(elapsed)}</> : state === 'uploading' ? `${Math.round(upPercent)}%` : ''}
          </span>
        )}
      </button>

      {running && (
        <div className="up-entry-live">
          <span className="up-entry-progress">
            <DotTrack parts={percent} rows={3} label={`${Math.round(percent)} percent`} />
            <span className="up-entry-count" aria-hidden="true"><LedNumber value={run.done} className="" /><span>/ {run.total || '—'}</span></span>
          </span>
          <span className="up-entry-line" role="status" aria-live="polite">
            <span>{cancelling ? 'Cancelling' : PHASE_LABEL[run.phase] || 'Starting'}{run.total > 0 ? ` · ${run.done} of ${run.total} parsed` : ''}</span>
            {!cancelling && <button className="link" type="button" onClick={cancel}>Cancel</button>}
          </span>
        </div>
      )}
      {state === 'uploading' && <DotTrack parts={upPercent} rows={1} label={`Copying to the server, ${Math.round(upPercent)} percent`} />}
      {batch.status === 'queued' && (
        <p className="up-entry-line">
          <span>{state === 'uploading' ? 'Copying to the server' : ahead ? `Waiting · ${ahead} ahead` : queue.paused ? 'Waiting for Resume' : 'Next up'}</span>
          <button className="link" type="button" onClick={cancelQueued}>Cancel<span className="sr-only"> {title}</span></button>
        </p>
      )}

      {c && batch.status !== 'failed' && (c.uploaded < c.parsed || c.reused > 0 || c.quarantined > 0) && (
        <p className="up-entry-line">
          <span className="up-entry-dots">
            <span>{c.parsed} read, {c.uploaded} uploaded</span>
            {c.reused > 0 && <span>{c.reused} reused</span>}
            {c.quarantined > 0 && <span className="warn">{c.quarantined} quarantined</span>}
          </span>
        </p>
      )}
      {c && c.uploadFailed > 0 && batch.status !== 'failed' && (
        <p className="up-entry-line warn" role="alert">
          {c.uploadFailed} résumé{c.uploadFailed === 1 ? ' was' : 's were'} not uploaded to Drive, so {c.uploadFailed === 1 ? 'its row has' : 'their rows have'} no résumé link. Check the Google token in Settings, then run {c.uploadFailed === 1 ? 'it' : 'them'} again.
        </p>
      )}
      {(running || batch.commit || batch.commitResult) && batch.status !== 'failed' && (
        <CommitSummary batch={batch} run={run} running={running} queue={queue} onToast={onToast} />
      )}
      {batch.status === 'failed' && batch.error && !open && <p className="up-entry-line up-entry-err">{batch.error}</p>}

      {open && (
        <div className="up-entry-detail" id={`${id}-d`}>
          {names.length > 1 && <p className="up-entry-files mono">{names.join(', ')}</p>}
          {batch.jd?.on || batch.jd?.dryRun ? (
            <p className="help">{[batch.jd.on && `JD filter, reject below ${batch.jd.threshold}`, batch.jd.dryRun && 'dry run'].filter(Boolean).join(' · ')}</p>
          ) : null}
          {batch.error && <p className="up-entry-err" role="alert">{batch.error}</p>}
          {batch.status === 'done' && c?.rows === 0 && <p className="help">No candidates came out of this upload.</p>}
          <span className="up-entry-actions">
            {batch.rows.length > 0 && <button className="btn" type="button" onClick={() => onRows(batch.id)} aria-haspopup="dialog"><Icon name="table" size="sm" />{plural(batch.rows.length, 'row')}</button>}
            {batch.csv && <button className="btn" type="button" onClick={() => downloadCsv(batch)}><Icon name="filetext" size="sm" />Download CSV</button>}
            {canRetry && <button className="btn" type="button" onClick={() => { const msg = queue.retry(batch.id); onToast(msg ? 'This upload cannot run again' : 'Queued again', msg ? 'warn' : undefined); }}><Icon name="refresh" size="sm" />Run again</button>}
            {batch.status === 'queued' && <button className="btn" type="button" onClick={() => { queue.remove(batch.id); onToast('Removed from the queue. Its files stay in the input folder.'); }}><Icon name="x" size="sm" />Remove</button>}
            {finished && <button className="btn up-entry-remove" type="button" onClick={() => queue.remove(batch.id)}><Icon name="x" size="sm" />Remove from list</button>}
          </span>
        </div>
      )}
    </li>
  );
}

interface ActivityListProps {
  queue: BatchQueue;
  run: RunState;
  onToast: ToastFn;
  showCost?: boolean;
}

// The right column: every upload of this browser, oldest first (the order they run in).
export function ActivityList({ queue, run, onToast, showCost = false }: ActivityListProps) {
  const { batches } = queue;
  const listRef = useRef<HTMLElement>(null);
  const [mountedAt] = useState(() => Date.now());
  const count = batches.length;
  const lastCount = useRef(count);
  // A new entry slides in at the bottom: keep it in view.
  useEffect(() => {
    if (count > lastCount.current && listRef.current) {
      const still = document.documentElement.classList.contains('perf') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: still ? 'auto' : 'smooth' });
    }
    lastCount.current = count;
  }, [count]);
  const [openId, setOpenId] = useState('');
  const [rowsFor, setRowsFor] = useState('');
  const runningEntry = batches.find((b) => b.status === 'running');
  const now = useNow(Boolean(runningEntry));
  const queued = batches.filter((b) => b.status === 'queued').length;
  const finished = batches.filter((b) => FINISHED.has(b.status)).length;
  const doneInSession = batches.filter((b) => queue.session.includes(b.id) && FINISHED.has(b.status)).length;

  let headline = 'Idle';
  if (runningEntry) headline = `Running ${doneInSession + 1} of ${doneInSession + 1 + queued}`;
  else if (queue.paused && queued) headline = 'Paused';
  else if (queued) headline = 'Starting';

  const rowsBatch = batches.find((b) => b.id === rowsFor);

  return (
    <aside ref={listRef} className="board-col console on-inset up-activity resolve" style={{ '--r': 3 } as CSSProperties} aria-labelledby="up-act-h">
      <div className="sec-head">
        <h2 className="sec-title" id="up-act-h">Activity</h2><span className="sec-lead" aria-hidden="true" />
        <span className="up-act-state" role="status" aria-live="polite">
          <span className={`led${runningEntry ? ' ok up-pulse' : queue.paused && queued ? '' : ' idle'}`} aria-hidden="true" />{headline}
        </span>
      </div>
      {batches.length > 0 && (
        <p className="sec-desc up-act-desc">
          <span>{[queued && `${queued} queued`, finished && `${finished} finished`, !queued && !finished && runningEntry && '1 running'].filter(Boolean).join(' · ')}</span>
          {queue.paused && queued > 0 && !queue.active && <button className="link" type="button" onClick={queue.resume}>Resume</button>}
          {finished > 0 && <button className="link" type="button" onClick={queue.clearFinished}>Clear finished</button>}
        </p>
      )}
      {queue.paused && queued > 0 && !queue.active && (
        <p className="help up-act-note">{queue.paused === 'restored' ? 'These were queued before the page was reloaded.' : queue.paused === 'cancelled' ? 'Paused after a cancel.' : 'Paused: the server did not take the last upload.'} Resume runs them in order.</p>
      )}

      {batches.length === 0 ? (
        <div className="up-act-empty"><EmptyPanel title="No uploads yet">Uploads run here one at a time, in order.</EmptyPanel></div>
      ) : (
        <ol className="up-entries" aria-label="Uploads">
          {batches.map((b) => (
            <Entry key={b.id} showCost={showCost} batch={b} run={run} now={now} open={openId === b.id} queue={queue} onToast={onToast}
              isNew={b.createdAt > mountedAt}
              ahead={b.status === 'queued' ? batches.filter((x) => x.status === 'running' || (x.status === 'queued' && batches.indexOf(x) < batches.indexOf(b))).length : 0}
              onToggle={() => setOpenId((cur) => (cur === b.id ? '' : b.id))} onRows={setRowsFor} />
          ))}
        </ol>
      )}

      {rowsBatch && <RowsDialog batch={rowsBatch} onClose={() => setRowsFor('')} />}
    </aside>
  );
}
