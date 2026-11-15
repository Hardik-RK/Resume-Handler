import { Fragment, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from './ds/icon';
import { Dialog } from './ds/dialog';
import { money } from './format';
import { dayKey, readHistory, summariseCosts } from './history';
import type { Costs, DayRow, Period, SplitRow } from './history';
import type { HistoryRecord } from './lib/types';

// History: the recent uploads of this browser, grouped by day, with what they cost: the spend today, this week, this month and
// overall, a bar per day, and where it went (campaign or source), with a cost on each row. It is kept in this browser only.
const DAY = 86400000;
const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const dayLabel = (key: string): string => {
  const today = dayKey(new Date());
  if (key === today) return 'Today';
  if (key === dayKey(new Date(Date.now() - DAY))) return 'Yesterday';
  return new Date(`${key}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
};
const STATUS: Record<string, [string, string]> = { done: ['Done', 'ok'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', 'idle'] };
type SplitKey = 'campaign' | 'source';
const SPLITS: Array<[SplitKey, string, 'byCampaign' | 'bySource']> = [['campaign', 'Campaign', 'byCampaign'], ['source', 'Source', 'bySource']];

function Summary({ costs }: { costs: Costs }) {
  const cells: Array<[string, Period]> = [['Today', costs.today], ['Last 7 days', costs.week], ['Last 30 days', costs.month], ['All time', costs.allTime]];
  return (
    <div className="rh-summary">
      {cells.map(([label, p]) => (
        <div key={label} className="rh-cell">
          <span className="rh-label">{label}</span>
          <strong className="tnum">{money(p.usd)}</strong>
          <span className="rh-sub tnum">{p.runs} run{p.runs === 1 ? '' : 's'} · {p.resumes} résumés{p.resumes > 0 ? ` · ${money(p.usd / p.resumes)} each` : ''}</span>
        </div>
      ))}
    </div>
  );
}

function PerDay({ rows }: { rows: DayRow[] }) {
  const days = useMemo(() => {
    const have = new Map(rows.map((r) => [r.day, r]));
    return Array.from({ length: 14 }, (_, i) => {
      const key = dayKey(new Date(Date.now() - (13 - i) * DAY));
      return { key, usd: have.get(key)?.usd || 0, runs: have.get(key)?.runs || 0 };
    });
  }, [rows]);
  const peak = Math.max(...days.map((d) => d.usd), 0);
  return (
    <section className="rh-panel" aria-label="Spend per day">
      <h3 className="rh-h">Per day <span>last 14 days{peak > 0 ? ` · peak ${money(peak)}` : ''}</span></h3>
      <div className="rh-bars">
        {days.map((d) => (
          <span key={d.key} className={`rh-bar${d.usd > 0 ? '' : ' is-empty'}${d.key === dayKey(new Date()) ? ' is-today' : ''}`} title={`${dayLabel(d.key)}: ${money(d.usd)}, ${d.runs} run${d.runs === 1 ? '' : 's'}`}>
            <i style={{ height: `${peak > 0 && d.usd > 0 ? Math.max(8, (d.usd / peak) * 100) : 0}%` }} />
            <small>{Number(d.key.slice(8))}</small>
          </span>
        ))}
      </div>
    </section>
  );
}

function Where({ costs }: { costs: Costs }) {
  const [by, setBy] = useState<SplitKey>('campaign');
  const key = SPLITS.find((s) => s[0] === by)?.[2] ?? 'byCampaign';
  const rows: SplitRow[] = costs[key] || [];
  const total = rows.reduce((s, r) => s + r.usd, 0);
  return (
    <section className="rh-panel" aria-label="Where the spend went">
      <h3 className="rh-h">Where it went <span>last 30 days</span></h3>
      <div className="rh-tabs" role="group" aria-label="Group by">
        {SPLITS.map(([id, label]) => <button key={id} type="button" className={id === by ? 'is-on' : ''} aria-pressed={id === by} onClick={() => setBy(id)}>{label}</button>)}
      </div>
      {rows.length === 0 ? <p className="rh-none">Nothing in the last 30 days.</p> : (
        <ul className="rh-rows">
          {rows.map((r) => (
            <li key={r.name || '-'}>
              <span className="rh-row-name" title={r.name}>{r.name || '—'}</span>
              <span className="rh-row-meta tnum">{r.runs} run{r.runs === 1 ? '' : 's'} · {r.resumes} résumés</span>
              <span className="rh-row-cost tnum">{money(r.usd)}</span>
              <i className="rh-row-bar" style={{ width: `${total > 0 ? Math.max(2, (r.usd / total) * 100) : 0}%` } as CSSProperties} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Runs({ runs }: { runs: HistoryRecord[] }) {
  const groups = useMemo(() => {
    const out: Array<{ key: string; rows: HistoryRecord[] }> = [];
    for (const r of [...runs].reverse()) {
      const key = r.finishedAt ? dayKey(new Date(r.finishedAt)) : '';
      if (!out.length || out[out.length - 1].key !== key) out.push({ key, rows: [] });
      out[out.length - 1].rows.push(r);
    }
    return out;
  }, [runs]);
  if (!runs.length) return <p className="rh-none">No uploads yet. Finished uploads are listed here.</p>;
  return (
    <div className="rh-table-wrap">
      <table className="rh-table" aria-label="Recent uploads">
        <thead>
          <tr>
            <th scope="col">Time</th><th scope="col">Campaign</th><th scope="col">Source</th><th scope="col">Files</th>
            <th scope="col" className="num">Résumés</th><th scope="col" className="num">Cost</th><th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.key || 'none'}>
              <tr className="rh-day"><th scope="colgroup" colSpan={7}>{g.key ? dayLabel(g.key) : 'Earlier'}<span>{g.rows.length} upload{g.rows.length === 1 ? '' : 's'} · {money(g.rows.reduce((s, r) => s + (r.usd || 0), 0))}</span></th></tr>
              {g.rows.map((r) => {
                const [label, tone] = STATUS[r.status] || [r.status, 'idle'];
                return (
                  <tr key={r.id}>
                    <td className="tnum">{r.finishedAt ? clock(r.finishedAt) : ''}</td>
                    <td className="rh-strong">{r.campaign || '—'}</td>
                    <td>{r.source || '—'}</td>
                    <td className="rh-files" title={r.files}>{r.files || '—'}</td>
                    <td className="num tnum">{r.resumes}</td>
                    <td className="num tnum">{money(r.usd)}</td>
                    <td><span className={`rh-state is-${tone}`}>{label}</span></td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryDialog({ onClose }: { onClose: () => void }) {
  const [records] = useState(() => readHistory());
  const costs = useMemo(() => summariseCosts(records), [records]);
  return (
    <Dialog open onClose={onClose} title="Upload history" size="xwide rh-dialog" actions={<button className="btn" type="button" onClick={onClose}>Close</button>}>
      <div className="rh">
        {records.length > 0 && (
          <>
            <Summary costs={costs} />
            <div className="rh-two"><PerDay rows={costs.byDay} /><Where costs={costs} /></div>
          </>
        )}
        <Runs runs={records} />
        {records.length > 0 && <p className="rh-none">History is kept in this browser only.</p>}
      </div>
    </Dialog>
  );
}

export function HistoryButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn act up-tool" type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Recent uploads"><Icon name="table" size="sm" />History</button>
      {open && <HistoryDialog onClose={() => setOpen(false)} />}
    </>
  );
}
