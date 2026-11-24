import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, launchBrowser, openUi, startDaemon } from '../harness.mjs';

test('non-forkable side questions attach a read-only source thread reference in all layouts', { timeout: 120_000 }, async () => {
  const daemon = await startDaemon();
  let browser;
  const post = async (path, body) => {
    const response = await api(daemon, path, { method: 'POST', body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const idle = async id => {
    for (let i = 0; i < 200; i++) {
      const thread = await (await api(daemon, `/api/threads/${id}`)).json();
      assert.notEqual(thread.status, 'error');
      if (thread.status === 'idle') return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('agy thread did not finish');
  };
  try {
    const source = await post('/api/threads', { agent: 'agy', cwd: daemon.workdir, title: 'Non-forkable source' });
    await post(`/api/threads/${source.id}/turns`, { text: 'agy-original-context' });
    await idle(source.id);
    browser = await launchBrowser();
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await openUi(page, daemon);
        await page.evaluate(({ id, theme }) => { document.documentElement.dataset.theme = theme; location.hash = `#/thread/${id}`; }, { id: source.id, theme });
        await page.locator('.main .thread .row.assistant .markdown').first().waitFor();
        await page.evaluate(() => {
          const node = document.createTreeWalker(document.querySelector('.main .thread .row.assistant .markdown'), NodeFilter.SHOW_TEXT).nextNode();
          const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(8, node.textContent.length));
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        });
        await page.locator('.selection-menu button', { hasText: '在侧边栏提问' }).click();
        const side = page.locator('.side-chat');
        const question = `Follow up on agy ${mobile ? 'phone' : 'desktop'} ${theme}`;
        await side.locator('textarea').fill(question);
        const previousIds = new Set((await (await api(daemon, '/api/threads')).json()).map(thread => thread.id));
        await side.locator('.send-btn:not(.stop)').click();
        await side.locator('.row.user .context-reference', { hasText: 'Non-forkable source' }).waitFor();
        await side.locator('.row.user .notes-chip').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const created = (await (await api(daemon, '/api/threads')).json()).find(thread => !previousIds.has(thread.id));
        assert.ok(created);
        assert.equal(created.forkedFrom, null);
        await idle(created.id);
        const events = await (await api(daemon, `/api/threads/${created.id}/events`)).json();
        const started = events.find(event => event.type === 'turn.started');
        assert.match(started.data.text, /calli references .+ --user-inputs/);
        assert.ok(!(started.data.displayText ?? '').includes('calli references '));
        const [ref] = JSON.parse(started.data.displayText.match(/<calli-references>\n([^\n]+)\n<\/calli-references>/)[1]);
        assert.equal(ref.kind, 'thread');
        assert.equal(ref.sourceId, source.id);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await daemon.stop(); }
});
