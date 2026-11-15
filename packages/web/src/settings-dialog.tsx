import { useId, useState } from 'react';
import { Dialog } from './ds/dialog';
import { campaignLines, listLines, parseCampaignLines } from './format';
import { errorMessage } from './lib/api';
import type { ServerConfig, SettingsBody, SettingsInfo } from './lib/types';
import { ParallelField, SourcesEditor } from './run-settings';

// The parameters the server accepts, typed the way it expects them (the keys of its config).
type TextKey = 'llmBaseUrl' | 'modelExtract' | 'modelFallback' | 'modelVision' | 'modelFallbackVision' | 'modelScoring' | 'dataCollection' | 'defaultCampaignType' | 'crmBaseUrl';
type NumberKey = 'driveConcurrency' | 'jdThreshold' | 'visionDpi';
type BoolKey = 'jdFilterEnabled' | 'jdDryRun' | 'extractAts';

const TEXT: Array<[TextKey, string]> = [
  ['llmBaseUrl', 'LLM base URL'], ['modelExtract', 'Extraction model'], ['modelFallback', 'Fallback model'],
  ['modelVision', 'Vision model'], ['modelFallbackVision', 'Vision fallback model'], ['modelScoring', 'Scoring model'],
  ['dataCollection', 'Provider data collection (deny, allow or blank)'], ['defaultCampaignType', 'Default campaign type'],
  ['crmBaseUrl', 'Downstream system address (https origin)'],
];
const NUMBER: Array<[NumberKey, string]> = [
  ['driveConcurrency', 'Drive uploads at once'],
  ['jdThreshold', 'JD threshold (score)'], ['visionDpi', 'Vision DPI'],
];
const BOOL: Array<[BoolKey, string]> = [['jdFilterEnabled', 'JD fit filter on by default'], ['jdDryRun', 'Dry run by default'], ['extractAts', 'Extract ATS links']];
const SECRETS: Array<[string, string, 'input' | 'area']> = [
  ['openrouterApiKey', 'OpenRouter API key', 'input'],
  ['ingestionToken', 'Downstream system access token', 'input'],
  ['googleClientSecrets', 'Google client secrets (JSON)', 'area'],
  ['googleTokenJson', 'Google token (JSON)', 'area'],
];

const toLines = (list: unknown): string => (Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : '')).join('\n') : '');

interface Draft {
  text: Record<TextKey, string>;
  number: Record<NumberKey, string>;
  bool: Record<BoolKey, boolean>;
  campaignTypes: string;
  campaigns: string;
}

function draftFrom(cfg: ServerConfig): Draft {
  return {
    text: Object.fromEntries(TEXT.map(([k]) => [k, String(cfg[k] ?? '')])) as Record<TextKey, string>,
    number: Object.fromEntries(NUMBER.map(([k]) => [k, cfg[k] == null ? '' : String(cfg[k])])) as Record<NumberKey, string>,
    bool: Object.fromEntries(BOOL.map(([k]) => [k, cfg[k] === true])) as Record<BoolKey, boolean>,
    campaignTypes: toLines(cfg.campaignTypes),
    campaigns: campaignLines(cfg.campaigns),
  };
}

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  info: SettingsInfo;
  sources: string[];
  onSave: (body: SettingsBody) => Promise<unknown>;
  onSaveShared: (patch: Record<string, unknown>) => Promise<unknown>;
}

