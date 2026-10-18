// Context occupancy must survive reloads, shrink independently of billed totals, and clear when unknown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildOnce, startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

let daemon;
let browser;

before(async () => {
  await buildOnce();
  daemon = await startDaemon({
    RAH_AGENTS_JSON: JSON.stringify({ agents: ['claude', 'codex', 'pi'].map((id) => ({
      id, adapter: id, command: [process.execPath, join(repoRoot, 'daemon', 'test', 'fixtures', `fake-${id === 'claude' ? 'acp' : id}.mjs`)],
    })) }),
  });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

async function makeThread(agent, title) {
  const response = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent, cwd: daemon.workdir, title }) });
  assert.equal(response.status, 201);
  return response.json();
}

async function send(thread, text) {
  const response = await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text }) });
  assert.ok(response.ok);
  for (let i = 0; i < 100; i++) {
    const current = await (await api(daemon, `/api/threads/${thread.id}`)).json();
    if (current.status !== 'running') {
      assert.equal(current.status, 'idle');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('turn did not settle');
}

async function selectThread(page, thread, mobile) {
  if (mobile) await page.locator('.menu-btn').click();
  await page.locator('.thread-title', { hasText: thread.title }).first().click();
  // On a phone an empty box is one line until it is touched; the context ring is on its second.
  if (mobile) await page.locator('.composer textarea').tap();
}

test('Codex shows current context on desktop and phone in both themes, including after reload', async () => {
  const thread = await makeThread('codex', 'context regression');
  await send(thread, 'usage');
  for (const mobile of [false, true]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
        isMobile: mobile, hasTouch: mobile, colorScheme,
      });
      try {
        const page = await context.newPage();
        await openUi(page, daemon);
        await selectThread(page, thread, mobile);
        const meter = page.locator('.usage:visible').first();
        await meter.waitFor();
        assert.equal(await meter.innerText(), '71%');
        assert.equal(await meter.evaluate((el) => el.classList.contains('high')), false);
        await meter.click();
        await page.locator('.pop-note', { hasText: '上下文已用' }).waitFor();
        assert.equal(await page.locator('.pop-note', { hasText: '上下文已用' }).innerText(), '上下文已用 184k / 258k');
        // Let the phone drawer and bottom sheet finish moving before inspecting their bounds.
        await page.waitForTimeout(450);
        const bounds = await page.locator('.pop-panel').boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height + 1);
        if (process.env.RAH_E2E_SHOTS_DIR) {
          mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `context-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        }
        await openUi(page, daemon);
        await selectThread(page, thread, mobile);
        await meter.waitFor();
        assert.equal(await meter.innerText(), '71%');
      } finally {
        await context.close();
      }
    }
  }
  await send(thread, 'usage compacted');
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openUi(page, daemon);
    await selectThread(page, thread, false);
    const meter = page.locator('.usage:visible').first();
    await meter.waitFor();
    assert.equal(await meter.innerText(), '5%');
  } finally {
    await context.close();
  }
});

test('Pi clears its previous context after compaction and measures it again after a response', async () => {
  const thread = await makeThread('pi', 'pi context regression');
  await send(thread, 'hello');
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openUi(page, daemon);
    await selectThread(page, thread, false);
    const meter = page.locator('.usage:visible').first();
    await meter.waitFor();
    assert.equal(await meter.innerText(), '1%');
    await send(thread, '/compact');
    await meter.waitFor({ state: 'hidden' });
    await openUi(page, daemon);
    await selectThread(page, thread, false);
    await page.getByText('已压缩上下文：150.0k → 约 32.0k tokens。', { exact: true }).waitFor();
    assert.equal(await page.locator('.usage:visible').count(), 0);
    await send(thread, 'hello again');
    await meter.waitFor();
    assert.equal(await meter.innerText(), '1%');
  } finally {
    await context.close();
  }
});
