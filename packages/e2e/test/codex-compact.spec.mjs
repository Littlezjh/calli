import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

test('Codex compaction stays running and queues the next message until completion', async () => {
  const daemon = await startDaemon({ FAKE_CODEX_COMPACT_DELAY: '3000', RAH_AGENTS_JSON: JSON.stringify({ agents: [{ id: 'codex', adapter: 'codex', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-codex.mjs')] }] }) });
  let browser;
  try {
    browser = await launchBrowser();
    const thread = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'codex', cwd: daemon.workdir, title: '压缩状态验证' }) })).json();
    assert.ok((await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: '/compact' }) })).ok);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await (await api(daemon, `/api/threads/${thread.id}`)).json()).status, 'running');
    const queued = await (await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'after compact', queue: true }) })).json();
    assert.equal(queued.queued, true);
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        const page = await context.newPage();
        await openUi(page, daemon);
        if (mobile) await page.locator('.menu-btn').click();
        await page.locator('.thread-title', { hasText: '压缩状态验证' }).first().click();
        await page.getByText('压缩上下文', { exact: true }).waitFor();
        await page.waitForTimeout(300);
        if (process.env.RAH_E2E_SHOTS_DIR) {
          mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `compact-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        }
      } finally { await context.close(); }
    }
    let current;
    for (let i = 0; i < 150; i++) {
      current = await (await api(daemon, `/api/threads/${thread.id}`)).json();
      if (current.status === 'idle' && current.queued.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(current.status, 'idle');
    assert.equal(current.queued.length, 0);
  } finally { await browser?.close(); await daemon.stop(); }
});
