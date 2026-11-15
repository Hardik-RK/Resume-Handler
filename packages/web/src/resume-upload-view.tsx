import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { Icon } from './ds/icon';
import { EmptyPanel } from './ds/empty-panel';
import { useToast } from './ds/toast';
import { applyTheme, followSystemTheme, watchTheme } from './ds/prefs';
import type { Theme } from './ds/prefs';
import { useMenuGlide } from './ds/use-menu-glide';
import { errorMessage } from './lib/api';
import { normaliseCampaigns } from './format';
import { ConnectingPanel, SignInPanel, UnreachablePanel } from './state-panels';
import { UploadForm, useUploadForm } from './upload-form';
import { ActivityList } from './activity-list';
import { HistoryButton } from './runs-history';
import { FolderMenu, SettingsButton } from './header-actions';
import { SettingsDialog } from './settings-dialog';
import { SourcesDialog } from './run-settings';
import { useResumeEngine } from './use-resume-engine';
import type { ResumeEngine } from './use-resume-engine';
import { useBatchQueue } from './use-batch-queue';
import type { BatchQueue } from './use-batch-queue';

export const PRODUCT = 'Résumé Intake';

const ERROR_TITLE: Record<string, string> = {
  settings: 'The settings are not available',
  server: 'The server reported a problem',
};

const NOTICE_TEXT: Record<string, string> = {
  quota_exceeded: 'The OpenRouter quota is used up. Résumés not yet read wait for the next upload.',
};

const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types || []).includes('Files');

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 14h6M9 17.5h4" /></svg>
    </span>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  // watchTheme tracks every change of the <html> class (this toggle, the system preference).
  useEffect(() => { const stop = watchTheme(setTheme); const stopFollowing = followSystemTheme(); return () => { stop(); stopFollowing(); }; }, []);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className="btn btn-icon theme-toggle" type="button" aria-pressed={theme === 'dark'} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}
      onClick={() => { applyTheme(next); setTheme(next); }}>
      <Icon name="moon" className="icon-moon" /><Icon name="sun" className="icon-sun" />
    </button>
  );
}

// The page. The connection and the queue live in this component, so uploads go on while it is open; a reload stops the queue (the
// server finishes its current upload and the restored queue then waits for Resume).
export function ResumeUploadView() {
  useMenuGlide();
  const engine = useResumeEngine();
  const queue = useBatchQueue(engine);
  return <UploadBody engine={engine} queue={queue} />;
}

