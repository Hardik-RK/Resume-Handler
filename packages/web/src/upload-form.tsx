import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent, FormEvent, ReactNode } from 'react';
import { Icon } from './ds/icon';
import { LedNumber } from './ds/led-number';
import { CrumbMenu } from './ds/crumb-menu';
import { ACCEPT, groupFiles, newId } from './queue-logic';
import { bytes, listZipEntries, normaliseCampaigns } from './format';
import type { ZipEntry } from './format';
import { TYPE_LABELS, campaignLabel, groupCampaigns, typeBadgeClass } from './campaigns';
import type { Campaign, FormFile } from './lib/types';
import type { BatchQueue } from './use-batch-queue';
import type { ResumeEngine } from './use-resume-engine';

const PICK = '.zip,.pdf,application/zip,application/x-zip-compressed,application/pdf';
const DEFAULT_TYPES = ['TECH', 'TEACHER', 'SALES'];
// Where résumés come from, until a list of your own is saved under Manage.
const DEFAULT_SOURCES = ['LinkedIn', 'Unstop', 'Indeed', 'Shine', 'Naukri'];

// The campaign (and source) of the previous upload, remembered in this browser: it is the default for the next one, and
// choosing it again asks for a confirmation so the same campaign is never picked by habit.
const LAST_KEY = 'resume-intake-last';
interface Last { campaignId: number | string; label: string; source: string }
const readLast = (): Last | null => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null') as Last | null; } catch { return null; } };
const writeLast = (value: Last): void => { try { localStorage.setItem(LAST_KEY, JSON.stringify(value)); } catch { /* storage blocked */ } };

// State of the form for the next upload. Every field starts empty and is emptied again after each submission, so a value
// chosen for one zip can never travel to the next one by accident. There is no screening on this page: every upload runs
// without the JD filter (the server keeps supporting it, but it is not offered here).
export function useUploadForm() {
  const [files, setFiles] = useState<FormFile[]>([]);
  const [campaignType, setCampaignType] = useState('');
  const [source, setSource] = useState('');
  const [message, setMessage] = useState('');
  // Commit the rows to the campaign: on by default when the server has a sink configured (null = follow that default).
  const [commitChoice, setCommitChoice] = useState<boolean | null>(null);
  const [campaignId, setCampaignId] = useState('');

  const addFiles = useCallback((list: ArrayLike<{ name: string; size: number }> | null | undefined, { resident = false }: { resident?: boolean } = {}) => {
    const all = Array.from(list || []);
    const picked = all.filter((f) => ACCEPT.test(f.name));
    const rejected = all.length - picked.length;
    let added = 0;
    setFiles((current) => {
      const names = new Set(current.map((f) => f.name.toLowerCase()));
      const next = [...current];
      for (const f of picked) {
        if (names.has(f.name.toLowerCase())) continue;
        names.add(f.name.toLowerCase());
        next.push({ key: newId('p'), name: f.name, size: f.size, ...(resident ? { resident: true } : { file: f as File }) });
        added += 1;
      }
      return next;
    });
    setMessage([
      picked.length ? `${picked.length} file${picked.length === 1 ? '' : 's'} added.` : '',
      rejected ? `${rejected} file${rejected === 1 ? ' was' : 's were'} skipped: only ZIP and PDF files can be uploaded.` : '',
    ].filter(Boolean).join(' '));
    return { added, rejected };
  }, []);

  const removeFile = useCallback((key: string) => setFiles((list) => list.filter((f) => f.key !== key)), []);

  const reset = useCallback(() => {
    setFiles([]); setCampaignType(''); setSource(''); setMessage(''); setCampaignId('');
  }, []);

  return {
    files, campaignType, source, message, commitChoice, campaignId,
    setCampaignType, setSource, setMessage, setCommitChoice, setCampaignId, addFiles, removeFile, reset,
  };
}

export type UploadFormState = ReturnType<typeof useUploadForm>;

interface Option { value: string; label: string }

