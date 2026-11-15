import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Icon } from './ds/icon';
import type { EngineError } from './use-resume-engine';

// What the page shows in place of the form while the server cannot be used: connecting, not reachable, or asking for a token.

export function ConnectingPanel() {
  return (
    <section className="up-state up-connecting" aria-live="polite">
      <span className="led ok up-pulse" aria-hidden="true" />
      <p><b>Connecting to the server</b></p>
      <p className="help">Checking the session and loading the settings.</p>
    </section>
  );
}

// The server does not answer. The page keeps looking for it every 2 seconds and connects by itself.
export function UnreachablePanel({ error, onRetry }: { error: EngineError | null; onRetry: () => void }) {
  return (
    <section className="up-state" aria-labelledby="up-unreachable-h">
      <div className="sec-head"><h2 className="sec-title" id="up-unreachable-h">Server not reachable</h2><span className="sec-lead" aria-hidden="true" /></div>
      <p className="sec-desc">
        This page needs the Résumé Intake server to read and queue uploads, and it does not answer. Check that the server is running,
        then this page connects by itself.
      </p>
      <div className="up-install-row">
        <button className="btn" type="button" onClick={onRetry}><Icon name="refresh" size="sm" />Try again</button>
        {error?.message && <span className="help">{error.message}</span>}
      </div>
      <p className="hint up-waiting" role="status" aria-live="polite">Waiting for the server. Checking every 2 seconds.</p>
    </section>
  );
}

// The server asked for a token (token or signed auth mode): keep it for this tab only.
export function SignInPanel({ onSignIn }: { onSignIn: (token: string) => void }) {
  const id = useId();
  const [token, setToken] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    if (token.trim()) onSignIn(token);
  }
  return (
    <section className="up-state" aria-labelledby="up-signin-h">
      <div className="sec-head"><h2 className="sec-title" id="up-signin-h">Access token needed</h2><span className="sec-lead" aria-hidden="true" /></div>
      <p className="sec-desc">This server asks for an access token. Paste it below; it is kept in this tab only and goes nowhere but this server.</p>
      <form className="up-add" onSubmit={submit}>
        <label className="sr-only" htmlFor={id}>Access token</label>
        <input className="input mono" id={id} type="password" autoComplete="off" spellCheck={false} placeholder="Access token" value={token}
          data-autofocus onChange={(e) => setToken(e.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={!token.trim()}>Connect</button>
      </form>
    </section>
  );
}
