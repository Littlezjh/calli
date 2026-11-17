import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, api, launchBrowser, repoRoot } from '../harness.mjs';

test('new drafts prewarm and consume the matching process on desktop and phone in both themes', async () => {
  const daemon = await startDaemon({ CALLI_AGENTS_JSON: JSON.stringify({ agents: [{
    id: 'claude', label: 'Claude', adapter: 'claude',
    command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-acp.mjs')],
  }] }) });
  const browser = await launchBrowser();
  const shots = '/tmp/calli-warmup-shots';
  mkdirSync(shots, { recursive: true });
  try {
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        isMobile: mobile, colorScheme: theme,
      });
      await context.addInitScript(({ token, theme }) => {
        localStorage.setItem('calli.token', token);
        localStorage.setItem('calli.locale', 'zh');
        localStorage.setItem('calli.theme', theme);
      }, { token: daemon.token, theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const warming = page.waitForResponse(r => r.url().endsWith('/api/thread-warmups') && r.request().method() === 'POST');
      await page.goto(daemon.base + '/');
      const response = await warming;
      assert.equal(response.status(), 202);
      const { id: warmupId } = await response.json();
      assert.ok(warmupId);
      const composer = page.locator('.composer textarea');
      await composer.fill(`warmup ${mobile ? 'phone' : 'desktop'} ${theme}`);
      await page.screenshot({ path: join(shots, `before-${mobile}-${theme}.png`) });
      const creating = page.waitForResponse(r => r.url().endsWith('/api/threads') && r.request().method() === 'POST');
      await page.locator('.composer .send-btn:not(.stop)').click();
      const created = await creating;
      assert.equal(created.status(), 201);
      assert.equal(created.request().postDataJSON().warmupId, warmupId);
      const thread = await created.json();
      await page.waitForFunction(async ({ id, token }) => {
        const response = await fetch(`/api/threads/${id}`, { headers: { Authorization: `Bearer ${token}` } });
        return (await response.json()).status === 'idle';
      }, { id: thread.id, token: daemon.token });
      const events = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
      const log = Array.isArray(events) ? events : events.events;
      assert.ok(log.some(e => e.type === 'session.lifecycle' && e.data.action === 'ready' && e.data.prewarmed));
      assert.equal(log.filter(e => e.type === 'turn.started').length, 1);
      await page.getByText(/^echo:warmup/).first().waitFor();
      await page.locator('.composer .send-btn.stop').waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(shots, `after-${mobile}-${theme}.png`) });
      await context.close();
    }
  } finally {
    await browser.close();
    await daemon.stop();
  }
});
