import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

test('tool failures appear only inside individual details, including a failure with no output', async () => {
  const daemon = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: [{ id: 'codex', adapter: 'codex', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-codex.mjs')] }] }) });
  let browser;
  try {
    browser = await launchBrowser();
    const make = async (title, text) => {
      const thread = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'codex', cwd: daemon.workdir, title }) })).json();
      assert.ok((await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text }) })).ok);
      const deadline = Date.now() + 10_000;
      let state;
      do {
        state = await (await api(daemon, `/api/threads/${thread.id}`)).json();
        assert.ok(Date.now() < deadline, 'fake agent finished');
        if (state.status === 'running') await new Promise(resolve => setTimeout(resolve, 50));
      } while (state.status === 'running');
      assert.equal(state.status, 'idle', 'a failed tool need not fail the turn');
    };
    await make('工具执行记录', 'tool fail emptyfailure');
    await make('单条工具记录', 'fail');
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        const page = await context.newPage();
        const shot = async name => {
          if (!process.env.RAH_E2E_SHOTS_DIR) return;
          mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ animations: 'disabled', path: join(process.env.RAH_E2E_SHOTS_DIR, `${name}-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        };
        await openUi(page, daemon);
        if (mobile) await page.locator('.menu-btn').click();
        await page.locator('.thread-item', { hasText: '工具执行记录' }).click();
        await page.locator('.work-toggle').click();
        const group = page.locator('.run-head');
        await group.waitFor();
        assert.doesNotMatch(await group.innerText(), /失败/);
        assert.equal(await page.locator('.step-result').count(), 0);
        await shot('tools-summary');
        await group.click();
        const failed = page.locator('.step.failed').filter({ hasText: '运行了 false' });
        assert.equal(await failed.count(), 1, 'the actual result remains failed');
        assert.doesNotMatch(await failed.locator('.step-head').innerText(), /失败/);
        assert.equal(await page.locator('.step-result').count(), 0);
        assert.equal(await failed.locator('.step-status').evaluate(el => getComputedStyle(el).color), await page.locator('.step.completed .step-status').evaluate(el => getComputedStyle(el).color));
        await shot('tools-list');
        await failed.locator('.step-head').click();
        await failed.getByText('执行失败', { exact: true }).waitFor();
        assert.match(await failed.locator('.step-detail').innerText(), /boom\s+\(exit 1\)/);
        await shot('tools-detail');
        await failed.locator('.step-head').click();
        const empty = page.locator('.step.failed').filter({ hasText: 'fixture · no-detail' });
        await empty.locator('.step-head').click();
        await empty.getByText('执行失败，工具未返回详细信息', { exact: true }).waitFor();
        await empty.locator('.step-head').click();
        const success = page.locator('.step.completed');
        await success.locator('.step-head').click();
        assert.equal(await success.locator('.step-result').count(), 0);
        assert.match(await success.locator('.step-detail').innerText(), /partial out/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (mobile) await page.locator('.menu-btn').click();
        await page.locator('.thread-item', { hasText: '单条工具记录' }).click();
        await page.locator('.work-toggle').click();
        assert.equal(await page.locator('.run-head').count(), 0);
        assert.doesNotMatch(await page.locator('.step-head').innerText(), /失败/);
        await page.locator('.step-head').click();
        await page.getByText('执行失败', { exact: true }).waitFor();
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await daemon.stop(); }
});
