// A relay handed back and forth between two accounts (A → B → C, back to B, back to C) must still
// read back to its very first segment: each page back lands on the part of the segment that holds
// the handover point. Desktop 1440 and phone 390, light and dark, real daemon and fake agents.
// Run after `npm run build`:  node packages/e2e/handback-pingpong-shots.mjs [outdir]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, startDaemon, connect, launchBrowser, repoRoot } from './harness.mjs';

const out = process.argv[2] ?? join(repoRoot, 'e2e', 'shots', 'handback-pingpong');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'calli-pingpong-'));
for (const id of ['agy', 'agy2']) writeFileSync(join(dir, `${id}.json`), JSON.stringify({ 'Gemini Models': 10, 'Claude Models': 20 }));
const daemon = await startDaemon({ CALLI_AGENTS_JSON: JSON.stringify({ agents: ['agy', 'agy2'].map((id, i) => ({
  id, adapter: 'agy', label: ['Claude Code', 'Codex'][i], command: ['fake-agy'], env: { FAKE_HANDOVER_QUOTA: join(dir, `${id}.json`) },
})) }) });
const request = async (path, method = 'GET', body) => {
  const res = await api(daemon, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
};
const wait = async fn => { for (let i = 0; i < 300; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } throw new Error('timed out'); };
const idle = id => wait(async () => { const t = await request(`/api/threads/${id}`); return t.status !== 'running' && !['checking', 'preparing', 'countdown'].includes(t.autoHandover?.state) && !t.queued.length && t; });
const say = async (id, text) => { await request(`/api/threads/${id}/turns`, 'POST', { text }); await idle(id); };
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log('ok:', what); };

const browser = await launchBrowser();
try {
  const a = await request('/api/threads', 'POST', { agent: 'agy', model: 'gemini-pro', cwd: daemon.workdir, title: '分析群聊' });
  await say(a.id, 'A 段第一句');
  const b = await request(`/api/threads/${a.id}/takeover`, 'POST', { agent: 'agy2', model: 'gemini-pro', summary: 'source' });
  await idle(b.id); await say(b.id, 'B 段交回前');
  const c = await request(`/api/threads/${b.id}/takeover`, 'POST', { agent: 'agy', model: 'gemini-pro', summary: 'source' });
  await idle(c.id); await say(c.id, 'C 段交回前');
  check(c.id !== a.id, 'C is a new conversation');
  const back1 = await request(`/api/threads/${c.id}/takeover`, 'POST', { agent: 'agy2', model: 'gemini-pro', summary: 'source', returnTo: b.id });
  check(back1.id === b.id, 'handed back to B'); await idle(b.id); await say(b.id, 'B 段交回后');
  const back2 = await request(`/api/threads/${b.id}/takeover`, 'POST', { agent: 'agy', model: 'gemini-pro', summary: 'source', returnTo: c.id });
  check(back2.id === c.id, 'handed back to C'); await idle(c.id); await say(c.id, 'C 段交回后');

  for (const [name, viewport, scheme] of [['desktop-light', { width: 1440, height: 900 }, 'light'], ['desktop-dark', { width: 1440, height: 900 }, 'dark'], ['phone-light', { width: 390, height: 844 }, 'light'], ['phone-dark', { width: 390, height: 844 }, 'dark']]) {
    const phone = viewport.width < 800;
    const page = await browser.newPage({ viewport, colorScheme: scheme, hasTouch: phone, isMobile: phone });
    page.setDefaultTimeout(15_000);
    await page.goto(daemon.base + '/');
    await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
    if (await page.locator('.demo-bar').count()) await connect(page, daemon.token);
    const later = page.getByRole('button', { name: '稍后' }); if (await later.count()) await later.click();
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await page.evaluate(h => { window.location.hash = h; }, `#/thread/${c.id}`);
    await page.locator('.scroller .row').first().waitFor();
    await page.waitForTimeout(700);
    const cdp = phone ? await page.context().newCDPSession(page) : null;
    const x = phone ? 200 : 1070;
    const back = async () => {
      // Read up to the top of this page, then drag down past it: the earlier page.
      for (let i = 0; i < 12; i++) {
        await page.locator('.scroller').first().evaluate(el => { el.scrollTop = 0; });
        await page.waitForTimeout(300);
        const more = page.locator('.older-messages');
        if (!(await more.count())) break;
        await more.first().click().catch(() => undefined); await page.waitForTimeout(400);
      }
      const move = y => phone ? cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }) : page.mouse.move(x, y);
      if (phone) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: 300 }] });
      else { await page.mouse.move(x, 300); await page.mouse.down(); }
      for (let i = 1; i <= 14; i++) { await move(300 + 400 * i / 14); await page.waitForTimeout(16); }
      await page.waitForTimeout(300);
      console.log('  pill', JSON.stringify(await page.locator('.chain-pill.on').allInnerTexts()));
      if (phone) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); else await page.mouse.up();
      await page.waitForTimeout(1200);
    };
    // What the person said on this page (the fake agent echoes summaries, so its replies are no guide).
    const said = () => page.evaluate(() => [...document.querySelectorAll('.scroller .bubble')].map(r => r.textContent.trim()));
    const seen = [];
    for (let step = 0; step < 6; step++) {
      const words = [...new Set(await said())].filter(w => /段(第一句|交回前|交回后)$/.test(w));
      seen.push(words.join('/'));
      await page.screenshot({ path: join(out, `${step}-${name}.png`), animations: 'disabled' });
      if (words.includes('A 段第一句')) break;
      await back();
    }
    console.log(name, seen.join('  ←  '));
    check(seen.some(s => s.includes('A 段第一句')), `${name}: paging back reaches the first segment`);
    check(seen.some(s => s.includes('B 段交回前')) && seen.some(s => s.includes('C 段交回前')), `${name}: both earlier parts are on the way`);
    await page.close();
  }
} finally { await browser.close(); await daemon.stop(); }
