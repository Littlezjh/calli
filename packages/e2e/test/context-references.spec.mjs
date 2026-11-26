import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

test('compact references coexist with notes, survive reload/failure/queue editing, and work on four layouts', { timeout: 180000 }, async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  const shots = process.env.CALLI_REFERENCE_SHOTS;
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
  try {
    const source = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: 'Reference source' });
    await post(`/api/threads/${source.id}/turns`, { text: 'Reference source question' });
    await idle(source.id);
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const thread = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: `References ${mobile} ${theme}` });
      await post(`/api/threads/${thread.id}/turns`, { text: 'Please explain the design.' });
      await idle(thread.id);
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await openUi(page, daemon);
      await page.evaluate(({ id, theme }) => { document.documentElement.dataset.theme = theme; location.hash = `#/thread/${id}`; }, { id: thread.id, theme });
      const composer = page.locator('.composer');
      const input = composer.locator('textarea').last();
      await page.getByRole('button', { name: '引用整条回复', exact: true }).last().click();
      await composer.locator('.note-strip').waitFor();
      await input.fill('Please use @');
      await page.locator('.reference-picker').waitFor();
      // One kind of reference at a time: folders wait in their own tab, not below the chats.
      assert.equal(await page.getByRole('tab').count(), 3);
      assert.equal(await page.getByRole('button', { name: '引用此目录', exact: true }).count(), 0);
      await page.locator('.reference-option', { hasText: 'Reference source' }).click();
      await composer.locator('.context-reference').waitFor();
      assert.equal(await input.inputValue(), 'Please use ');
      await composer.getByRole('button', { name: '引用会话或目录', exact: true }).click();
      await page.getByRole('tab', { name: /目录/ }).click();
      await page.getByRole('button', { name: '引用此目录', exact: true }).click();
      await composer.locator('.context-reference').nth(1).waitFor();
      assert.equal(await composer.locator('.context-reference').count(), 2);
      await input.fill('Compare these references and follow note 1.');
      await page.waitForTimeout(500);
      await page.reload();
      await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
      await page.evaluate(id => { location.hash = `#/thread/${id}`; }, thread.id);
      await composer.locator('.context-reference').nth(1).waitFor();
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      assert.equal(await composer.locator('.note-strip').count(), 1);
      await composer.locator('.context-reference button').first().click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(250);
      assert.ok(await page.getByRole('dialog').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
      }), 'reference details stay inside the viewport');
      if (shots) await page.screenshot({ path: join(shots, `${mobile ? 'mobile' : 'desktop'}-${theme}-details.png`) });
      await page.getByRole('button', { name: '关闭', exact: true }).last().click();
      if (shots) await page.screenshot({ path: join(shots, `${mobile ? 'mobile' : 'desktop'}-${theme}-composer.png`) });
      await composer.getByRole('button', { name: '引用会话或目录', exact: true }).click();
      await page.locator('.reference-picker').waitFor();
      await page.getByRole('tab', { name: /目录/ }).click();
      await page.getByRole('button', { name: '引用此目录', exact: true }).waitFor();
      await page.waitForTimeout(250);
      if (shots) await page.screenshot({ path: join(shots, `${mobile ? 'mobile' : 'desktop'}-${theme}-picker.png`) });
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      // A refused send must leave references and notes editable.
      await page.route('**/turns', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test send failed' }) }), { times: 1 });
      await composer.locator('.send-btn:not(.stop)').click();
      await page.getByText('test send failed', { exact: true }).waitFor();
      await composer.locator('.context-reference').nth(1).waitFor();
      assert.equal(await composer.locator('.context-reference').count(), 2);
      assert.equal(await composer.locator('.note-strip').count(), 1);
      // Queue and take back the same message; structured UI must recover from the wire text.
      await post(`/api/threads/${thread.id}/turns`, { text: 'slow' });
      await composer.locator('.send-btn.stop').waitFor();
      await composer.locator('.send-btn:not(.stop)').click();
      await composer.locator('.queue-item').waitFor();
      assert.equal(await composer.locator('.context-reference').count(), 0);
      assert.ok(!(await composer.locator('.queue-item').innerText()).includes('calli-references'));
      await composer.locator('.queue-item').getByRole('button', { name: /编辑/ }).click();
      await composer.locator('.context-reference').nth(1).waitFor();
      assert.equal(await composer.locator('.note-strip').count(), 1);
      await composer.locator('.send-btn.stop').click();
      await idle(thread.id);
      await composer.locator('.send-btn:not(.stop)').click();
      await page.locator('.row.user .context-reference').nth(1).waitFor();
      assert.equal(await composer.locator('.note-strip').count(), 0);
      const events = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
      const started = events.findLast(event => event.type === 'turn.started');
      assert.match(started.data.text, /calli references/);
      assert.match(started.data.text, /\[注释 1\]/);
      assert.ok(!started.data.displayText.includes('calli-reference-reader'));
      await idle(thread.id);
      await page.locator('.row.user').last().getByRole('button', { name: '编辑这条消息', exact: true }).click();
      const edit = page.locator('.message-edit');
      assert.equal(await edit.locator('.context-reference').count(), 2);
      assert.ok(!(await edit.locator('textarea').inputValue()).includes('calli-references'));
      await edit.getByRole('button', { name: '取消', exact: true }).click();
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await daemon.stop(); }
});

