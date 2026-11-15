import type { CrmStore } from "./ingestion.ts";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** The demo CRM's only page: campaigns and candidates, refreshed every few seconds. */
export function renderHome(store: CrmStore): string {
  const campaignName = new Map(store.campaigns.map((c) => [c.id, c.name]));
  const campaigns = store.campaigns
    .map((c) => {
      const count = store.applications.filter((a) => a.campaignId === c.id).length;
      return `<tr><td>${c.id}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.company)}</td><td>${escapeHtml(c.type)}</td><td>${escapeHtml(c.status)}</td><td>${count}</td></tr>`;
    })
    .join("");
  const candidates = store.applications.length
    ? store.applications
        .slice()
        .reverse()
        .map(
          (a) =>
            `<tr><td>${a.id}</td><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.email)}</td><td>${escapeHtml(a.phone)}</td>` +
            `<td>${escapeHtml(campaignName.get(a.campaignId))}</td><td>${escapeHtml(a.stage)}</td><td>${escapeHtml(a.source)}</td>` +
            `<td>${escapeHtml(a.createdAt)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="8">No candidates yet. Commit a run to this CRM and they will appear here.</td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Mock CRM</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#1b1f24; --card:#fff; --line:#d9dde3; --muted:#5b6470; --accent:#2f6fed; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14171b; --fg:#e6e9ee; --card:#1d2227; --line:#303740; --muted:#9aa4b0; --accent:#6c9bff; } }
  body { margin:0; font:15px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:1100px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:28px 0 8px; }
  p { color:var(--muted); margin:0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; overflow-x:auto; }
  table { border-collapse:collapse; width:100%; } th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:600; font-size:13px; } tr:last-child td { border-bottom:0; }
  code { background:var(--card); border:1px solid var(--line); padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
<main>
  <h1>Mock CRM</h1>
  <p>Stand-in downstream system for demos. ${store.applications.length} candidate(s) in ${store.batches.length} batch(es). Public key: <a href="/.well-known/public-key.pem">/.well-known/public-key.pem</a>. This page refreshes every 5 seconds.</p>
  <h2>Campaigns</h2>
  <div class="card"><table><thead><tr><th>ID</th><th>Name</th><th>Company</th><th>Type</th><th>Status</th><th>Candidates</th></tr></thead><tbody>${campaigns}</tbody></table></div>
  <h2>Candidates</h2>
  <div class="card"><table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Phone</th><th>Campaign</th><th>Stage</th><th>Source</th><th>Added</th></tr></thead><tbody>${candidates}</tbody></table></div>
</main>
</body>
</html>`;
}
