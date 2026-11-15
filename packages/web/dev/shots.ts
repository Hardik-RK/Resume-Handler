// Visual check: drives the built page (served by the dev mock) in the installed Edge, takes screenshots in light and dark, and
// fails on any console error. Run `npm run build` first, then `npm run shots`. Screenshots land in dev/shots/.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'shots');
mkdirSync(OUT, { recursive: true });
const PORT = 47899;
const BASE = `http://127.0.0.1:${PORT}/`;
const errors: string[] = [];

function startMock(scenario: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', join(here, 'mock-server.ts')], {
    env: { ...process.env, PORT: String(PORT), MOCK_SCENARIO: scenario, MOCK_SPEED: '0.25' }, stdio: 'ignore',
  });
}

async function stop(proc: ChildProcess): Promise<void> {
  proc.kill();
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(`${BASE}hello`); } catch { return; }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

async function waitFor(url: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  throw new Error(`${url} did not come up`);
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`) });

async function fillAndSubmit(page: Page): Promise<void> {
  await page.setInputFiles('input[type=file]', [
    { name: 'resumes-batch-1.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake one') },
    { name: 'resumes-batch-2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake two') },
    { name: 'campus-drive.zip', mimeType: 'application/zip', buffer: Buffer.from('PK fake zip') },
  ]);
  await page.getByRole('button', { name: /Choose the campaign/ }).click();
  await page.getByRole('menuitemradio', { name: /Backend engineers/ }).click();
  await page.locator('button[role=combobox], .up-field-btn').nth(1).click();
  await page.getByRole('menuitemradio', { name: 'Naukri' }).click();
}

async function run(): Promise<void> {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const watch = (page: Page) => {
    page.setDefaultTimeout(10000);
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  };

  // 1. the default scenario: empty state, with files, running, done, dialogs, in both themes
  let mock = startMock('default');
  await waitFor(`${BASE}hello`);
  for (const mode of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: mode });
    const page = await context.newPage();
    watch(page);
    await page.goto(BASE);
    await page.getByText('Drop résumé zips or PDFs').waitFor();
    await page.waitForTimeout(900);
    await shot(page, `${mode}-1-empty`);

    await fillAndSubmit(page);
    await page.waitForTimeout(500);
    await shot(page, `${mode}-2-form-filled`);

    await page.getByRole('button', { name: /Add 2 uploads to the queue/ }).click();
    await page.getByText('Running', { exact: false }).first().waitFor();
    await page.waitForTimeout(1300);
    await shot(page, `${mode}-3-running`);

    await page.getByText('Done', { exact: true }).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.locator('.up-entry-head').first().click();
    await page.waitForTimeout(400);
    await shot(page, `${mode}-4-done-expanded`);

    await page.getByRole('button', { name: /Settings/ }).click();
    await page.waitForTimeout(900);
    await shot(page, `${mode}-5-settings`);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: /History/ }).click();
    await page.waitForTimeout(900);
    await shot(page, `${mode}-6-history`);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: /Folders/ }).click();
    await page.waitForTimeout(900);
    await shot(page, `${mode}-7-folders-menu`);
    await context.close();
  }
  await stop(mock);

  // 2. no downstream system: CSV only
  mock = startMock('nosink');
  await waitFor(`${BASE}hello`);
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    watch(page);
    await page.goto(BASE);
    await page.getByText('Drop résumé zips or PDFs').waitFor();
    await page.waitForTimeout(900);
    await shot(page, 'light-8-nosink');
    await context.close();
  }
  await stop(mock);

  // 3. token needed
  mock = startMock('auth');
  await waitFor(`${BASE}hello`);
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    watch(page);
    await page.goto(BASE);
    await page.getByText('Access token needed').waitFor();
    await page.waitForTimeout(500);
    await shot(page, 'light-9-token');
    await page.getByPlaceholder('Access token').fill('demo-token');
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.getByText('Drop résumé zips or PDFs').waitFor();
    await context.close();
  }
  await stop(mock);

  // 4. the server is not reachable (nothing listens now)
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/' || url.pathname.startsWith('/assets') || url.pathname === '/favicon.svg') {
        // serve the page from a short-lived mock, then drop the API
        await route.continue();
      } else await route.abort();
    });
    const live = startMock('default');
    await waitFor(`${BASE}hello`);
    await page.goto(BASE);
    await page.getByRole('heading', { name: 'Server not reachable' }).waitFor();
    await page.waitForTimeout(500);
    await shot(page, 'light-10-unreachable');
    await stop(live);
    await context.close();
  }

  await browser.close();
  const real = errors.filter((e) => !/Failed to load resource|net::ERR|\/hello|\/state/.test(e));
  if (real.length) {
    console.error(`console errors:\n${real.join('\n')}`);
    process.exitCode = 1;
  } else console.log(`screenshots in ${OUT}; no console errors`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