test('typed deep links resolve only on send and keep snapshots through failure, reload, queue and user edit', { timeout: 120000 }, async () => {
  // The fake source and recipient use different adapters; only the existing thread identity matters.
  const fixtureDir = mkdtempSync(join(tmpdir(), 'calli-reference-edit-'));
  const messagesFile = join(fixtureDir, 'messages.json');
  writeFileSync(messagesFile, '{}');
  const daemon = await startDaemon({ FAKE_PI_MESSAGES_FILE: messagesFile });
  const browser = await launchBrowser();
  const post = async (path, body) => {
    const response = await api(daemon, path, { method: 'POST', body: JSON.stringify(body) });
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const idle = async id => {
    for (let i = 0; i < 150; i++) {
      if ((await (await api(daemon, `/api/threads/${id}`)).json()).status !== 'running') return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('agent did not finish');
  };
  try {
    const source = await post('/api/threads', { agent: 'claude', cwd: daemon.workdir, title: 'Deep link source' });
    await post(`/api/threads/${source.id}/turns`, { text: 'Original source question' });
    await idle(source.id);
    const thread = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: 'Deep link recipient' });
    await post(`/api/threads/${thread.id}/turns`, { text: 'Recipient question' });
    await idle(thread.id);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await openUi(page, daemon);
    await page.evaluate(id => { location.hash = `#/thread/${id}`; }, thread.id);
    await page.locator('.topbar-title', { hasText: 'Deep link recipient' }).waitFor();
    await page.waitForTimeout(500);
    const composer = page.locator('.composer');
    const input = composer.locator('textarea').first();
    const send = composer.locator('.send-btn:not(.stop)');
    let creates = 0;
    await page.route('**/api/context-references', async route => { if (route.request().method() === 'POST') creates++; await route.continue(); });
    const foreign = 'https://foreign.example/#/thread/not-local';
    await input.fill(`Please compare ${foreign}`);
    await send.click();
    await page.getByText('会话链接无效或不属于当前 Calli。', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), `Please compare ${foreign}`);
    assert.equal(creates, 0);
    await input.fill(`Please compare #/thread/${source.id}?machine=another`);
    await send.click();
    await page.getByText('暂不支持引用另一台机器的完整会话，请在来源机器的会话中发送。', { exact: true }).waitFor();
    assert.equal(creates, 0);
    const link = `${daemon.base}/#/thread/${source.id}`;
    const body = `Compare [the conversation](${link}) and ${link}. Keep the original URL.`;
    await input.fill(body);
    await page.waitForTimeout(450);
    assert.equal(await input.inputValue(), body);
    assert.equal(await composer.locator('.context-reference').count(), 0, 'typing does not create or attach context');
    assert.equal(creates, 0);
    await page.route(`**/api/threads/${thread.id}/turns`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'deep link send failed' }) }), { times: 1 });
    await send.click();
    await page.getByText('deep link send failed', { exact: true }).waitFor();
    await composer.locator('.context-reference').waitFor();
    assert.equal(creates, 1, 'repeated links create one thread snapshot');
    const saved = await page.evaluate(id => JSON.parse(localStorage.getItem('calli.drafts'))[id], thread.id);
    assert.equal(saved.text, body);
    assert.equal(saved.references.length, 1);
    const snapshot = saved.references[0];
    await post(`/api/threads/${source.id}/turns`, { text: 'Source changed after the failed send' });
    await idle(source.id);
    await page.reload();
    await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
    await page.evaluate(id => { location.hash = `#/thread/${id}`; }, thread.id);
    await composer.locator('.context-reference').waitFor();
    assert.equal(await input.inputValue(), body);
    await post(`/api/threads/${thread.id}/turns`, { text: 'slow' });
    await composer.locator('.send-btn.stop').waitFor();
    await send.click();
    await composer.locator('.queue-item').waitFor();
    assert.equal(creates, 1, 'queue retry reuses the selected snapshot');
    await composer.locator('.queue-item').getByRole('button', { name: /编辑/ }).click();
    await composer.locator('.context-reference').waitFor();
    const taken = await page.evaluate(id => JSON.parse(localStorage.getItem('calli.drafts'))?.[id], thread.id);
    if (taken?.references) assert.equal(taken.references[0].id, snapshot.id);
    assert.equal(await input.inputValue(), body);
    await composer.locator('.send-btn.stop').click();
    await idle(thread.id);
    await send.click();
    await page.locator('.row.user .context-reference').last().waitFor();
    await idle(thread.id);
    const events = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
    const started = events.findLast(event => event.type === 'turn.started');
    assert.match(started.data.text, /calli references/);
    assert.ok(started.data.displayText.includes(body), 'the actual URL and user body remain in the sent message');
    assert.ok(started.data.displayText.includes(JSON.stringify(snapshot)), 'retry did not advance the source boundary');
    // The fake Pi's native record is separate from live prompts, just as in message-edit.spec.
    const recipient = await (await api(daemon, `/api/threads/${thread.id}`)).json();
    writeFileSync(messagesFile, JSON.stringify({ [recipient.agentSessionId]: events.filter(event => event.type === 'turn.started').flatMap(event => [
      { role: 'user', content: event.data.text },
      { role: 'assistant', content: [{ type: 'text', text: 'Recorded test reply' }] },
    ]) }));
    const extra = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: 'User edit source' });
    await post(`/api/threads/${extra.id}/turns`, { text: 'Edit source question' });
    await idle(extra.id);
    await page.locator('.row.user').last().getByRole('button', { name: '编辑这条消息', exact: true }).click();
    const edit = page.locator('.message-edit');
    await edit.locator('textarea').fill(`${body}\nAlso use #/thread/${extra.id}.`);
    await page.route('**/edit', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'deep link edit failed' }) }), { times: 1 });
    await edit.getByRole('button', { name: '发送修改', exact: true }).click();
    await edit.getByText('deep link edit failed', { exact: true }).waitFor();
    assert.equal(await edit.locator('.context-reference').count(), 2);
    assert.equal(creates, 2);
    await page.reload();
    await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
    await page.evaluate(id => { location.hash = `#/thread/${id}`; }, thread.id);
    await page.locator('.row.user').last().getByRole('button', { name: '编辑这条消息', exact: true }).click();
    await edit.locator('.context-reference').nth(1).waitFor();
    assert.equal(await edit.locator('textarea').inputValue(), `${body}\nAlso use #/thread/${extra.id}.`);
    const retryResponse = page.waitForResponse(response => response.url().endsWith('/edit') && response.request().method() === 'POST');
    await edit.getByRole('button', { name: '发送修改', exact: true }).click();
    const retried = await retryResponse;
    const responseText = await retried.text();
    let visibleError = '';
    if (retried.status() !== 202) {
      await edit.locator('.message-edit-error').waitFor();
      visibleError = await edit.locator('.message-edit-error').innerText();
    }
    assert.equal(retried.status(), 202, `edit retry failed: ${responseText}; visible: ${visibleError}; request: ${retried.request().postData()}`);
    await edit.waitFor({ state: 'detached' });
    assert.equal(creates, 2, 'user-message edit retry reuses its durable snapshots');
    await context.close();
  } finally { await browser.close(); await daemon.stop(); rmSync(fixtureDir, { recursive: true, force: true }); }
});

