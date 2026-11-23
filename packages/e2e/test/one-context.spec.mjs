import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

/**
 * The one-context entries a person touches: a new thread beside this one carries a removable
 * "From" tag, a copied conversation pointer pastes as a chip that really reads, a copied quote
 * stays a quote in another conversation, and the @ picker keeps the source reachable.
 */
test('one context: beside tag, conversation pointer paste, copied quote paste and the @ picker', { timeout: 240000 }, async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  const shots = process.env.CALLI_ONE_CONTEXT_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const post = async (path, body) => {
    const response = await api(daemon, path, { method: 'POST', body: JSON.stringify(body) });
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const idle = async id => {
    for (let i = 0; i < 100; i++) {
      if ((await (await api(daemon, `/api/threads/${id}`)).json()).status !== 'running') return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('agent did not finish');
  };
  const events = async id => (await (await api(daemon, `/api/threads/${id}/events`)).json());
  const lastStarted = async id => (await events(id)).findLast(event => event.type === 'turn.started');
  const pasteInto = (locator, text) => locator.evaluate((area, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);

  try {
    // One source with a real answer to quote, a same-directory neighbour, a recipient for the
    // pointer, and enough far-away threads that a default picker list has to cap them.
    const source = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: 'Pointer source' });
    await post(`/api/threads/${source.id}/turns`, { text: 'POINTER_SOURCE_REQUIREMENT: ship the pointer flow' });
    await idle(source.id);
    const neighbour = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: 'Neighbour chat' });
    const recipient = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: 'Pointer recipient' });
    for (let i = 0; i < 10; i++) {
      mkdirSync(join(daemon.workdir, `far-${i}`), { recursive: true });
      await post('/api/threads', { agent: 'pi', cwd: join(daemon.workdir, `far-${i}`), title: `Far thread ${i}` });
    }

    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const place = `${mobile ? 'mobile' : 'desktop'}-${theme}`;
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await openUi(page, daemon);
      await page.evaluate(id => { location.hash = `#/thread/${id}`; }, source.id);
      await page.locator('.composer').waitFor();
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const composer = page.locator('.composer');
      const input = composer.locator('textarea').last();
      const more = page.getByRole('button', { name: '这个线程的更多操作', exact: true });
      const blankDraft = async () => {
        if (mobile) await page.getByRole('button', { name: '打开线程列表', exact: true }).click();
        await page.locator('.sidebar').getByRole('button', { name: '新线程', exact: true }).click();
        await page.locator('.topbar-title', { hasText: '新线程' }).waitFor();
        await composer.locator('textarea').last().waitFor();
      };

      // Copy a conversation pointer from the thread menu's copy submenu.
      await more.click();
      await page.getByRole('menuitem', { name: '复制', exact: true }).click();
      await page.waitForTimeout(250);
      if (shots) await page.screenshot({ path: join(shots, `${place}-menu.png`) });
      await page.getByRole('menuitem', { name: '复制对话引用', exact: true }).click();
      const pointer = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(pointer, new RegExp(`^Calli: Pointer source\\ncalli://thread/${source.id}\\?machine=`), 'a readable pointer with the hub thread id');

      // A new thread in this directory starts with one removable "From" tag.
      await more.click();
      await page.getByRole('menuitem', { name: '在此目录新建线程', exact: true }).click();
      await composer.locator('.context-reference', { hasText: 'Pointer source' }).waitFor();
      assert.match(await composer.locator('.context-reference').first().innerText(), /来自：Pointer source/);
      await page.waitForTimeout(250);
      if (shots) await page.screenshot({ path: join(shots, `${place}-auto-tag.png`) });

      // The @ picker ranks the source first, and search still reaches threads beyond the cap.
      await input.fill('Ask with @');
      await page.locator('.reference-picker').waitFor();
      assert.match(await page.locator('.reference-option').first().innerText(), /Pointer source/);
      await page.locator('.reference-picker input').fill('Far thread 9');
      await page.locator('.reference-option', { hasText: 'Far thread 9' }).waitFor();
      await page.waitForTimeout(250);
      if (shots) await page.screenshot({ path: join(shots, `${place}-picker.png`) });
      await page.keyboard.press('Escape');

      // A deleted tag stays deleted across a reload, and sending then grants no read.
      await composer.locator('.context-reference').getByRole('button', { name: '移除引用 Pointer source', exact: true }).click();
      assert.equal(await composer.locator('.context-reference').count(), 0);
      await page.reload();
      await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
      // The app re-resolves data-theme from storage on every mount, so the forced theme has to
      // come back after the reload or the later "dark" screenshots would render light.
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await blankDraft();
      assert.equal(await composer.locator('.context-reference').count(), 0, 'the removed automatic tag does not come back');
      await input.fill('Plain question without the source');
      const created = page.waitForResponse(response => /\/api\/threads$/.test(response.url()) && response.request().method() === 'POST');
      await composer.locator('.send-btn:not(.stop)').click();
      const besideId = (await (await created).json()).id;
      await idle(besideId);
      const plainStarted = await lastStarted(besideId);
      assert.doesNotMatch(plainStarted.data.text, /calli references|Pointer source/);

      // Starting over from another thread keeps only that thread's automatic tag.
      await page.evaluate(id => { location.hash = `#/thread/${id}`; }, neighbour.id);
      await page.getByRole('button', { name: '这个线程的更多操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '在此目录新建线程', exact: true }).click();
      await composer.locator('.context-reference', { hasText: 'Neighbour chat' }).waitFor();
      assert.equal(await composer.locator('.context-reference').count(), 1, 'only the newest source is tagged');

      // A plain new thread never carries the tag.
      await blankDraft();
      assert.equal(await composer.locator('.context-reference').count(), 0);

      // Pasting the pointer into an existing thread turns into a canonical, deletable chip.
      await page.evaluate(id => { location.hash = `#/thread/${id}`; }, recipient.id);
      await composer.locator('textarea').last().waitFor();
      await input.click();
      await pasteInto(input, pointer);
      await composer.locator('.context-reference', { hasText: 'Pointer source' }).waitFor();
      assert.equal(await input.inputValue(), '', 'the pointer text itself is consumed');
      await page.waitForTimeout(250);
      if (shots) await page.screenshot({ path: join(shots, `${place}-pointer-paste.png`) });
      await input.fill('Follow the referenced conversation');
      await composer.locator('.send-btn:not(.stop)').click();
      await idle(recipient.id);
      const pointerStarted = await lastStarted(recipient.id);
      assert.match(pointerStarted.data.text, /calli references .+ --user-inputs/);
      assert.doesNotMatch(pointerStarted.data.displayText, /calli-reference-reader|calli:\/\/thread/);

      // A quote copied from the source stays a quoted note elsewhere, and never names the thread.
      await page.evaluate(id => { location.hash = `#/thread/${id}`; }, source.id);
      await page.locator('.row.message-actions').last().waitFor();
      await page.locator('.row.message-actions').last().getByRole('button', { name: '更多消息操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '复制为引用', exact: true }).click();
      const quote = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(quote, /^Calli: Pointer source\ncalli:\/\/thread\//);
      assert.match(quote, /^> /m);
      await blankDraft();
      await input.click();
      await pasteInto(input, quote);
      await composer.locator('.note-strip').waitFor();
      assert.equal(await composer.locator('.context-reference').count(), 0, 'a copied quote is a note, not a loose chip');
      assert.doesNotMatch(await input.inputValue(), /来源：|calli:\/\//);
      await page.waitForTimeout(250);
      if (shots) await page.screenshot({ path: join(shots, `${place}-quote-paste.png`) });
      await input.fill('Answer with this quote in mind');
      const quoteCreated = page.waitForResponse(response => /\/api\/threads$/.test(response.url()) && response.request().method() === 'POST');
      await composer.locator('.send-btn:not(.stop)').click();
      const quotedId = (await (await quoteCreated).json()).id;
      await idle(quotedId);
      const quoteStarted = await lastStarted(quotedId);
      assert.match(quoteStarted.data.text, /calli references .+ --turn /);
      assert.match(quoteStarted.data.text, /\[注释 1\]/);
      assert.doesNotMatch(quoteStarted.data.displayText, /calli-reference-reader/);
      assert.doesNotMatch((await (await api(daemon, `/api/threads/${quotedId}`)).json()).title, /来源：|Calli:/);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await daemon.stop(); }
});
