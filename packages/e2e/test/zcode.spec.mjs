import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

let daemon;
let browser;
before(async () => {
  daemon = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: [{ id: 'zcode', adapter: 'zcode', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-zcode.mjs')] }] }) });
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await daemon?.stop(); });

test('ZCode threads use the shared interface in desktop/phone and both themes', async () => {
  const agents = await (await api(daemon, '/api/agents')).json();
  const agent = agents.find((a) => a.id === 'zcode');
  assert.ok(agent?.capabilities.resume);
  const commands = await (await api(daemon, '/api/agents/zcode/commands')).json();
  assert.ok(commands.some((command) => command.name === 'usage'));
  const response = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'zcode', cwd: daemon.workdir, title: 'ZCode 基础编码' }) });
  assert.equal(response.status, 201);
  const thread = await response.json();
  assert.ok((await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'tool' }) })).ok);
  let current;
  for (let i = 0; i < 100; i++) {
    current = await (await api(daemon, `/api/threads/${thread.id}`)).json();
    if (current.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(current.status, 'idle');
  assert.ok((await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: '/usage' }) })).ok);
  for (let i = 0; i < 100; i++) {
    current = await (await api(daemon, `/api/threads/${thread.id}`)).json();
    if (current.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(current.status, 'idle');
  for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
    try {
      const page = await context.newPage();
      await openUi(page, daemon);
      if (mobile) await page.locator('.menu-btn').click();
      await page.locator('.thread-title', { hasText: 'ZCode 基础编码' }).first().click();
      await page.getByText('你好', { exact: true }).waitFor();
      await page.getByText('总计：1,500 tokens', { exact: false }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      if (process.env.RAH_E2E_SHOTS_DIR) {
        mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `zcode-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
      }
    } finally { await context.close(); }
  }
});