test('pasted UUID variants preserve input and resolve once across four layouts', { timeout: 180000 }, async t => {
  // Clipboard text is never rewritten; failures/reloads retain it and retries keep the first snapshot.
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  const post = async (path, body, method = 'POST') => {
    const response = await api(daemon, path, { method, body: JSON.stringify(body) });
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  try {
    await post('/api/handover-settings', { enabled: false, resume: false, threshold: 90, orders: {} }, 'PUT');
    const source = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: 'Clipboard UUID source' });
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) await t.test(`${mobile ? 'mobile' : 'desktop'} ${theme}`, async () => {
      const title = `Clipboard UUID ${mobile} ${theme}`;
      const thread = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title });
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: daemon.base });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await openUi(page, daemon);
        await page.evaluate(({ id, theme }) => { location.hash = `#/thread/${id}`; document.documentElement.dataset.theme = theme; }, { id: thread.id, theme });
        await page.locator('.topbar-title', { hasText: title }).waitFor();
        const composer = page.locator('.composer');
        const input = composer.locator('textarea').first();
        const send = composer.locator('.send-btn:not(.stop)');
        const created = [];
        await page.route('**/api/context-references', async route => {
          if (route.request().method() === 'POST') created.push(route.request().postDataJSON().sourceId);
          await route.continue();
        });
        const hash = `#/thread/${source.id}`;
        const bomId = `${source.id.slice(0, 8)}\u{FEFF}${source.id.slice(8)}`.replace(/-/g, '‑').toUpperCase();
        for (const [body, error] of [
          [`https://foreign.example/#/thread/${source.id}继续说明`, '会话链接无效或不属于当前 Calli。'],
          [`${hash}以及https://foreign.example/#/thread/other`, '会话链接无效或不属于当前 Calli。'],
          [`${hash}继续%3Fmachine=remote`, '会话链接无效或不属于当前 Calli。'],
          [`${hash}?machine=“remote”`, '暂不支持引用另一台机器的完整会话，请在来源机器的会话中发送。'],
          [`#/thread/${bomId}\u{FEFF}?machine=remote`, '暂不支持引用另一台机器的完整会话，请在来源机器的会话中发送。'],
          [`#/thread/${bomId}\u{FEFF}#/thread/other?machine=remote`, '暂不支持引用另一台机器的完整会话，请在来源机器的会话中发送。'],
          [`ftp://foreign.example/#/thread/${bomId}\u{FEFF}#/thread/other?machine=remote`, '暂不支持引用另一台机器的完整会话，请在来源机器的会话中发送。'],
        ]) {
          await input.fill(body);
          await send.click();
          await page.getByText(error, { exact: true }).waitFor();
          assert.equal(await input.inputValue(), body);
          assert.deepEqual(created, [], 'unsafe boundaries fail before creating any snapshot');
        }
        const link = `${daemon.base}/#/thread/${source.id}`;
        const copiedId = `${source.id.slice(0, 8)}\u{200B}${source.id.slice(8)}`.replace(/-/g, '‑').toUpperCase();
        const body = `${link}对这个增加配置，保留原文。\n“${link.replace(source.id, encodeURIComponent(copiedId))}”\n#/thread/${source.id}继续说明\n“#/thread/${bomId}”\u{FEFF}${hash}`;
        await input.fill('');
        await page.evaluate(text => navigator.clipboard.writeText(text), body);
        await input.focus();
        await page.keyboard.press('Control+V');
        await page.waitForFunction(expected => document.querySelector('.composer textarea')?.value === expected, body);
        assert.equal(await input.inputValue(), body);
        assert.deepEqual(created, [], 'pasting never creates a reference');
        assert.equal(await composer.locator('.context-reference').count(), 0);
        await page.route(`**/api/threads/${thread.id}/turns`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'clipboard send failed' }) }), { times: 1 });
        await send.click();
        await page.getByText('clipboard send failed', { exact: true }).waitFor();
        await composer.locator('.context-reference').waitFor();
        assert.deepEqual(created, [source.id], 'all pasted variants identify the same source');
        assert.equal(await input.inputValue(), body);
        const saved = await page.evaluate(id => JSON.parse(localStorage.getItem('calli.drafts'))[id], thread.id);
        assert.equal(saved.text, body);
        assert.equal(saved.references.length, 1);
        const snapshot = saved.references[0];
        assert.equal(snapshot.sourceId, source.id);
        await page.reload();
        await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
        await page.evaluate(({ id, theme }) => { location.hash = `#/thread/${id}`; document.documentElement.dataset.theme = theme; }, { id: thread.id, theme });
        await composer.locator('.context-reference').waitFor();
        assert.equal(await input.inputValue(), body);
        const accepted = page.waitForResponse(response => response.url().endsWith(`/api/threads/${thread.id}/turns`) && response.request().method() === 'POST');
        await send.click();
        const response = await accepted;
        assert.equal(response.status(), 202, await response.text());
        await page.locator('.row.user .context-reference').waitFor();
        assert.deepEqual(created, [source.id], 'reload and retry reuse the same snapshot');
        const events = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
        const started = events.findLast(event => event.type === 'turn.started');
        assert.ok(started.data.displayText.includes(body), 'the actual sent text retains every original character');
        assert.ok(started.data.displayText.includes(JSON.stringify(snapshot)), 'the original snapshot boundary is retained');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); await daemon.stop(); }
});