// The other dropdowns of the form use the same menu as the campaign breadcrumb (CrumbMenu) instead of the browser's own list.
function FieldMenu({ id, label, value, options, placeholder, onChange, disabled, flagged = false }: {
  id: string; label: string; value: string; options: Option[]; placeholder: string; onChange: (value: string) => void; disabled?: boolean; flagged?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <CrumbMenu id={`${id}-menu`} triggerId={id} triggerClass={`up-field-btn${flagged ? ' is-flagged' : ''}`} menuClass="up-menu" matchWidth disabled={disabled}
      label={current ? current.label : placeholder} ariaLabel={`${label}: ${current ? current.label : placeholder}`}>
      {(close) => options.map((o) => (
        <button key={o.value || 'none'} className="menu-item" role="menuitemradio" type="button" aria-checked={o.value === value} onClick={() => { close(); onChange(o.value); }}>
          <span>{o.label}</span><Icon name="check" className="mi-check" />
        </button>
      ))}
    </CrumbMenu>
  );
}

// The campaign choice as a breadcrumb. Before a choice there is one crumb listing every campaign; after it, the group crumb
// (when campaigns have groups) lists them all and the campaign crumb lists its siblings.
function CampaignCrumbs({ list, value, onPick }: { list: Campaign[]; value: string; onPick: (id: string) => void }) {
  const current = list.find((c) => String(c.id) === value);
  const groups = useMemo(() => groupCampaigns(list), [list]);
  const row = (c: Campaign, close: () => void) => (
    <button key={c.id} className="menu-item has-badge" role="menuitemradio" type="button" aria-checked={String(c.id) === String(current?.id)} onClick={() => { close(); onPick(String(c.id)); }}>
      <span>{c.name}</span>
      {c.type && <span className={`mi-type ${typeBadgeClass(c.type)}`}>{TYPE_LABELS[c.type] || c.type}</span>}
      <Icon name="check" className="mi-check" />
    </button>
  );
  const all = (close: () => void) => (
    <>
      {groups.map((g) => (
        <div key={g.key}>
          {g.name && <div className="menu-group" role="presentation"><span>{g.name}</span></div>}
          {g.items.map((c) => row(c, close))}
        </div>
      ))}
    </>
  );
  if (!current) {
    return (
      <nav className="crumbs up-crumbs" aria-label="Campaign for the new rows">
        <CrumbMenu id="up-campaign-all" menuClass="up-menu" anchor=".up-target" matchWidth triggerClass="crumb up-placeholder" label="Choose a campaign" ariaLabel="Choose the campaign for the new rows">{all}</CrumbMenu>
      </nav>
    );
  }
  const siblings = list.filter((c) => (c.group || '') === (current.group || ''));
  return (
    <nav className="crumbs up-crumbs" aria-label="Campaign for the new rows">
      {current.group && (
        <>
          <CrumbMenu id="up-client-menu" menuClass="up-menu" anchor=".up-target" matchWidth label={current.group} ariaLabel={`Switch group, current: ${current.group}`}>{all}</CrumbMenu>
          <span className="crumb-sep" aria-hidden="true">/</span>
        </>
      )}
      <CrumbMenu id="up-campaign-menu" menuClass="up-menu" anchor=".up-target" matchWidth isTitle label={current.name} ariaLabel={`Switch campaign, current: ${current.name}`}>
        {(close) => (
          <>
            {current.group
              ? <p className="menu-label">Campaigns in <strong>{current.group}</strong></p>
              : null}
            {(current.group ? siblings : list).map((c) => row(c, close))}
          </>
        )}
      </CrumbMenu>
      {current.type && <span className={typeBadgeClass(current.type)}>{TYPE_LABELS[current.type] || current.type}</span>}
    </nav>
  );
}

