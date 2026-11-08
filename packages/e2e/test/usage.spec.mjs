// Context occupancy must survive reloads, shrink independently of billed totals, and clear when unknown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

let daemon;
let browser;

before(async () => {
  daemon = await startDaemon({
    CALLI_AGENTS_JSON: JSON.stringify({ agents: ['claude', 'codex', 'pi'].map((id) => ({
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

async function expectUsage(page, percent) {
  const usage = page.locator('.composer .usage');
  const label = percent === null ? '上下文用量未知 · 查看详情' : `上下文已用 ${percent}% · 查看详情`;
  await page.waitForFunction(label => document.querySelector('.composer .usage')?.getAttribute('aria-label') === label, label);
  assert.equal(await usage.getAttribute('aria-label'), label);
  assert.equal(await usage.innerText(), '', 'the ring has no visible percentage text');
  assert.equal(await usage.locator('svg').count(), 1);
  return usage;
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
        let modelReads = 0;
        page.on('request', request => { if (/^\/api\/agents\/[^/]+\/models$/.test(new URL(request.url()).pathname)) modelReads++; });
        const modelsLoaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents/codex/models' && response.ok());
        await openUi(page, daemon);
        await selectThread(page, thread, mobile);
        await modelsLoaded;
        const usage = await expectUsage(page, 71);
        const model = page.locator('.model-control-trigger');
        await model.waitFor();
        // Read both controls in one frame while the desktop sidebar is still settling.
        assert.ok(await page.evaluate(() => {
          const ring = document.querySelector('.composer .usage')?.getBoundingClientRect();
          const model = document.querySelector('.composer .model-control-trigger')?.getBoundingClientRect();
          return ring && model && ring.width > 0 && model.width > 0 && ring.right <= model.left + 1;
        }), 'the context ring is left of the model button');
        const readsBefore = modelReads;
        await usage.click();
        const panel = page.locator('.context-usage-panel');
        const meter = panel.locator('.context-percent');
        await meter.waitFor();
        assert.equal(await meter.innerText(), '71%');
        assert.equal(await page.locator('.context-usage-panel.high').count(), 0);
        assert.equal(await page.locator('.model-control-panel').count(), 0, 'the ring opens only context details');
        await panel.locator('.pop-note', { hasText: '上下文已用' }).waitFor();
        assert.equal(await panel.locator('.pop-note', { hasText: '上下文已用' }).innerText(), '上下文已用 184k / 258k');
        // Let the phone drawer and anchored menu finish moving before inspecting their bounds.
        await page.waitForTimeout(450);
        assert.equal(modelReads, readsBefore, 'opening context details does not request the model catalog');
        const bounds = await panel.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1 && bounds.y + bounds.height <= page.viewportSize().height + 1);
        if (process.env.CALLI_E2E_SHOTS_DIR) {
          mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `context-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        }
        await openUi(page, daemon);
        await selectThread(page, thread, mobile);
        await expectUsage(page, 71);
        await usage.click();
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
    const usage = await expectUsage(page, 5);
    await usage.click();
    const meter = page.locator('.context-usage-panel .context-percent');
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
    const usage = await expectUsage(page, 1);
    await usage.click();
    const panel = page.locator('.context-usage-panel');
    const meter = panel.locator('.context-percent');
    await meter.waitFor();
    assert.equal(await meter.innerText(), '1%');
    await panel.getByRole('button', { name: '压缩 精简较早的对话，释放上下文', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(await usage.getAttribute('aria-expanded'), 'false');
    await expectUsage(page, null);
    await openUi(page, daemon);
    await selectThread(page, thread, false);
    await page.getByText('已压缩上下文：150.0k → 约 32.0k tokens。', { exact: true }).waitFor();
    await expectUsage(page, null);
    await usage.click();
    await panel.getByText('暂未获取上下文用量，下一次响应后更新。', { exact: true }).waitFor();
    assert.equal(await meter.count(), 0, 'unknown context is not shown as a percentage');
    await send(thread, 'hello again');
    await expectUsage(page, 1);
    await meter.waitFor();
    assert.equal(await meter.innerText(), '1%');
  } finally {
    await context.close();
  }
});