test('a link lookup finishing after a thread switch never writes into or sends the new draft', { timeout: 60000 }, async () => {
  // Hold only the reference response, then move to another composer before dispatch finishes.
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  try {
    const post = async body => (await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify(body) })).json());
    const source = await post({ agent: 'claude', cwd: daemon.workdir, title: 'Race source' });
    const original = await post({ agent: 'pi', cwd: daemon.workdir, title: 'Race original' });
    const other = await post({ agent: 'pi', cwd: daemon.workdir, title: 'Race other' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await openUi(page, daemon);
    await page.evaluate(id => { location.hash = `#/thread/${id}`; }, original.id);
    await page.locator('.topbar-title', { hasText: 'Race original' }).waitFor();
    await page.waitForTimeout(500);
    const composer = page.locator('.composer');
    const input = composer.locator('textarea').first();
    let ready;
    const waiting = new Promise(resolve => { ready = resolve; });
    await page.route('**/api/context-references', async route => {
      const response = await route.fetch();
      ready();
      await held;
      await route.fulfill({ response });
    });
    await input.fill(`Please use #/thread/${source.id}`);
    await composer.locator('.send-btn:not(.stop)').click();
    await waiting;
    await page.evaluate(id => { location.hash = `#/thread/${id}`; }, other.id);
    await page.locator('.topbar-title', { hasText: 'Race other' }).waitFor();
    await input.fill('The other unsent draft');
    const sent = page.waitForResponse(response => response.url().includes(`/api/threads/${original.id}/turns`) && response.request().method() === 'POST');
    release();
    await sent;
    await page.waitForTimeout(600);
    assert.equal(await input.inputValue(), 'The other unsent draft');
    assert.equal(await composer.locator('.context-reference').count(), 0);
    const saved = await page.evaluate(id => JSON.parse(localStorage.getItem('calli.drafts'))[id], other.id);
    assert.equal(saved.text, 'The other unsent draft');
    assert.ok(!saved.references?.length);
    const otherEvents = await (await api(daemon, `/api/threads/${other.id}/events`)).json();
    assert.ok(!otherEvents.some(event => event.type === 'turn.started'), 'no request was sent to the switched recipient');
  } finally { release(); await browser.close(); await daemon.stop(); }
});