// The drop cue in the site's dot-matrix style (the lattice of EmptyPanel): an arrow over a tray, lit on a 9 x 9 grid at 4px pitch.
const DM_ARROW = ['4,0', '3,1', '4,1', '5,1', '2,2', '3,2', '4,2', '5,2', '6,2', '4,3', '4,4', '4,5'];
const DM_TRAY = ['1,6', '7,6', '1,7', '2,7', '3,7', '4,7', '5,7', '6,7', '7,7'];
const dmPath = (cells: string[]): string => cells.map((c) => { const [x, y] = c.split(',').map(Number); return `M${x * 4 + 2} ${y * 4 + 2}h0`; }).join('');
const DM_OFF = (() => {
  const lit = new Set([...DM_ARROW, ...DM_TRAY]);
  const off: string[] = [];
  for (let x = 0; x < 9; x += 1) for (let y = 0; y < 9; y += 1) if (!lit.has(`${x},${y}`)) off.push(`${x},${y}`);
  return dmPath(off);
})();

function DropGlyph() {
  return (
    <svg className="dm up-dm" viewBox="0 0 36 36" aria-hidden="true">
      <path className="off" d={DM_OFF} />
      <path className="on up-dm-tray" d={dmPath(DM_TRAY)} />
      <path className="on up-dm-arrow" d={dmPath(DM_ARROW)} />
    </svg>
  );
}

interface ZipInfo {
  open: boolean;
  status: 'loading' | 'ready' | 'error';
  entries: ZipEntry[];
  note?: string;
}

interface UploadFormProps {
  form: UploadFormState;
  engine: ResumeEngine;
  queue: BatchQueue;
  dragOver: boolean;
  notices: ReactNode;
  onManageSources: () => void;
  onSubmitted: (count: number) => void;
}