// Two parts. Run settings (parallel requests, sources): saved as soon as they change. Server settings: saved with the button.
// Secret values are never shown: only "Set" and the last characters of a value the server chooses to reveal.
export function SettingsDialog({ open, onClose, info, sources, onSave, onSaveShared }: SettingsDialogProps) {
  const ids = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(info?.config || {}));
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [clearing, setClearing] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');

  const field = (key: string) => `${ids}-${key}`;
  const setText = (k: TextKey) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, text: { ...d.text, [k]: e.target.value } }));
  const setNumber = (k: NumberKey) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, number: { ...d.number, [k]: e.target.value } }));
  const setBool = (k: BoolKey) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, bool: { ...d.bool, [k]: e.target.checked } }));

  async function save() {
    const config: Record<string, unknown> = {};
    for (const [k] of TEXT) config[k] = draft.text[k].trim() || null;
    for (const [k] of NUMBER) {
      const v = draft.number[k].trim();
      config[k] = v === '' ? null : Number(v);
    }
    for (const [k] of BOOL) config[k] = Boolean(draft.bool[k]);
    config.campaignTypes = listLines(draft.campaignTypes);
    config.campaigns = parseCampaignLines(draft.campaigns);
    const secrets: Record<string, string | null> = {};
    for (const [k] of SECRETS) {
      if (clearing[k]) secrets[k] = null;
      else if (String(secretDraft[k] || '').trim()) secrets[k] = String(secretDraft[k]).trim();
    }
    const body: SettingsBody = { config, ...(Object.keys(secrets).length ? { secrets } : {}) };
    setSaving(true);
    setNote('');
    try {
      await onSave(body);
      setSecretDraft({});
      setClearing({});
      setNote('Saved. The server has the new settings.');
    } catch (err) {
      setNote(errorMessage(err) || 'The settings could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <>
      <button className="btn" type="button" onClick={onClose} disabled={saving}>Close</button>
      <button className="btn btn-primary" type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
    </>
  );

  return (
    <Dialog open={open} onClose={onClose} title="Settings" size="xwide up-settings-dialog" actions={actions}>
      <div className="up-settings">
        <section className="form-sec" aria-labelledby={field('run')}>
          <div className="sec-head"><h4 className="sec-title" id={field('run')}>Run settings</h4><span className="sec-lead" aria-hidden="true" /></div>
          <p className="sec-desc">These are saved right away and apply from the next upload.</p>
          <ParallelField />
          <SourcesEditor sources={sources} onSave={onSaveShared} />
        </section>

        <section className="form-sec" aria-labelledby={field('eng')}>
          <div className="sec-head"><h4 className="sec-title" id={field('eng')}>Server</h4><span className="sec-lead" aria-hidden="true" /></div>
          <p className="sec-desc">Saved with the button below. Secrets are never shown again; type a new value to replace one.</p>

          <fieldset className="up-fieldset">
            <legend className="lbl">Parameters</legend>
            <div className="up-grid">
              {TEXT.map(([k, label]) => (
                <div className="form-row" key={k}>
                  <label className="lbl" htmlFor={field(k)}>{label}</label>
                  <input className="input mono" id={field(k)} type="text" value={draft.text[k]} onChange={setText(k)} />
                </div>
              ))}
              {NUMBER.map(([k, label]) => (
                <div className="form-row" key={k}>
                  <label className="lbl" htmlFor={field(k)}>{label}</label>
                  <input className="input num" id={field(k)} type="number" value={draft.number[k]} onChange={setNumber(k)} />
                </div>
              ))}
            </div>
            <div className="up-checks">
              {BOOL.map(([k, label]) => (
                <label className="up-check" key={k} htmlFor={field(k)}>
                  <input id={field(k)} type="checkbox" checked={draft.bool[k]} onChange={setBool(k)} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <div className="form-row">
              <label className="lbl" htmlFor={field('types')}>Campaign types (one per line)</label>
              <textarea className="input mono" id={field('types')} rows={3} value={draft.campaignTypes} onChange={(e) => setDraft((d) => ({ ...d, campaignTypes: e.target.value }))} />
            </div>
            <div className="form-row">
              <label className="lbl" htmlFor={field('campaigns')}>Campaigns (one per line: id, name, group, type, Drive folder)</label>
              <textarea className="input mono" id={field('campaigns')} rows={4} spellCheck={false} placeholder={'101, Backend hiring, Acme, TECH\n102, Campus drive'}
                value={draft.campaigns} onChange={(e) => setDraft((d) => ({ ...d, campaigns: e.target.value }))} />
              <span className="help">The id is what the downstream system knows the campaign by. Group, type and Drive folder are optional.</span>
            </div>
          </fieldset>

          <fieldset className="up-fieldset">
            <legend className="lbl">Secrets</legend>
            {SECRETS.map(([k, label, kind]) => {
              const s = info?.secrets?.[k] || { set: false, hint: '' };
              return (
                <div className="form-row" key={k}>
                  <label className="lbl" htmlFor={field(k)}>{label}</label>
                  <p className="up-secret-state">
                    <span className={`led${s.set ? ' ok' : ''}`} aria-hidden="true" />
                    <b>{s.set ? 'Set' : 'Not set'}</b>
                    {s.hint ? <span className="mono"> ending {s.hint}</span> : null}
                  </p>
                  {kind === 'input' ? (
                    <input className="input mono" id={field(k)} type="password" autoComplete="off" spellCheck={false}
                      placeholder={s.set ? 'Type a new value to replace it' : 'Paste the value'}
                      value={secretDraft[k] || ''} disabled={clearing[k]}
                      onChange={(e) => setSecretDraft((d) => ({ ...d, [k]: e.target.value }))} />
                  ) : (
                    <textarea className="input mono" id={field(k)} rows={3} spellCheck={false}
                      placeholder={s.set ? 'Paste new JSON to replace it' : 'Paste the JSON'}
                      value={secretDraft[k] || ''} disabled={clearing[k]}
                      onChange={(e) => setSecretDraft((d) => ({ ...d, [k]: e.target.value }))} />
                  )}
                  {s.set && (
                    <label className="up-check">
                      <input type="checkbox" checked={Boolean(clearing[k])} onChange={(e) => setClearing((c) => ({ ...c, [k]: e.target.checked }))} />
                      <span>Remove this secret on save</span>
                    </label>
                  )}
                </div>
              );
            })}
            {info && info.secretsReady === false && <p className="help" role="alert">The server has no secret store configured, so secrets cannot be saved or read.</p>}
          </fieldset>

          {note && <p className="help" role="status" aria-live="polite">{note}</p>}
        </section>
      </div>
    </Dialog>
  );
}