function UploadBody({ engine, queue }: { engine: ResumeEngine; queue: BatchQueue }) {
  const toast = useToast();
  const form = useUploadForm();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  const { phase, error, engine: info, settings, engineInfo, notices, live } = engine;
  const ready = phase === 'ready';
  const google = engineInfo?.google;
  const driveWanted = normaliseCampaigns(settings?.config.campaigns).some((c) => c.driveFolderId);

  const meta = ready && info
    ? []
    : [phase === 'unreachable' ? 'Server not reachable' : phase === 'unauthorized' ? 'Sign-in needed' : phase === 'error' ? 'Needs attention' : 'Connecting'];

  // Closing or reloading the tab stops the queue: warn while something runs or waits. The tab title shows a running upload.
  const busy = queue.active || queue.batches.some((b) => b.status === 'queued');
  useEffect(() => {
    document.title = queue.active ? `Running · ${PRODUCT}` : PRODUCT;
  }, [queue.active]);
  useEffect(() => {
    if (!busy) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  async function onOpenFolder(target: string, label: string) {
    try { await engine.openFolder(target); toast(`${label} folder opened`); } catch (err) { toast(errorMessage(err) || 'The folder could not be opened.', 'warn'); }
  }

  async function onSave(body: Parameters<ResumeEngine['saveSettings']>[0]) {
    const result = await engine.saveSettings(body);
    toast('Settings saved');
    return result;
  }

  function onSubmitted(n: number) {
    toast(`${n === 1 ? 'Added to the queue' : `${n} uploads added to the queue`}${queue.paused ? '. The queue is paused: press Resume to run it' : ''}`);
  }

  // The whole page accepts dropped files once the form is there; they go into the form, nothing starts by itself.
  const dropProps = ready ? {
    onDragEnter: (e: DragEvent) => { if (!hasFiles(e)) return; dragDepth.current += 1; setDragOver(true); },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragOver(false); },
    onDragOver: (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); },
    onDrop: (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current = 0; setDragOver(false); form.addFiles(e.dataTransfer.files); },
  } : {};

  // One-line notices above the form, in the flat strip style.
  interface Line { key: string; text: string; ok?: boolean; warn?: boolean; action?: [string, () => void] }
  const lines: Line[] = [];
  if (ready && !live) lines.push({ key: 'live', warn: true, text: 'Reconnecting to the server. A running upload keeps going on the server.' });
  if (ready && driveWanted && google && google.ok === false) lines.push({ key: 'g', warn: true, text: `Google Drive is not usable (${google.reason || 'token invalid'}). Dry runs still work. Add the Google token in Settings.` });
  if (ready && engineInfo?.llm && engineInfo.llm.ok === false) lines.push({ key: 'llm', warn: true, text: 'The language model cannot be reached from the server. Uploads will fail until it is back.' });
  if (ready && engineInfo?.configError) lines.push({ key: 'cfg', warn: true, text: `The server settings could not be read: ${engineInfo.configError}` });
  for (const n of notices) lines.push({ key: n.code, warn: true, text: NOTICE_TEXT[n.code] || n.message, action: ['Dismiss', () => engine.dismissNotice(n.code)] });

  const noticeList = lines.length > 0 && (
    <ul className="up-lines" aria-live="polite">
      {lines.map((l) => (
        <li key={l.key} role={l.warn ? 'alert' : undefined} className={l.warn ? 'warn' : l.ok ? 'ok' : ''}>
          <span className={`led${l.ok ? ' ok' : l.warn ? '' : ' idle'}`} aria-hidden="true" /><span>{l.text}</span>
          {l.action && <button className="link" type="button" onClick={l.action[1]}>{l.action[0]}</button>}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="frame">
        <header className="topbar glass">
          <div className="tb-left">
            <BrandMark />
            <h1 className="page-title">{PRODUCT}</h1>
            {meta.length > 0 && <p className="tb-meta">{meta.map((item) => <span key={item} title={item}>{item}</span>)}</p>}
          </div>
          <div className="tb-actions">
            <HistoryButton />
            {ready && <FolderMenu onOpen={onOpenFolder} disabled={!live} />}
            {ready && <SettingsButton onOpen={() => setSettingsOpen(true)} />}
          </div>
          <div className="tb-cluster">
            <span className="tb-sep" aria-hidden="true" />
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className="main main-fixed" tabIndex={-1}>
          <section className={`board board-split up-board${ready ? '' : ' is-state'}`} aria-label="Résumé upload" {...dropProps}>
            {ready ? (
              <UploadForm form={form} engine={engine} queue={queue} dragOver={dragOver} notices={noticeList}
                onManageSources={() => setSourcesOpen(true)} onSubmitted={onSubmitted} />
            ) : (
              <div className="board-col up-col up-state-col resolve" style={{ '--r': 1 } as CSSProperties}>
                {(phase === 'checking' || phase === 'connecting') && <ConnectingPanel />}
                {phase === 'unreachable' && <UnreachablePanel error={error} onRetry={engine.retry} />}
                {phase === 'unauthorized' && <SignInPanel onSignIn={engine.signIn} />}
                {phase === 'error' && error && (
                  <EmptyPanel title={ERROR_TITLE[error.code] || 'Something went wrong'} tone="warn"
                    action={<button className="btn" type="button" onClick={engine.retry}><Icon name="refresh" size="sm" />Try again</button>}>
                    {error.message}
                  </EmptyPanel>
                )}
              </div>
            )}

            <ActivityList queue={queue} run={engine.run} onToast={toast} showCost />
          </section>
          <footer className="meta-row pad hair-t up-foot resolve" style={{ '--r': 4 } as CSSProperties} aria-label="Server status">
            <span className="up-engine">
              <span className={`led${ready && live ? ' ok' : ''}`} aria-hidden="true" />
              <b>{ready && info?.version ? `Server ${info.version}` : 'Server'}</b>
              {ready
                ? <span className={live ? 'pill live' : 'pill pill-warn'}>{live ? 'Connected' : 'Reconnecting'}</span>
                : <span className={phase === 'error' || phase === 'unreachable' || phase === 'unauthorized' ? 'pill pill-warn' : 'pill'}>{meta[0]}</span>}
              {ready && driveWanted && google && <span className={`pill${google.ok === false ? ' pill-warn' : ' ok'}`} title={google.ok === false ? google.reason || 'Google token invalid' : 'Google Drive is reachable'}>Drive {google.ok === false ? 'needs attention' : 'ready'}</span>}
              {ready && engineInfo?.llm && <span className={`pill${engineInfo.llm.ok === false ? ' pill-warn' : ' ok'}`} title={engineInfo.llm.ok === false ? 'The language model cannot be reached' : 'The language model is reachable'}>AI {engineInfo.llm.ok === false ? 'unreachable' : 'ready'}</span>}
            </span>
          </footer>
        </main>
      </div>

      {settingsOpen && settings && (
        <SettingsDialog open onClose={() => setSettingsOpen(false)} info={settings} sources={queue.sources} onSave={onSave} onSaveShared={engine.saveShared} />
      )}
      {sourcesOpen && (
        <SourcesDialog sources={queue.sources} onSave={engine.saveShared} onClose={() => setSourcesOpen(false)} />
      )}
    </div>
  );
}