// The next upload, as two columns of the page grid: the drop tray with the picked files, and the destination form with the
// one primary button. Both columns read the same form state (useUploadForm in the page).
export function UploadForm({ form, engine, queue, dragOver, notices, onManageSources, onSubmitted }: UploadFormProps) {
  const ids = { dest: useId(), files: useId(), dropHelp: useId(), type: useId(), source: useId(), reason: useId(), drop: useId(), commit: useId(), campaign: useId() };
  const input = useRef<HTMLInputElement>(null);
  const browse = useRef<HTMLButtonElement>(null);
  const [localOver, setLocalOver] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (!sent) return undefined;
    const timer = setTimeout(() => setSent(false), 700);
    return () => clearTimeout(timer);
  }, [sent]);
  const cfg = engine.settings?.config;
  const campaigns = useMemo(() => normaliseCampaigns(cfg?.campaigns), [cfg?.campaigns]);
  const sourceOptions = queue.sources.length ? queue.sources : DEFAULT_SOURCES;
  const types = Array.isArray(cfg?.campaignTypes) && cfg.campaignTypes.length ? cfg.campaignTypes : DEFAULT_TYPES;
  const { files } = form;
  const over = dragOver || localOver;
  const groups = groupFiles(files);
  const inForm = new Set(files.map((f) => f.name));
  const waiting = queue.orphans.filter((o) => !inForm.has(o.name));   // input-folder files not yet in the form or the queue
  const google = engine.engineInfo?.google;
  const sinkConfigured = Boolean(engine.engineInfo?.commit?.configured);
  const commitOn = form.commitChoice ?? sinkConfigured;
  const [zips, setZips] = useState<Record<string, ZipInfo>>({});
  const [last, setLast] = useState<Last | null>(null);       // the previous upload
  const [confirming, setConfirming] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => { setLast(readLast()); }, []);

  // New files dropped into the server's input folder show up on their own: a light check every few seconds while the tab is
  // visible, and at once when the window is focused again.
  const refreshFiles = engine.refreshFiles;
  useEffect(() => {
    if (!engine.live) return undefined;
    const check = () => { if (document.visibilityState === 'visible') refreshFiles().catch(() => {}); };
    const timer = setInterval(check, 4000);
    window.addEventListener('focus', check);
    return () => { clearInterval(timer); window.removeEventListener('focus', check); };
  }, [engine.live, refreshFiles]);

  function toggleZip(entry: FormFile) {
    const current = zips[entry.key];
    if (current) { setZips((all) => ({ ...all, [entry.key]: { ...current, open: !current.open } })); return; }
    if (!entry.file) {
      // A zip that lives in the server's input folder: the server lists its file names.
      const names = engine.files?.find((x) => x.name === entry.name)?.entries;
      setZips((all) => ({ ...all, [entry.key]: Array.isArray(names)
        ? { open: true, status: 'ready', entries: names.map((n) => ({ name: n })) }
        : { open: true, status: 'error', entries: [], note: 'This zip could not be read.' } }));
      return;
    }
    setZips((all) => ({ ...all, [entry.key]: { open: true, status: 'loading', entries: [] } }));
    listZipEntries(entry.file)
      .then((entries) => setZips((all) => ({ ...all, [entry.key]: { open: true, status: 'ready', entries } })))
      .catch((err: unknown) => setZips((all) => ({ ...all, [entry.key]: { open: true, status: 'error', entries: [], note: (err as Error)?.message || 'The zip could not be read.' } })));
  }

  // The Drive folder is never chosen here: it is the chosen campaign's own folder, when its entry in Settings names one.
  const chosen = campaigns.find((c) => String(c.id) === String(form.campaignId)) || null;

  const sameAsLast = Boolean(commitOn && last && chosen && String(last.campaignId) === String(chosen.id));

  // Choosing the campaign fills its type (still editable).
  const pickCampaign = useCallback((id: string) => {
    form.setCampaignId(String(id));
    const campaign = campaigns.find((c) => String(c.id) === String(id));
    if (campaign?.type && types.includes(campaign.type)) form.setCampaignType(campaign.type);
  }, [campaigns, form, types]);

  // The default is the campaign of the previous upload (once the list has loaded and nothing is chosen yet).
  useEffect(() => {
    if (form.campaignId || !last) return;
    if (campaigns.some((c) => String(c.id) === String(last.campaignId))) pickCampaign(String(last.campaignId));
  }, [campaigns, form.campaignId, last, pickCampaign]);
  // Any change to what was about to be confirmed cancels the confirmation.
  // The repeat-campaign confirmation cannot be clicked through: the button stays locked for a moment so the message gets read.
  useEffect(() => {
    setArmed(false);
    if (!confirming) return undefined;
    const timer = setTimeout(() => setArmed(true), 1800);
    return () => clearTimeout(timer);
  }, [confirming]);
  useEffect(() => { setConfirming(false); }, [form.campaignId, form.source, form.campaignType, commitOn, files.length]);

  const reason = (() => {
    if (!files.length) return 'Add a zip or PDF to upload.';
    if (!engine.live) return 'Waiting for the server to reconnect.';
    if (!form.campaignType) return 'Choose a campaign type.';
    if (commitOn && !form.campaignId) return 'Choose the campaign the new rows go to.';
    if (!form.source || !sourceOptions.includes(form.source)) return 'Choose where the résumés came from.';
    if (chosen?.driveFolderId && google && google.ok === false) return 'Google Drive is not usable right now. Add the Google token in Settings.';
    return '';
  })();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (reason) return;
    if (sameAsLast && !confirming) { setConfirming(true); return; }
    const n = queue.submit({
      files, campaignType: form.campaignType, source: form.source, driveFolderId: chosen?.driveFolderId || '', folderName: chosen?.name || '',
      jd: { on: false, text: '', threshold: 0, dryRun: false },
      commit: { enabled: commitOn, campaignId: chosen ? chosen.id : null, campaignLabel: chosen ? campaignLabel(chosen) : '' },
    });
    const remembered: Last | null = commitOn && chosen ? { campaignId: chosen.id, label: campaignLabel(chosen), source: form.source } : null;
    if (remembered) { writeLast(remembered); setLast(remembered); }
    setConfirming(false);
    form.reset();
    setSent(true);
    onSubmitted(n);
    browse.current?.focus();
  }

  const label = groups.length > 1 ? `Add ${groups.length} uploads to the queue` : 'Add to queue';
  const after = queue.paused ? 'The queue is paused: it runs after Resume in Activity.'
    : queue.active ? 'It runs after the uploads ahead of it.' : 'It starts right away.';
  const skipped = /skipped/.test(form.message);
  const openPicker = () => input.current?.click();
  const onDrop = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setLocalOver(false); form.addFiles(e.dataTransfer.files); };

  return (
    <>
      <section className="board-col up-col up-drop-col resolve" style={{ '--r': 1 } as React.CSSProperties} aria-labelledby={ids.drop}>
        <div className="sec-head"><h2 className="sec-title" id={ids.drop}>Add files</h2><span className="sec-lead" aria-hidden="true" /></div>
        <div className={`up-drop${files.length ? ' has-files' : ''}${over ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setLocalOver(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLocalOver(false); }}
          onDrop={onDrop}
          onClick={(e) => { if (!(e.target as Element).closest('button, a')) openPicker(); }}>
          <div className="up-drop-cue">
            {files.length > 0 && !over ? (
              <span className="up-drop-count" aria-hidden="true">
                <LedNumber value={files.length} className="up-drop-n" />
                <span>{files.length === 1 ? 'file' : 'files'} · {groups.length} upload{groups.length === 1 ? '' : 's'}</span>
              </span>
            ) : <DropGlyph />}
            <b>{over ? 'Drop to add' : files.length ? 'Drop more files' : 'Drop résumé zips or PDFs'}</b>
            <span className="up-drop-sub" id={ids.dropHelp}>Each zip is one upload. Loose PDFs run together.</span>
            <button ref={browse} className="btn" type="button" aria-describedby={ids.dropHelp} onClick={openPicker}>Select files</button>
          </div>
          {(skipped || waiting.length > 0) && (
            <div className="up-drop-notes">
              {skipped && <span className="warn">{form.message}</span>}
              {waiting.length > 0 && (
                <div className="up-orphans">
                  <span className="up-orphans-text">
                    <b>{waiting.length} file{waiting.length === 1 ? ' is' : 's are'} in the server&apos;s input folder</b>
                    <span>Not queued yet.</span>
                  </span>
                  <button className="btn up-orphans-add" type="button" onClick={() => form.addFiles(waiting, { resident: true })}>
                    {waiting.length === 1 ? 'Add it' : `Add all ${waiting.length}`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <input ref={input} className="sr-only" type="file" multiple accept={PICK} tabIndex={-1} aria-hidden="true"
          onChange={(e) => { form.addFiles(e.target.files); e.target.value = ''; }} />
        <span className="sr-only" role="status" aria-live="polite">{form.message}</span>
      </section>

      <form className="board-col up-col up-form-col resolve" style={{ '--r': 2 } as React.CSSProperties} onSubmit={submit} aria-labelledby={ids.dest} noValidate>
        <div className="sec-head"><h2 className="sec-title" id={ids.dest}>New upload</h2><span className="sec-lead" aria-hidden="true" /></div>
        {notices}
        <div className="up-fields">
          <div className="up-field">
            <span className="up-lbl-row">
              <span className="lbl" id={ids.campaign}>Campaign{sameAsLast && !confirming && <span className="up-lbl-note">Last used</span>}</span>
              <span className="up-switch">
                <label htmlFor={ids.commit}>Commit rows</label>
                <button id={ids.commit} className="tswitch" type="button" role="switch" aria-checked={commitOn} disabled={!sinkConfigured}
                  title={sinkConfigured ? undefined : 'No downstream system is configured in Settings'}
                  onClick={() => form.setCommitChoice(!commitOn)} />
              </span>
            </span>
            {campaigns.length > 0 ? (
              <div className={`up-target${confirming ? ' is-flagged' : ''}`} title={chosen ? campaignLabel(chosen) : undefined}
                onClick={(e) => { if (!(e.target as Element).closest('.crumb, .menu')) e.currentTarget.querySelector<HTMLElement>('.crumb.is-title, .crumb')?.click(); }}>
                <CampaignCrumbs list={campaigns} value={form.campaignId} onPick={pickCampaign} />
              </div>
            ) : <span className="help">No campaigns are set up yet. Add them under Settings.</span>}
            {!commitOn && <span className="up-note">{sinkConfigured ? 'Nothing is committed.' : 'No downstream system is set up.'} The rows are written to the results CSV only.</span>}
          </div>
          <div className="up-pair">
            <div className="up-field">
              <span className="up-lbl-row"><label className="lbl" htmlFor={ids.type}>Campaign type</label></span>
              <FieldMenu id={ids.type} label="Campaign type" value={form.campaignType} placeholder="Choose" options={types.map((t) => ({ value: t, label: TYPE_LABELS[t] || t }))} onChange={form.setCampaignType} />
            </div>
            <div className="up-field">
              <span className="up-lbl-row">
                <label className="lbl" htmlFor={ids.source}>Source</label>
                <button className="link" type="button" onClick={onManageSources} aria-haspopup="dialog">Manage</button>
              </span>
              <FieldMenu id={ids.source} label="Source" value={sourceOptions.includes(form.source) ? form.source : ''} placeholder="Choose" flagged={confirming} options={sourceOptions.map((x) => ({ value: x, label: x }))} onChange={form.setSource} />
            </div>
          </div>
          <div className="up-field up-files-field">
            <span className="up-lbl-row">
              <span className="lbl" id={ids.files}>Files</span>
              {files.length > 0 && <button className="link" type="button" onClick={() => files.forEach((f) => form.removeFile(f.key))}>Clear</button>}
            </span>
            {files.length > 0 ? (
              <ul className="up-files" aria-labelledby={ids.files}>
                {files.map((f, i) => {
                  const zip = /\.zip$/i.test(f.name);
                  const info = zips[f.key];
                  const open = zip && info?.open;
                  return (
                    <li key={f.key} className={open ? 'is-open' : ''} style={{ '--i': i } as React.CSSProperties}>
                      <div className="up-frow">
                        <span className={`up-ftype${zip ? ' zip' : ''}`} aria-hidden="true">{zip ? 'ZIP' : 'PDF'}</span>
                        {zip
                          ? <button className="up-fname up-fopen" type="button" aria-expanded={Boolean(open)} title={f.name} onClick={() => toggleZip(f)}><span>{f.name}</span><Icon name="chevron" size="sm" /></button>
                          : <span className="up-fname" title={f.name}>{f.name}</span>}
                        <span className="up-fsize tnum">{f.resident ? 'Input folder' : bytes(f.size)}</span>
                        <button className="btn btn-icon btn-bare up-fx" type="button" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => form.removeFile(f.key)}><Icon name="x" size="sm" /></button>
                      </div>
                      {open && info && (
                        <ul className="up-zip" aria-label={`Files in ${f.name}`}>
                          {info.status === 'loading' && <li className="up-zip-note">Reading…</li>}
                          {info.status === 'error' && <li className="up-zip-note">{info.note}</li>}
                          {info.status === 'ready' && info.entries.length === 0 && <li className="up-zip-note">No files inside.</li>}
                          {info.status === 'ready' && info.entries.map((e) => (
                            <li key={e.name}><span className="up-zname" title={e.name}>{e.name}</span></li>
                          ))}
                          {info.status === 'ready' && info.entries.length > 0 && <li className="up-zip-note">{info.entries.length} file{info.entries.length === 1 ? '' : 's'}</li>}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : <p className="up-files-empty">None yet</p>}
          </div>
        </div>
        <div className={`up-submit-row${confirming ? ' is-confirming' : ''}`}>
          <button className={`btn btn-primary up-submit${sent ? ' is-sent' : ''}`} type="submit" disabled={Boolean(reason) || (confirming && !armed)} aria-describedby={ids.reason}><Icon name="send" size="sm" />{confirming ? (armed ? 'Add anyway' : 'Check the details first…') : label}</button>
          <span className={`up-reason${reason && files.length ? ' is-block' : ''}${confirming ? ' is-warn' : ''}`} id={ids.reason} aria-live="polite">{reason || (confirming && last ? `The last upload also went to ${last.label}${last.source ? ` from ${last.source}` : ''}. Check the campaign and the source before adding it again.` : after)}</span>
        </div>
      </form>
    </>
  );
}
