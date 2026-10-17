// The overview page: what was asked each day and what was called, with the whole prompt of a
// conversation in a dialog. Verified against a live daemon, not the demo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnce, startDaemon, launchBrowser, openUi } from '../harness.mjs';

let daemon;
let browser;

before(async () => {
  await buildOnce();
  daemon = await startDaemon();
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

test('the sidebar opens the overview, a turn shows up the day it was asked, tools and MCP counted', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  try {
    const made = await (await fetch(`${daemon.base}/api/threads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir }),
    })).json();
    await fetch(`${daemon.base}/api/threads/${made.id}/turns`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ text: 'overview e2e: 跑一遍安装检查' }),
    });
    for (let i = 0; i < 100; i++) {
      const t = await (await fetch(`${daemon.base}/api/threads/${made.id}`, { headers: { Authorization: `Bearer ${daemon.token}` } })).json();
      if (t.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    await openUi(page, daemon);
    await page.locator('.side-link', { hasText: '概览' }).click();
    await page.locator('.activity-page').waitFor({ timeout: 10_000 });
    assert.match(await page.evaluate(() => window.location.hash), /#\/activity$/);
    assert.equal((await page.locator('.topbar-title').innerText()).trim(), '概览', 'the top bar names the page, not 新线程');

    // Today's section: the ask, the conversation under its name, and the tools the fake pi called.
    const day = page.locator('.activity-day', { has: page.locator('.activity-day-head h2', { hasText: '今天' }) });
    await day.waitFor({ timeout: 10_000 });
    assert.match(await day.locator('.activity-ask-text').first().textContent(), /安装检查/);
    assert.ok((await day.locator('.activity-thread-title').first().textContent()).length > 0);
    const toolNames = await day.locator('.activity-chip').allTextContents();
    assert.ok(toolNames.length > 0, `tools counted: ${toolNames.join(', ')}`);

    // The ask leads back into its conversation.
    await day.locator('.activity-ask').first().click();
    await page.locator('.composer').waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate(() => window.location.hash), '');
    await page.locator('.side-link', { hasText: '概览' }).click();
    await page.locator('.activity-page').waitFor({ timeout: 10_000 });
  } finally { await page.close(); }
});

test('an agent that keeps no prompt in its session file says so instead of guessing', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  try {
    await openUi(page, daemon);
    await page.evaluate(() => window.location.assign('#/activity'));
    await page.locator('.activity-page').waitFor({ timeout: 10_000 });
    // The fake pi writes no session file, so its conversation has no button to read one from.
    const groups = await page.locator('.activity-thread').all();
    for (const group of groups) {
      const agent = await group.locator('.activity-thread-agent').textContent();
      if (agent.includes('pi')) assert.equal(await group.locator('.activity-sys-btn').count(), 0, 'no button where there is nothing to read');
    }
  } finally { await page.close(); }
});