test('history-rewriting user edits reject typed and retained self-thread references before mutation', { timeout: 120000 }, async t => {
  // An edit changes its own source history; neither form may reach snapshot creation or editTurn.
  const fixtureDir = mkdtempSync(join(tmpdir(), 'calli-reference-self-edit-'));
  const messagesFile = join(fixtureDir, 'messages.json');
  writeFileSync(messagesFile, '{}');
  const daemon = await startDaemon({ FAKE_PI_MESSAGES_FILE: messagesFile });
  const browser = await launchBrowser();
  const post = async (path, body) => {
    const response = await api(daemon, path, { method: 'POST', body: JSON.stringify(body) });
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const idle = async id => {
    for (let i = 0; i < 150; i++) {
      const thread = await (await api(daemon, `/api/threads/${id}`)).json();
      if (thread.status !== 'running') return thread;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('agent did not finish');
  };
  try {
    for (const retained of [false, true]) await t.test(retained ? 'retained self snapshot' : 'typed self link', async () => {
      const title = retained ? 'Retained self edit' : 'Typed self edit';
      const thread = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title });
      await post(`/api/threads/${thread.id}/turns`, { text: 'Original safe question' });
      await idle(thread.id);
      if (retained) {
        const reference = await post('/api/context-references', { kind: 'thread', sourceId: thread.id });
        await post(`/api/threads/${thread.id}/turns`, { text: `<calli-references>\n${JSON.stringify([reference])}\n</calli-references>\n\nAlready selected local context` });
        await idle(thread.id);
      }
      const before = await (await api(daemon, `/api/threads/${thread.id}`)).json();
      const beforeEvents = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
      // Supply Pi's native prompts so a red result cannot be dismissed as missing fake history.
      writeFileSync(messagesFile, JSON.stringify({ [before.agentSessionId]: beforeEvents.filter(event => event.type === 'turn.started').flatMap(event => [
        { role: 'user', content: event.data.text },
        { role: 'assistant', content: [{ type: 'text', text: 'Recorded self-edit reply' }] },
      ]) }));
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openUi(page, daemon);
        await page.evaluate(id => { location.hash = `#/thread/${id}`; }, thread.id);
        await page.locator('.topbar-title', { hasText: title }).waitFor();
        await page.locator('.row.user .message-edit-btn').last().waitFor();
        let creates = 0;
        let edits = 0;
        const editResponses = [];
        await page.route('**/api/context-references', async route => { if (route.request().method() === 'POST') creates++; await route.continue(); });
        await page.route('**/edit', async route => {
          edits++;
          const response = await route.fetch();
          editResponses.push({ status: response.status(), body: await response.text() });
          await route.fulfill({ response });
        });
        await page.locator('.row.user .message-edit-btn').last().click();
        const edit = page.locator('.message-edit');
        const originalBody = retained ? 'Already selected local context' : 'Original safe question';
        // start() focuses at the end on an animation frame; replacing earlier can race its caret move.
        await page.waitForFunction(expected => {
          const input = document.querySelector('.message-edit textarea');
          return input?.value === expected && document.activeElement === input && input.selectionStart === expected.length && input.selectionEnd === expected.length;
        }, originalBody);
        assert.equal(await edit.locator('textarea').inputValue(), originalBody);
        const body = retained ? 'Preserve selected context while editing.' : `Please use #/thread/${thread.id}.`;
        await edit.locator('textarea').fill(body);
        assert.equal(await edit.locator('textarea').inputValue(), body);
        assert.equal(await edit.locator('.context-reference').count(), retained ? 1 : 0);
        await idle(thread.id);
        const boundary = await (await api(daemon, `/api/threads/${thread.id}`)).json();
        const boundaryEvents = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
        // Opening the thread emits a metadata update, but must not alter any original turn or session.
        assert.deepEqual(boundaryEvents.filter(event => event.turnId), beforeEvents.filter(event => event.turnId));
        assert.equal(boundary.agentSessionId, before.agentSessionId);
        await edit.getByRole('button', { name: '发送修改', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.message-edit') || document.querySelector('.message-edit-error'));
        const after = await (await api(daemon, `/api/threads/${thread.id}`)).json();
        const afterEvents = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
        const editor = await page.evaluate(() => {
          const edit = document.querySelector('.message-edit');
          const input = edit?.querySelector('textarea');
          return { draft: input?.value ?? null, editable: !!input && !input.disabled,
            error: edit?.querySelector('.message-edit-error')?.innerText ?? null, references: edit?.querySelectorAll('.context-reference').length ?? 0 };
        });
        const result = { creates, edits, historyUnchanged: JSON.stringify(afterEvents) === JSON.stringify(boundaryEvents),
          sessionUnchanged: after.agentSessionId === boundary.agentSessionId, ...editor };
        assert.deepEqual(result, { creates: 0, edits: 0, historyUnchanged: true, sessionUnchanged: true, draft: body, editable: true,
          error: '编辑会重写当前会话的历史，请先移除指向当前会话的链接和引用。', references: retained ? 1 : 0 },
        `self-edit boundary must reject before any destructive operation; edit responses: ${JSON.stringify(editResponses)}; early-to-send changes: ${JSON.stringify(boundaryEvents.filter(event => !beforeEvents.some(prior => JSON.stringify(prior) === JSON.stringify(event))))}; send-to-rejection changes: ${JSON.stringify(afterEvents.filter(event => !boundaryEvents.some(prior => JSON.stringify(prior) === JSON.stringify(event))))}; session at send: ${boundary.agentSessionId}`);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); await daemon.stop(); rmSync(fixtureDir, { recursive: true, force: true }); }
});

test('terminal confirmation keeps the captured thread and API after a delayed deep-link lookup and navigation', { timeout: 60000 }, async () => {
  // A pending confirmation belongs to the send that opened it, never the currently visible thread.
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  try {
    const post = async body => {
      const response = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const source = await post({ agent: 'claude', cwd: daemon.workdir, title: 'Terminal reference source' });
    const original = await post({ agent: 'pi', cwd: daemon.workdir, title: 'Terminal original A' });
    const other = await post({ agent: 'pi', cwd: daemon.workdir, title: 'Terminal other B' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.route('**/api/threads**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET' || !['/api/threads', `/api/threads/${original.id}`].includes(path)) return route.continue();
      const response = await route.fetch();
      const value = await response.json();
      const mark = thread => thread.id === original.id ? { ...thread, terminalActivity: true } : thread;
      await route.fulfill({ response, json: Array.isArray(value) ? value.map(mark) : mark(value) });
    });
    await openUi(page, daemon);
    await page.evaluate(id => { location.hash = `#/thread/${id}`; }, original.id);
    await page.locator('.topbar-title', { hasText: 'Terminal original A' }).waitFor();
    await page.waitForTimeout(500);
    const composer = page.locator('.composer');
    const input = composer.locator('textarea').first();
    let ready;
    const waiting = new Promise(resolve => { ready = resolve; });
    await page.route('**/api/context-references', async route => {
      const response = await route.fetch();
      ready();
      await held;
      await route.fulfill({ response });
    });
    const body = `Continue in A using #/thread/${source.id}.`;
    await input.fill(body);
    await composer.locator('.send-btn:not(.stop)').click();
    await waiting;
    await page.evaluate(id => { location.hash = `#/thread/${id}`; }, other.id);
    await page.locator('.topbar-title', { hasText: 'Terminal other B' }).waitFor();
    await input.fill('B stays an unsent draft.');
    const beforeOther = await (await api(daemon, `/api/threads/${other.id}/events`)).json();
    release();
    const dialog = page.getByRole('dialog', { name: '这个会话刚在终端里用过', exact: true });
    await dialog.waitFor();
    assert.equal(await input.inputValue(), 'B stays an unsent draft.');
    const sentResponse = page.waitForResponse(response => /\/api\/threads\/[^/]+\/turns$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '仍然发送', exact: true }).click();
    const sent = await sentResponse;
    assert.equal(sent.status(), 202, await sent.text());
    await page.waitForTimeout(600);
    const originalEvents = await (await api(daemon, `/api/threads/${original.id}/events`)).json();
    const afterOther = await (await api(daemon, `/api/threads/${other.id}/events`)).json();
    const sentInOriginal = originalEvents.filter(event => event.type === 'turn.started');
    const draft = await page.evaluate(id => JSON.parse(localStorage.getItem('calli.drafts'))[id], other.id);
    assert.deepEqual({ url: sent.url(), originalTurns: sentInOriginal.length, otherHistoryUnchanged: JSON.stringify(afterOther) === JSON.stringify(beforeOther),
      visibleDraft: await input.inputValue(), storedDraft: draft?.text, referenceChips: await composer.locator('.context-reference').count() },
    { url: `${daemon.base}/api/threads/${original.id}/turns`, originalTurns: 1, otherHistoryUnchanged: true,
      visibleDraft: 'B stays an unsent draft.', storedDraft: 'B stays an unsent draft.', referenceChips: 0 }, 'confirm must use the captured A recipient/API without touching B');
    assert.ok(sentInOriginal[0].data.displayText.includes(body));
    assert.match(sentInOriginal[0].data.text, /calli references/);
    await context.close();
  } finally { release(); await browser.close(); await daemon.stop(); }
});

test('SSE and HTTP acknowledgements preserve attachments added after a deep-link send', { timeout: 120000 }, async t => {
  // The wire text still matches, but a newly dropped image and post-ack wording are unsent draft items.
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    const post = async body => (await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify(body) })).json());
    const source = await post({ agent: 'claude', cwd: daemon.workdir, title: 'Attachment context source' });
    for (const failedResponse of [false, true]) await t.test(failedResponse ? 'failed HTTP response after SSE' : 'successful HTTP response after SSE', async () => {
      let allowRequest;
      let allowResponse;
      const requestGate = new Promise(resolve => { allowRequest = resolve; });
      const responseGate = new Promise(resolve => { allowResponse = resolve; });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      try {
        const thread = await post({ agent: 'pi', cwd: daemon.workdir, title: `Attachment acknowledgement ${failedResponse}` });
        await openUi(page, daemon);
        await page.evaluate(id => { location.hash = `#/thread/${id}`; }, thread.id);
        await page.locator('.topbar-title', { hasText: `Attachment acknowledgement ${failedResponse}` }).waitFor();
        await page.waitForTimeout(500);
        const composer = page.locator('.composer');
        const input = composer.locator('textarea').first();
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        await composer.locator('input[type=file]').setInputFiles({ name: 'submitted.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
        await composer.locator('.attachment img[alt="submitted.png"]').waitFor();
        let creates = 0;
        const requests = [];
        let ready;
        let accepted;
        const waiting = new Promise(resolve => { ready = resolve; });
        const acknowledged = new Promise(resolve => { accepted = resolve; });
        await page.route('**/api/context-references', async route => { if (route.request().method() === 'POST') creates++; await route.continue(); });
        await page.route(`**/api/threads/${thread.id}/turns`, async route => {
          requests.push(JSON.parse(route.request().postData()));
          ready();
          await requestGate;
          const response = await route.fetch();
          accepted();
          await responseGate;
          await route.fulfill(failedResponse
            ? { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'acknowledged send response failed' }) }
            : { response });
        });
        const body = `Use #/thread/${source.id} with the submitted picture.`;
        await input.fill(body);
        await composer.locator('.send-btn:not(.stop)').click();
        await waiting;
        // Drag/drop stays available while send controls are busy; exercise the actual event path.
        await input.evaluate((element, png) => {
          const data = new DataTransfer();
          data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'unsent-later.png', { type: 'image/png' }));
          element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
        }, png);
        await composer.locator('.attachment img[alt="unsent-later.png"]').waitFor();
        assert.equal(await composer.locator('.attachment img').count(), 2);
        allowRequest();
        await acknowledged;
        await page.locator('.row.user .context-reference').waitFor();
        await page.locator('.row.user .sent-image, .row.user .sent-images > *').first().waitFor();
        await page.waitForFunction(() => document.querySelector('.composer textarea').value === '');
        const afterSse = await composer.locator('.attachment img').evaluateAll(images => images.map(image => ({ name: image.alt, previewAlive: image.complete && image.naturalWidth > 0 })));
        assert.equal(await composer.locator('.context-reference').count(), 0, 'SSE consumed the submitted reference');
        // Identical words entered after acknowledgement are another draft, not part of the old send.
        await input.fill(body);
        const sentResponse = page.waitForResponse(response => response.url().endsWith(`/api/threads/${thread.id}/turns`) && response.request().method() === 'POST');
        allowResponse();
        const sent = await sentResponse;
        assert.equal(sent.status(), failedResponse ? 503 : 202, await sent.text());
        if (failedResponse) await page.getByText('acknowledged send response failed', { exact: true }).waitFor();
        await page.waitForTimeout(600); // The next draft's existing persistence debounce is 400 ms.
        const afterHttp = await composer.locator('.attachment img').evaluateAll(images => images.map(image => ({ name: image.alt, previewAlive: image.complete && image.naturalWidth > 0 })));
        const events = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
        const starts = events.filter(event => event.type === 'turn.started');
        const stored = await page.evaluate(id => JSON.parse(localStorage.getItem('calli.drafts'))?.[id], thread.id);
        assert.deepEqual({ afterSse, afterHttp, creates, turnRequests: requests.length, submittedImages: requests[0]?.images?.length,
          turns: starts.length, sentImages: starts[0]?.data.images?.length, body: await input.inputValue(), storedBody: stored?.text,
          referenceChips: await composer.locator('.context-reference').count(), storedReferences: stored?.references?.length ?? 0, uncertain: !!stored?.sending },
        { afterSse: [{ name: 'unsent-later.png', previewAlive: true }], afterHttp: [{ name: 'unsent-later.png', previewAlive: true }],
          creates: 1, turnRequests: 1, submittedImages: 1, turns: 1, sentImages: 1, body, storedBody: body,
          referenceChips: 0, storedReferences: 0, uncertain: false },
        'acknowledgements remove only captured sent items; a later image and identical next draft survive either HTTP outcome');
        assert.ok(starts[0].data.displayText.includes(body));
        assert.match(starts[0].data.text, /calli references/);
      } finally { allowRequest(); allowResponse(); await page.close(); }
    });
  } finally { await browser.close(); await daemon.stop(); }
});
