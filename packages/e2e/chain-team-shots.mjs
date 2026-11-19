// Screenshots of a lead handed over twice with its team: the sidebar card keeps the earlier segments
// in its chain and lists the sub-agent under it. Desktop 1440 and phone 390, light and dark, with a
// real daemon and fake agents. Run after `npm run build`:
//   node packages/e2e/chain-team-shots.mjs [outdir]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, startDaemon, connect, launchBrowser, repoRoot } from './harness.mjs';

const out = process.argv[2] ?? join(repoRoot, 'e2e', 'shots', 'chain-team');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'calli-chain-team-shots-'));
for (const id of ['agy', 'agy2', 'agy3']) writeFileSync(join(dir, `${id}.json`), JSON.stringify({ 'Gemini Models': 10, 'Claude Models': 20 }));
const daemon = await startDaemon({ CALLI_AGENTS_JSON: JSON.stringify({ agents: ['agy', 'agy2', 'agy3'].map((id, i) => ({
  id, adapter: 'agy', label: ['Claude Code', 'Codex', 'Gemini'][i], command: ['fake-agy'], env: { FAKE_HANDOVER_QUOTA: join(dir, `${id}.json`) },
})) }) });
const request = async (path, method = 'GET', body) => {
  const res = await api(daemon, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
};
const wait = async (fn, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); }
};
const idle = id => wait(async () => { const t = await request(`/api/threads/${id}`); return t.status !== 'running' && !t.queued.length && t; });
const say = async (id, text) => { await request(`/api/threads/${id}/turns`, 'POST', { text }); await idle(id); };

const combos = [
  ['desktop-light', { width: 1440, height: 900 }, 'light'],
  ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
  ['phone-light', { width: 390, height: 844 }, 'light'],
  ['phone-dark', { width: 390, height: 844 }, 'dark'],
];
const browser = await launchBrowser();
try {
  const a = await request('/api/threads', 'POST', { agent: 'agy', model: 'gemini-pro', cwd: daemon.workdir, title: '拉取最新代码并启动 Dashboard' });
  await say(a.id, '拉取最新代码');
  await request(`/api/threads/${a.id}/coordination`, 'POST', {});
  const command = async (args, text) => say(a.id, `CALLI_COMMAND:${Buffer.from(JSON.stringify({ args, text })).toString('base64')}`);
  await command(['spawn', '--agent', 'agy2', '--model', 'gemini-pro', '--name', 'partner', '--message-file', '-', '--request-id', 'spawn-shot'], '已在 [api.test.ts:3426](/tmp/api.test.ts) 补上断言');
  const member = (await request(`/api/threads/${a.id}/coordination`)).members[0].id;
  await idle(member);
  // The lead hands over twice; the team moves along each time.
  const b = await request(`/api/threads/${a.id}/handover-thread`, 'POST', { agent: 'agy3', model: 'gemini-pro', mode: 'continue' });
  await idle(b.id);
  const c = await request(`/api/threads/${b.id}/handover-thread`, 'POST', { agent: 'agy', model: 'gemini-pro', mode: 'continue' });
  await idle(c.id);
  // A segment renamed later is listed by its new name.
  await request(`/api/threads/${b.id}`, 'PATCH', { title: '压测脚本与回归检查' });
  const listed = (await request('/api/threads')).threads ?? await request('/api/threads');
  console.log('coordination', JSON.stringify(listed.filter(t => [a.id, b.id, c.id, member].includes(t.id)).map(t => [t.id.slice(0, 6), t.title, t.coordination])));console.log('ids', a.id.slice(0,6), b.id.slice(0,6), c.id.slice(0,6), member.slice(0,6));

  for (const [name, viewport, scheme] of combos) {
    const phone = viewport.width < 800;
    const page = await browser.newPage({ viewport, colorScheme: scheme, hasTouch: phone, isMobile: phone });
    page.setDefaultTimeout(15_000);
    await page.goto(daemon.base + '/');
    await page.locator('.sidebar-inner').waitFor({ state: 'attached', timeout: 15_000 });
    if (await page.locator('.demo-bar').count()) await connect(page, daemon.token);
    const later = page.getByRole('button', { name: '稍后' });
    if (await later.count()) await later.click();
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await page.evaluate(h => { window.location.hash = h; }, `#/thread/${c.id}`);
    await page.locator('.scroller .row').first().waitFor();
    if (phone) { await page.locator('.menu-btn').click(); await page.locator('.drawer-open').waitFor(); }
    const card = page.locator('.handover-group').first();
    await card.waitFor();
    // Both folds open: the chain's segments, then the team.
    for (const toggle of await card.locator('.handover-toggle').all()) if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.waitForTimeout(500);
    console.log(name, 'chain rows', await card.locator('.handover-chain .handover-member').count(), 'team rows', await card.locator(':scope > .handover-members:not(.handover-chain) .handover-member').count());
    await page.screenshot({ path: join(out, `sidebar-${name}.png`), animations: 'disabled' });
    await page.close();
  }
  console.log('shots in', out);
} finally {
  await browser.close();
  await daemon.stop?.();
}
