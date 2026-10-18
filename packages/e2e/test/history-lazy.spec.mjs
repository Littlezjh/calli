import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

test('eight history turns load answers first; work, tool output and diffs load on demand in all viewports', async () => {
  const daemon = await startDaemon();
  let browser;
  try {
    const thread = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '历史按需加载' }) })).json();
    // Seed raw legacy data: the first request also exercises asynchronous projection building.
    const db = new DatabaseSync(join(daemon.dataDir, 'hub.db'));
    let seq = Number(db.prepare('SELECT MAX(seq) AS seq FROM events WHERE thread_id=?').get(thread.id).seq ?? 0);
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)');
    const event = (turn, type, data) => insert.run(thread.id, ++seq, turn, type, new Date(1760000000000 + seq * 1000).toISOString(), JSON.stringify(data));
    db.exec('BEGIN');
    for (let i = 1; i <= 12; i++) {
      const turn = `turn-${i}`;
      event(turn, 'turn.started', { text: `历史问题 ${i}` });
      event(turn, 'message.delta', { text: '我先检查执行记录。' });
      event(turn, 'reasoning.delta', { text: 'THINKING_PRIVATE '.repeat(400) });
      event(turn, 'tool.start', { id: 'run', kind: 'execute', title: 'npm test', input: { command: 'INPUT_PRIVATE' } });
      for (let n = 0; n < 16; n++) event(turn, 'tool.update', { id: 'run', output: `OUTPUT_PRIVATE ${n}\n` + 'result line\n'.repeat(8000) });
      event(turn, 'tool.end', { id: 'run', status: 'completed' });
      event(turn, 'tool.start', { id: 'edit', kind: 'edit', title: 'example.ts' });
      event(turn, 'tool.end', { id: 'edit', status: 'completed', content: [{ type: 'diff', path: 'example.ts', oldText: 'old text\n', newText: 'DIFF_PRIVATE\nnew text\n' }] });
      event(turn, 'message.delta', { text: `历史回答 ${i}：检查已完成，测试通过。` });
      event(turn, 'turn.done', {});
    }
    db.exec('COMMIT'); db.close();
    const begin = performance.now();
    const cold = await (await api(daemon, `/api/threads/${thread.id}/history`)).json();
    const coldMs = performance.now() - begin;
    const warmBegin = performance.now();
    const warm = await (await api(daemon, `/api/threads/${thread.id}/history`)).text();
    const warmMs = performance.now() - warmBegin;
    const all = await (await api(daemon, `/api/threads/${thread.id}/events?all=1`)).json();
    const raw = JSON.stringify(all.filter(e => Number(e.turnId?.split('-')[1]) >= 5));
    assert.equal(cold.events.filter(e => e.type === 'turn.started').length, 8);
    for (const secret of ['INPUT_PRIVATE', 'OUTPUT_PRIVATE', 'THINKING_PRIVATE', 'DIFF_PRIVATE']) assert.ok(!warm.includes(secret));
    console.log(JSON.stringify({ coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), summaryBytes: Buffer.byteLength(warm), summaryGzip: gzipSync(warm).length, fullCompactedBytes: Buffer.byteLength(raw), fullCompactedGzip: gzipSync(raw).length }));
    browser = await launchBrowser();
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        const page = await context.newPage();
        const requests = [];
        const errors = [];
        page.on('request', req => requests.push(req.url()));
        page.on('pageerror', err => errors.push(String(err)));
        await openUi(page, daemon);
        if (mobile) await page.locator('.menu-btn').click();
        await page.locator('.thread-item', { hasText: '历史按需加载' }).click();
        await page.getByText('历史回答 12：检查已完成，测试通过。', { exact: true }).waitFor();
        assert.equal(await page.locator('.work-toggle').count(), 8);
        assert.equal(requests.filter(u => /\/history\/(work|detail)/.test(u)).length, 0);
        const work = page.locator('.work').last();
        await work.locator('.work-toggle').click();
        await work.locator('.run-head').waitFor();
        assert.equal(requests.filter(u => u.includes('/history/work')).length, 1);
        assert.equal(requests.filter(u => u.includes('/history/detail')).length, 0);
        await work.locator('.run-head').click();
        const tool = work.locator('.step').filter({ hasText: 'npm test' });
        await tool.locator('.step-head').click();
        await tool.locator('.step-detail pre').filter({ hasText: 'OUTPUT_PRIVATE 15' }).waitFor();
        assert.equal(requests.filter(u => u.includes('/history/detail')).length, 1);
        await tool.getByRole('button', { name: '继续加载', exact: true }).click();
        await tool.getByRole('button', { name: '继续加载', exact: true }).waitFor({ state: 'detached' });
        assert.equal(requests.filter(u => u.includes('/history/detail')).length, 2);
        await tool.locator('.step-head').click();
        await tool.locator('.step-head').click();
        await tool.locator('.step-detail pre').filter({ hasText: 'OUTPUT_PRIVATE 15' }).waitFor();
        assert.equal(requests.filter(u => u.includes('/history/detail')).length, 2, 'repeat expansion is cached');
        await tool.locator('.step-head').click();
        await page.locator('.changes-row').last().click();
        await page.locator('.changes-file .diff').last().waitFor();
        assert.equal(requests.filter(u => u.includes('/history/detail')).length, 3);
        assert.ok(await page.locator('.changes-file').last().innerText().then(t => t.includes('DIFF_PRIVATE')));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.RAH_E2E_SHOTS_DIR) {
          mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `history-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        }
        await page.locator('.older-messages').click();
        await page.getByText('历史问题 1', { exact: true }).waitFor();
        assert.equal(await page.locator('.work-toggle').count(), 12);
        assert.equal(await page.locator('.older-messages').count(), 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await daemon.stop(); }
});

test('side chats preserve their fork boundary and fetch tool details only on expansion in every viewport', async () => {
  const daemon = await startDaemon();
  let browser;
  try {
    const post = async (path, body) => (await api(daemon, path, { method: 'POST', body: JSON.stringify(body) })).json();
    const root = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: '侧聊历史' });
    await post(`/api/threads/${root.id}/turns`, { text: 'history-origin' });
    for (let i = 0; i < 100; i++) {
      if ((await (await api(daemon, `/api/threads/${root.id}`)).json()).status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    browser = await launchBrowser();
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        const page = await context.newPage();
        const details = [];
        page.on('request', req => { if (req.url().includes('/history/detail')) details.push(req.url()); });
        await openUi(page, daemon);
        if (mobile) await page.locator('.menu-btn').click();
        await page.locator('.thread-item', { hasText: '侧聊历史' }).first().click();
        await page.getByText('hi there history-origin', { exact: true }).waitFor();
        await page.evaluate(() => {
          const node = document.createTreeWalker(document.querySelector('.main .thread .row.assistant .markdown'), NodeFilter.SHOW_TEXT).nextNode();
          const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 8);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        });
        await page.locator('.selection-menu button', { hasText: '在侧边栏提问' }).click();
        const side = page.locator('.side-chat');
        await side.locator('textarea').fill('hello-side');
        await side.locator('.send-btn:not(.stop)').click();
        await side.locator('.work-toggle[aria-expanded=false]').waitFor();
        await side.locator('.row.assistant .markdown').waitFor();
        assert.equal(await side.locator('.row.user').count(), 1);
        assert.equal(details.length, 0);
        await side.locator('.work-toggle').click();
        await side.locator('.step-head').click();
        await side.locator('.step-detail pre').filter({ hasText: 'a.txt' }).waitFor();
        assert.equal(details.length, 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.RAH_E2E_SHOTS_DIR) {
          mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `history-side-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        }
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await daemon.stop(); }
});
