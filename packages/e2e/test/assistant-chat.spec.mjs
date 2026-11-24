// The assistant's home: the conversation is the page, the desk a drawer. What the drawer does
// to the layout, what the phone does with it, and the one decision a dispatch card carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startDaemon, launchBrowser, api, openUi, openCollaboration } from '../harness.mjs';

const json = async (daemon, path, method = 'GET', body) => {
  const response = await api(daemon, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
};
const waitFor = async (check, what, ms = 60_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
};
const configurePersonal = async (daemon, text = '先记一件事') => {
  await json(daemon, '/api/personal/settings', 'PUT', { agent: 'pi', directory: daemon.workdir });
  const { threadId } = await json(daemon, '/api/personal/say', 'POST', { text });
  await waitFor(async () => (await json(daemon, `/api/threads/${threadId}`)).status === 'idle', 'the Router turn');
  return threadId;
};

test('assistant thread links preview beside the retained conversation on desktop and phone', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser({ showScrollbars: true });
  try {
    const target = await json(daemon, '/api/threads', 'POST', { agent: 'pi', cwd: daemon.workdir, title: '助手链接目标' });
    await json(daemon, `/api/threads/${target.id}/turns`, 'POST', { text: '目标会话正文' });
    await waitFor(async () => (await json(daemon, `/api/threads/${target.id}`)).status === 'idle', 'target reply');
    const markdown = [
      ...Array.from({ length: 10 }, (_, i) => `前文 ${i}：核对统计口径与出处。\n`),
      `普通段落：[打开目标会话](thread://${target.id})。`,
      '',
      '| 会话 | 操作 |',
      '| --- | --- |',
      `| 目标 | [查看会话](thread://${target.id}) |`,
      '',
      `已知引用：「${target.title}」（${target.id.slice(0, 8)}）。`,
      '',
      `完整 ID：${target.id}`,
      '',
      '[飞书材料](https://www.feishu.cn/)',
      ...Array.from({ length: 12 }, (_, i) => `\n补充材料 ${i}：保留原阅读位置与讨论上下文。`),
    ].join('\n');
    await configurePersonal(daemon, `router-fixture-markdown ${JSON.stringify(markdown)}`);
    const shots = join(import.meta.dirname, '../shots/assistant-thread-links');
    mkdirSync(shots, { recursive: true });
    for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        isMobile: phone, hasTouch: phone, colorScheme: theme,
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const cdp = await context.newCDPSession(page);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        const targetReads = [];
        page.on('request', request => { if (request.url().includes(`/threads/${target.id}`)) targetReads.push(request.url()); });
        await openUi(page, daemon);
        await page.evaluate(() => { location.hash = '#/desk'; });
        await page.locator('.chat-flow .row.assistant').waitFor();
        assert.equal(targetReads.length, 0, 'target details are not prefetched');
        for (const kind of ['paragraph', 'table', 'title', 'id', 'keyboard']) {
          await page.evaluate(() => { location.hash = '#/desk'; });
          const answer = page.locator('.chat-flow .row.assistant');
          const link = kind === 'table' ? answer.locator('td a.thread-link')
            : kind === 'title' ? answer.locator('p', { hasText: '已知引用：' }).locator('a.thread-link')
            : kind === 'id' ? answer.locator('p', { hasText: '完整 ID：' }).locator('a.thread-link')
            : answer.locator('p a.thread-link', { hasText: '打开目标会话' });
          await link.waitFor();
          assert.equal(await link.count(), 1, `${kind} renders one actionable link`);
          await link.scrollIntoViewIfNeeded();
          const flow = page.locator('.chat-flow');
          const before = await flow.evaluate(el => el.scrollTop);
          assert.ok(before > 0);
          if (kind === 'keyboard') { await link.focus(); await page.keyboard.press('Enter'); }
          else if (phone) await link.tap();
          else await link.click();
          const panel = page.locator('.chat-home > .agent-panel');
          await panel.locator('.agent-panel-heading', { hasText: target.title }).waitFor();
          await panel.locator('.row.user', { hasText: '目标会话正文' }).waitFor();
          assert.equal(await page.locator('.chat-flow').count(), 1);
          assert.equal(await page.locator('.chat-drawer').count(), 0, 'only one side container');
          assert.equal(new URL(page.url()).hash, '#/desk');
          const mainBox = await page.locator('.chat-main').boundingBox(), panelBox = await panel.boundingBox();
          if (phone) {
            assert.equal(Math.round(panelBox.width), Math.round(mainBox.width));
            assert.equal(Math.round(panelBox.y), 0, 'phone preview merges into one top bar without stacking below .topbar');
            assert.equal(await page.locator('.topbar').isVisible(), false, 'global topbar yields on phone while preview is open');
            assert.equal(await page.locator('.chat-main').evaluate(el => el.inert), true);
          } else assert.ok(panelBox.x >= mainBox.x + mainBox.width - 1, 'beside the talk like a subagent');
          if (kind === 'table') {
            await page.waitForTimeout(500);
            await page.screenshot({ path: join(shots, `${phone ? 'phone' : 'desktop'}-${theme}.png`) });
            if (!phone) {
              const handle = panel.locator('.agent-panel-resize'), box = await handle.boundingBox();
              await page.mouse.move(box.x + 3, box.y + 100); await page.mouse.down();
              await page.mouse.move(box.x - 70, box.y + 100); await page.mouse.up();
              assert.ok((await panel.boundingBox()).width > panelBox.width, 'shares the subagent resize behavior');
              await handle.dblclick();
            }
          }
          if (kind === 'keyboard') await page.keyboard.press('Escape');
          else await panel.getByRole('button', { name: '返回助手', exact: true }).click();
          await panel.waitFor({ state: 'detached' });
          assert.equal(await flow.evaluate(el => el.scrollTop), before, 'closing restores reading position');
          assert.equal(await link.evaluate(el => document.activeElement === el), true, 'closing returns focus to the source');
          assert.equal(await page.locator('.chat-main').evaluate(el => el.inert), false);
          if (phone) await page.waitForTimeout(400);

        }
        const external = page.locator('.chat-flow a[href="https://www.feishu.cn/"]');
        assert.equal(await external.getAttribute('target'), '_blank');
        const flow = page.locator('.chat-flow');
        await flow.evaluate(el => el.scrollTop = 100);
        await flow.hover(); await page.mouse.wheel(0, 240); await page.waitForTimeout(300);
        assert.ok(await flow.evaluate(el => el.scrollTop) > 100);
        await flow.focus(); const beforeKey = await flow.evaluate(el => el.scrollTop);
        await page.keyboard.press('PageDown'); await page.waitForTimeout(300);
        assert.ok(await flow.evaluate(el => el.scrollTop) > beforeKey);
        await page.waitForTimeout(300);
        await flow.evaluate(el => el.scrollTop = 100);
        await page.waitForTimeout(100);
        const bounds = await flow.boundingBox();
        if (phone) {
          const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height - 70;
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          for (let n = 1; n <= 5; n++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - n * 35 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          const size = await flow.evaluate(el => ({ h: el.clientHeight, total: el.scrollHeight, gutter: el.offsetWidth - el.clientWidth }));
          const thumb = size.h * size.h / size.total;
          const x = bounds.x + bounds.width - size.gutter / 2;
          const y = bounds.y + 100 / (size.total - size.h) * (size.h - thumb) + thumb / 2;
          await page.mouse.move(x, y); await page.waitForTimeout(100); await page.mouse.down();
          await page.mouse.move(x, y + 100, { steps: 10 }); await page.mouse.up();
        }
        await page.waitForTimeout(300);
        assert.ok(await flow.evaluate(el => el.scrollTop) > 100, phone ? 'touch scrolls the reader' : 'native scrollbar can be dragged');
        const geometry = await page.evaluate(() => {
          const flow = document.querySelector('.chat-flow'), main = document.querySelector('.chat-main');
          return { edge: Math.abs(flow.getBoundingClientRect().right - main.getBoundingClientRect().right),
            width: getComputedStyle(flow).scrollbarWidth,
            outer: document.querySelector('.scroller:has(.chat-home)').scrollHeight - document.querySelector('.scroller:has(.chat-home)').clientHeight };
        });
        assert.ok(geometry.edge < 2); assert.equal(geometry.width, 'thin'); assert.ok(geometry.outer <= 1, 'no outer vertical scroll');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await daemon.stop(); }
});

test('the desk drawer rides beside the conversation on a wide screen and never moves its reading', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    await configurePersonal(daemon, '核对发布清单与回归结果。'.repeat(300));
    await json(daemon, '/api/todos', 'POST', { text: '整理实验结论', lane: 'you', importance: 'high', dueAt: new Date().toISOString() });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    await page.locator('.chat-home').waitFor();
    await page.locator('.chat-composer textarea').waitFor();
    assert.equal(await page.locator('.chat-drawer').count(), 0, 'the home opens on the conversation alone');
    assert.equal(await page.locator('.chat-entries .chat-entry').count(), 2, 'two quiet circle entries: workbench and settings');

    // '/' finds her composer from the page.
    await page.keyboard.press('/');
    await page.waitForFunction(() => Boolean(document.activeElement.closest('.chat-composer')));

    // The drawer takes real width beside the talk: no cover, no scrim, the composer stays.
    await page.locator('.chat-entries').getByRole('button', { name: '工作台', exact: true }).click();
    await page.locator('.chat-drawer-tabs').getByRole('button', { name: '桌面', exact: true }).click();
    await page.locator('.chat-drawer.side .desk-header').waitFor();
    assert.equal(await page.locator('.chat-drawer-scrim').count(), 0, 'a wide screen gives the drawer real width, not a cover');
    assert.equal(await page.locator('.chat-composer').count(), 1);
    assert.equal(new URL(page.url()).hash, '#/desk/desk', 'the address names the open tab');

    // Closing leaves the conversation where it was read; a reload lands with the drawer as it was left.
    const flow = page.locator('.chat-flow');
    await flow.evaluate(el => { el.scrollTop = 40; });
    const reading = await flow.evaluate(el => el.scrollTop);
    assert.ok(reading > 0, 'the conversation really scrolls, so preserving its reading is exercised');
    await page.locator('.chat-drawer-head').getByRole('button', { name: '关闭', exact: true }).focus();
    await page.keyboard.press('Escape');
    await page.locator('.chat-drawer').waitFor({ state: 'detached' });
    assert.equal(await flow.evaluate(el => el.scrollTop), reading, 'closing the drawer does not scroll the conversation');
    assert.equal(new URL(page.url()).hash, '#/desk');
    await page.locator('.chat-entries').getByRole('button', { name: '工作台', exact: true }).click();
    await page.waitForURL('**/#/desk/desk');
    await page.reload();
    await page.locator('.chat-drawer.side .desk-header').waitFor();
    assert.equal(await page.locator('.chat-drawer-scrim').count(), 0);
    await page.locator('.chat-composer textarea').waitFor();
    await page.locator('.chat-drawer-head').getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.chat-drawer').waitFor({ state: 'detached' });

    // Her session list is one drawer tab away; the router thread itself is not listed again.
    await page.locator('.chat-entries').getByRole('button', { name: '工作台', exact: true }).click();
    await page.locator('.chat-drawer-tabs').getByRole('button', { name: '会话', exact: true }).click();
    await page.locator('.chat-drawer .chat-sessions').waitFor();
    assert.equal(await page.locator('.chat-sessions li button').count(), 0, 'the router thread itself is the conversation, not listed again');
    assert.match(await page.locator('.chat-drawer-empty').textContent(), /还没有别的会话/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await daemon.stop(); }
});

test('a narrower screen covers the talk with the drawer; a phone gives it the whole page', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    await configurePersonal(daemon);
    await json(daemon, '/api/todos', 'POST', { text: '确认合同修改', lane: 'you' });

    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    await page.locator('.chat-home').waitFor();
    await page.locator('.chat-entries').getByRole('button', { name: '工作台', exact: true }).click();
    await page.locator('.chat-drawer.over').waitFor();
    await page.locator('.chat-drawer-scrim').waitFor();
    const overlay = await page.locator('.chat-drawer.over').boundingBox();
    assert.ok(overlay.x > 0 && overlay.width < 900, 'the drawer covers only part of a mid-width screen');
    await page.locator('.chat-drawer-scrim').click({ position: { x: 5, y: 100 } });
    await page.locator('.chat-drawer').waitFor({ state: 'detached' });

    // A phone: the entries are two calm circles, the drawer is the whole width of the page.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await openUi(phone, daemon);
    await phone.evaluate(() => { location.hash = '#/desk'; });
    await phone.locator('.chat-home').waitFor();
    const label = await phone.locator('.chat-entry-label').first().boundingBox();
    assert.ok(label.width <= 2, 'a phone folds the entry labels away but keeps their names');
    await phone.locator('.chat-entries').getByRole('button', { name: '工作台', exact: true }).tap();
    await phone.locator('.chat-drawer-tabs').getByRole('button', { name: '桌面', exact: true }).tap();
    await phone.locator('.chat-drawer.over .desk-matrix').waitFor();
    await phone.locator('.chat-drawer.over').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    const full = await phone.locator('.chat-drawer.over').boundingBox();
    assert.equal(Math.round(full.width), 390, 'the phone drawer takes the whole page width');
    assert.equal(full.x, 0);
    assert.equal(full.y, 0);
    assert.equal(Math.round(full.height), 844, 'the phone drawer covers the global header too');
    await phone.locator('.chat-drawer-head').getByRole('button', { name: '关闭', exact: true }).tap();
    await phone.locator('.chat-drawer').waitFor({ state: 'detached' });
    await phone.locator('.chat-composer textarea').waitFor();
  } finally { await browser.close(); await daemon.stop(); }
});

test('a dispatch card rides in the conversation; starting it lands in its thread', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    await configurePersonal(daemon);
    const todo = await json(daemon, '/api/todos', 'POST', { text: '检查发布结果', lane: 'you' });
    const { threadId } = await json(daemon, '/api/personal/say', 'POST', {
      text: `router-fixture-dispatch ${JSON.stringify({ agent: 'pi', cwd: daemon.workdir, task: '对照清单检查发布结果', title: '检查发布结果', matter: todo.id })}`,
    });
    const run = await waitFor(async () => (await json(daemon, '/api/personal/proactive')).runs.find(item => item.kind === 'dispatch' && item.status === 'asking'), 'the dispatch proposal');
    assert.equal(run.threadId, '');

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    await page.locator('.chat-home').waitFor();
    const orb = page.locator('.chat-ask-orb');
    await orb.getByText('1 待答').waitFor();
    await orb.click();
    const card = page.locator('.chat-ask.dispatch');
    await card.waitFor();
    await card.getByText('派活给 pi').waitFor();
    await card.getByText('对照清单检查发布结果').waitFor();

    await card.getByRole('button', { name: '开始', exact: true }).click();
    await page.locator('.chat-home').waitFor({ state: 'detached' });
    await page.getByText('对照清单检查发布结果').first().waitFor({ timeout: 15_000 });
    const started = (await json(daemon, '/api/personal/proactive')).runs.find(item => item.id === run.id);
    assert.equal(started.status, 'answered');
    assert.notEqual(started.threadId, '');
    assert.notEqual(started.threadId, threadId, 'the work gets a thread of its own');
    await page.locator('.composer textarea').waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await daemon.stop(); }
});

test('a phone keeps one bar: two independent quiet circles with no screaming badges', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    await configurePersonal(daemon);
    await json(daemon, '/api/todos', 'POST', { text: '检查发布清单', lane: 'you', importance: 'high', dueAt: new Date().toISOString() });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    const entries = page.locator('.topbar .topbar-desk .chat-entries');
    await entries.waitFor();
    assert.equal(await page.locator('.chat-top').count(), 0, 'no second bar under the app bar');
    assert.equal(await entries.locator('.chat-entry').count(), 2, 'only workbench and settings circles');
    assert.equal(await entries.locator('.chat-badge').count(), 0, 'no numeric badges on top-right circles');
    await entries.getByRole('button', { name: '工作台', exact: true }).tap();
    await page.locator('.chat-drawer.over').waitFor();
    assert.equal(new URL(page.url()).hash, '#/desk/matters', 'defaults to matters when items wait on you');
    await page.locator('.chat-drawer-tabs').getByRole('button', { name: '会话', exact: true }).tap();
    assert.equal(new URL(page.url()).hash, '#/desk/sessions');
    await page.keyboard.press('Escape');
    await page.locator('.chat-drawer').waitFor({ state: 'detached' });
    const flowTop = await page.locator('.chat-flow, .chat-fresh').first().evaluate(element => element.getBoundingClientRect().top);
    const barBottom = await page.locator('.topbar').evaluate(element => element.getBoundingClientRect().bottom);
    assert.ok(flowTop <= barBottom + 1, `the conversation starts right under the bar (${flowTop} vs ${barBottom})`);
    for (const locale of ['zh', 'en', 'ja']) {
      await page.evaluate(locale => localStorage.setItem('calli.locale', locale), locale);
      await page.reload();
      await entries.waitFor();
      const fit = await page.locator('.topbar').evaluate(bar => {
        const bounds = bar.getBoundingClientRect();
        return [...bar.querySelectorAll('button')].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right && rect.right <= innerWidth; });
      });
      assert.ok(fit, `${locale}: the bar fits a phone without clipping`);
    }
  } finally { await browser.close(); await daemon.stop(); }
});

test('dispatch can be declined without creating work, and a rejected start remains retryable', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    await configurePersonal(daemon);
    const propose = async title => {
      await json(daemon, '/api/personal/say', 'POST', { text: `router-fixture-dispatch ${JSON.stringify({ agent: 'pi', cwd: daemon.workdir, task: title, title })}` });
      return waitFor(async () => (await json(daemon, '/api/personal/proactive')).runs.find(run => run.title === title && run.status === 'asking'), title);
    };
    const declined = await propose('先不用检查依赖');
    const retry = await propose('检查失败后可以重试');
    const count = (await json(daemon, '/api/threads')).length;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    // Asks stay tucked into the bottom-right thumb chip until tapped.
    assert.equal(await page.locator('.chat-tray').count(), 0, 'tray stays folded into the corner chip');
    await page.locator('.chat-ask-orb').getByText('2 待答').tap();
    const rejected = page.locator(`.chat-ask[data-run="${declined.id}"]`);
    assert.equal(await page.locator('.chat-ask-detail').count(), 0, 'no ask opens by itself while several wait');
    await rejected.locator('.chat-ask-row').tap();
    await rejected.getByRole('button', { name: '不用', exact: true }).tap();
    await rejected.waitFor({ state: 'detached' });
    assert.equal((await json(daemon, '/api/threads')).length, count, 'declining starts no work thread');
    assert.equal((await json(daemon, '/api/personal/proactive')).runs.find(run => run.id === declined.id).status, 'discarded');
    let attempt = 0;
    await page.route(`**/api/personal/proactive/runs/${retry.id}/start`, route => ++attempt === 1
      ? route.fulfill({ status: 409, json: { error: 'Agent 暂时不可用', run: retry } }) : route.continue());
    // While the tray is already open, the last ask left stands expanded on its own.
    const card = page.locator(`.chat-ask[data-run="${retry.id}"]`);
    await card.getByRole('button', { name: '开始', exact: true }).tap();
    await card.getByRole('alert').getByText('Agent 暂时不可用', { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: '开始', exact: true }).isEnabled(), true);
    await card.getByRole('button', { name: '开始', exact: true }).tap();
    await page.locator('.chat-home').waitFor({ state: 'detached' });
    assert.equal(attempt, 2);
  } finally { await browser.close(); await daemon.stop(); }
});

// Capture the selected D1 layout using real messages and matters; no screenshot-only UI.
if (process.env.CALLI_ASSISTANT_SHOTS) test('assistant chat screenshot matrix', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  const directory = process.env.CALLI_ASSISTANT_SHOTS;
  mkdirSync(directory, { recursive: true });
  try {
    await json(daemon, '/api/personal/settings', 'PUT', { agent: 'pi', directory: daemon.workdir });
    await json(daemon, '/api/todos', 'POST', { text: '确认发布窗口', lane: 'you', importance: 'high', dueAt: new Date().toISOString() });
    await json(daemon, '/api/todos', 'POST', { text: '整理回归测试结果', lane: 'doing' });
    for (const conversation of ['fresh', 'conversation']) {
      if (conversation === 'conversation') {
        const { threadId } = await json(daemon, '/api/personal/say', 'POST', { text: '先看看今天有哪些事情需要我决定。' });
        await waitFor(async () => (await json(daemon, `/api/threads/${threadId}`)).status === 'idle', 'assistant reply');
      }
      for (const width of [1440, 390]) for (const colorScheme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, hasTouch: width === 390, colorScheme });
        await openUi(page, daemon);
        await page.evaluate(() => { location.hash = '#/desk'; });
        await page.locator(conversation === 'fresh' ? '.chat-fresh' : '.chat-flow .row').first().waitFor();
        await page.locator('.chat-entries').getByRole('button', { name: '工作台', exact: true }).waitFor();
        await page.locator('.chat-composer textarea').waitFor();
        for (const drawer of ['closed', 'open']) {
          if (drawer === 'open') {
            await page.locator('.chat-entries').getByRole('button', { name: '工作台', exact: true }).click();
            await page.locator('.chat-drawer-tabs').getByRole('button', { name: '桌面', exact: true }).click();
            await page.locator('.chat-drawer .desk-header').waitFor();
          }
          await page.mouse.move(0, 0);
          await page.screenshot({ path: join(directory, `${conversation}-${width}-${colorScheme}-${drawer}.png`), fullPage: true, animations: 'disabled' });
        }
        await page.close();
      }
    }
  } finally { await browser.close(); await daemon.stop(); }
});

for (const state of ['answered', 'starting']) test(`a dispatch start conflict ${state} opens only the existing work thread`, async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    await configurePersonal(daemon);
    await json(daemon, '/api/personal/say', 'POST', { text: `router-fixture-dispatch ${JSON.stringify({ agent: 'pi', cwd: daemon.workdir, task: '核对发布清单', title: '核对发布清单' })}` });
    const run = await waitFor(async () => (await json(daemon, '/api/personal/proactive')).runs.find(item => item.kind === 'dispatch' && item.status === 'asking'), 'dispatch');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    await page.locator('.chat-ask-orb').click();
    const card = page.locator(`.chat-ask[data-run="${run.id}"]`);
    await card.waitFor();
    let started;
    let posts = 0;
    await page.route(`**/api/personal/proactive/runs/${run.id}/start`, async route => {
      posts++;
      if (state === 'answered') started = await json(daemon, `/api/personal/proactive/runs/${run.id}/start`, 'POST');
      await route.fulfill({ status: 409, json: { error: state === 'starting' ? 'Starting elsewhere' : '已经开始', ...(state === 'starting' ? { starting: true } : {}), run: started ?? run } });
    });
    await card.getByRole('button', { name: '开始', exact: true }).click();
    if (state === 'starting') {
      await card.locator('button[aria-busy="true"]:disabled').waitFor();
      assert.equal(new URL(page.url()).hash, '#/desk', 'no thread to navigate to until the concurrent start commits');
      started = await json(daemon, `/api/personal/proactive/runs/${run.id}/start`, 'POST');
    }
    await page.locator('.chat-home').waitFor({ state: 'detached' });
    await page.locator('.composer textarea').waitFor();
    assert.equal(posts, 1, 'recovering a conflict never repeats POST start');
    assert.ok(started.threadId);
    assert.equal((await json(daemon, '/api/personal/proactive')).runs.find(item => item.id === run.id).threadId, started.threadId);
  } finally { await browser.close(); await daemon.stop(); }
});

test('assistant preview keeps its origin while loading, failing, retrying and switching targets', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    const first = await json(daemon, '/api/threads', 'POST', { agent: 'pi', cwd: daemon.workdir, title: '预览一' });
    const second = await json(daemon, '/api/threads', 'POST', { agent: 'pi', cwd: daemon.workdir, title: '预览二' });
    for (const thread of [first, second]) {
      await json(daemon, `/api/threads/${thread.id}/turns`, 'POST', { text: thread.title });
      await waitFor(async () => (await json(daemon, `/api/threads/${thread.id}`)).status === 'idle', 'preview target idle');
    }
    await configurePersonal(daemon, `router-fixture-markdown ${JSON.stringify(`[预览一](thread://${first.id})\n\n[预览二](thread://${second.id})`)}`);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    let release;
    await page.route(`**/api/threads/${first.id}`, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await new Promise(resolve => { release = resolve; });
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'preview temporarily unavailable' }) });
    });
    const firstLink = page.locator('.chat-flow a.thread-link', { hasText: '预览一' });
    await firstLink.click();
    const panel = page.locator('.chat-home > .agent-panel');
    await panel.locator('.chat-skeleton').waitFor();
    await waitFor(() => release, 'held request');
    // A different link reuses the same panel; a late first response must not replace it.
    await page.locator('.chat-flow a.thread-link', { hasText: '预览二' }).click();
    await panel.locator('.row.user', { hasText: '预览二' }).waitFor();
    release();
    await page.waitForTimeout(100);
    assert.equal(await panel.locator('.agent-panel-heading strong').textContent(), '预览二');
    await panel.getByRole('button', { name: '返回助手', exact: true }).click();
    await firstLink.click();
    await panel.locator('.chat-skeleton').waitFor();
    await page.waitForTimeout(100); release();
    await panel.getByRole('alert').waitFor();
    assert.match(await panel.getByRole('alert').textContent(), /preview temporarily unavailable/);
    assert.equal(await panel.locator('.chat-skeleton').count(), 0);
    await page.unroute(`**/api/threads/${first.id}`);
    await panel.getByRole('button', { name: '重试', exact: true }).click();
    await panel.locator('.row.user', { hasText: '预览一' }).waitFor();
    // Preview composer aligns with a single thread: model, effort, and reference controls work in place.
    const modelBtn = panel.locator('.model-control-trigger');
    await modelBtn.waitFor();
    await modelBtn.click();
    const modelPop = page.locator('.pop-panel.model-control-panel');
    await modelPop.waitFor();
    if (await modelPop.locator('.effort-model').count()) await modelPop.locator('.effort-model').click();
    const modelChoice = modelPop.locator('[role="menuitemradio"]').filter({ hasNotText: '默认' }).first();
    const pickedModel = (await modelChoice.locator('.pop-item-label').textContent())?.trim();
    await modelChoice.click();
    await waitFor(async () => Boolean((await json(daemon, `/api/threads/${first.id}`)).model), 'preview model persisted');
    assert.ok(pickedModel, 'selected a real model option in preview');
    await page.keyboard.press('Escape');
    await modelPop.waitFor({ state: 'detached' });
    await panel.getByRole('button', { name: '引用会话或目录', exact: true }).waitFor();

    // Sending from this reader goes to the target, and does not replace the assistant page.
    await panel.locator('textarea').fill('侧栏继续核对');
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    try { await panel.locator('.row.assistant', { hasText: '侧栏继续核对' }).waitFor({ timeout: 10000 }); } catch (error) { throw new Error(`${error.message}\n${await panel.innerText()}`); }
    assert.equal(await page.locator('.chat-flow a.thread-link').count(), 2);
    await panel.getByRole('button', { name: '返回助手', exact: true }).click();
    assert.equal(await firstLink.evaluate(el => document.activeElement === el), true);
  } finally { await browser.close(); await daemon.stop(); }
});

test('the shared preview frame keeps the original subagent reader working', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    const root = await json(daemon, '/api/threads', 'POST', { agent: 'pi', cwd: daemon.workdir, title: '侧栏框架回归' });
    await json(daemon, `/api/threads/${root.id}/coordination`, 'POST', {});
    const directive = Buffer.from(JSON.stringify({ args: ['spawn', '--agent', 'pi', '--name', 'worker', '--message-file', '-', '--request-id', 'panel-regression'], text: '成员正文' })).toString('base64');
    await json(daemon, `/api/threads/${root.id}/turns`, 'POST', { text: `CALLI_COMMAND:${directive}` });
    const member = await waitFor(async () => (await json(daemon, `/api/threads/${root.id}/coordination`)).members[0], 'member created');
    await waitFor(async () => (await json(daemon, `/api/threads/${member.id}`)).status === 'idle', 'member reply');
    for (const phone of [false, true]) {
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        await openUi(page, daemon);
        if (phone) await page.locator('.menu-btn').click();
        await page.locator('.thread-row', { hasText: root.title }).click();
        await openCollaboration(page);
        await page.getByRole('button', { name: '协作设置', exact: true }).click();
        await page.getByRole('button', { name: '查看智能体', exact: true }).click();
        await page.locator('.agent-member', { hasText: 'worker' }).click();
        const panel = page.locator('.agent-panel.detail');
        await panel.locator('.agent-panel-heading strong', { hasText: 'worker' }).waitFor();
        await panel.locator('.row.assistant', { hasText: '成员正文' }).waitFor();
        if (!phone) {
          const before = await panel.boundingBox(), handle = panel.locator('.agent-panel-resize');
          const edge = await handle.boundingBox();
          await page.mouse.move(edge.x + 3, edge.y + 100); await page.mouse.down();
          await page.mouse.move(edge.x - 60, edge.y + 100); await page.mouse.up();
          assert.ok((await panel.boundingBox()).width > before.width);
          await handle.dblclick();
        }
        await panel.locator('textarea').fill(`核对侧栏 ${phone}`);
        await panel.getByRole('button', { name: '发送', exact: true }).click();
        await panel.locator('.row.assistant', { hasText: `核对侧栏 ${phone}` }).waitFor();
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached' });
        await page.locator('.topbar-title', { hasText: root.title }).waitFor();
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await daemon.stop(); }
});

test('switching the assistant agent updates immediately without locking the composer or spawning an eager handover turn', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    await configurePersonal(daemon, '整理今天的三项重点');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    await page.locator('.chat-composer textarea').waitFor();

    let releaseSwitch;
    await page.route('**/api/personal/agent', async route => {
      await new Promise(resolve => { releaseSwitch = resolve; });
      await route.continue();
    });

    // Type half a draft before switching: switching must never wipe the draft or disable the box.
    const textarea = page.locator('.chat-composer textarea');
    await textarea.fill('切换后立刻接着聊');
    await page.locator('.chat-agent-pick button').click();
    await page.locator('.pop-panel').getByRole('menuitemradio', { name: /Antigravity|agy/i }).click();

    await waitFor(() => releaseSwitch, 'switch request started');
    assert.equal(await textarea.isDisabled(), false, 'composer stays enabled while switch runs in the background');
    assert.equal(await textarea.inputValue(), '切换后立刻接着聊', 'unsent draft survives agent switch');
    assert.match(await page.locator('.chat-agent-pick button').textContent(), /Antigravity|agy/i, 'picker updates optimistically at once');

    releaseSwitch();
    await page.locator('.chat-earlier').waitFor();
    assert.equal(await page.locator('.chat-flow .row').count(), 0, 'clean new segment starts with zero eager handover turns');
    assert.equal(await textarea.inputValue(), '切换后立刻接着聊', 'draft stays intact after successor thread mounts');

    await page.locator('.chat-composer').getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.chat-flow .row.user', { hasText: '切换后立刻接着聊' }).waitFor();
    await page.locator('.chat-flow .row.assistant').first().waitFor({ timeout: 15_000 });
  } finally { await browser.close(); await daemon.stop(); }
});

test('superagent triage orb shows top-5 titled decisions, opens thread preview on tap, and shelves items cleanly', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    const board = (await json(daemon, '/api/extensions')).find(ext => ext.manifest.id === 'board');
    await json(daemon, '/api/extensions/board/install', 'POST', { granted: board.manifest.permissions });
    await configurePersonal(daemon);
    await json(daemon, '/api/personal/superagent/settings', 'PUT', { enabled: true });

    // Create 6 genuine blocked sessions + 1 casual chat noise session.
    const casual = await json(daemon, '/api/threads', 'POST', { agent: 'pi', cwd: daemon.workdir, title: '闲聊客套会话' });
    await json(daemon, `/api/threads/${casual.id}/turns`, 'POST', { text: 'fixture-progress [进度] 需要你：想听听你那条方案后来怎么样了，要不要我帮你看看它好不好读' });
    await waitFor(async () => (await json(daemon, `/api/threads/${casual.id}`)).status === 'idle', 'casual idle');

    const created = [];
    for (let i = 1; i <= 6; i++) {
      const t = await json(daemon, '/api/threads', 'POST', { agent: 'pi', cwd: daemon.workdir, title: `关键拍板会话${i}（接手）` });
      await json(daemon, `/api/threads/${t.id}/turns`, 'POST', { text: `fixture-progress [进度] 需要你：请确认架构选型 ${i}A 还是 ${i}B` });
      await waitFor(async () => (await json(daemon, `/api/threads/${t.id}`)).status === 'idle', `blocked ${i} idle`);
      created.push(t);
    }

    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    const orb = page.locator('.chat-ask-orb');
    await orb.getByText('6 待答').waitFor();
    await orb.tap();

    const tray = page.locator('.chat-tray.open');
    await tray.waitFor();
    assert.equal(await tray.locator('.chat-ask.triage').count(), 5, 'caps visible triage rows at 5');
    await tray.locator('.chat-triage-more', { hasText: '其余 1 项在工作台' }).waitFor();
    assert.equal(await tray.getByText('闲聊客套会话').count(), 0, 'casual sign-off is filtered out');

    if (process.env.CALLI_TRIAGE_SHOTS) {
      mkdirSync(process.env.CALLI_TRIAGE_SHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.CALLI_TRIAGE_SHOTS, 'triage-phone-light.png'), animations: 'disabled' });
      for (const [label, width, height, mobile, scheme] of [
        ['triage-phone-dark.png', 390, 844, true, 'dark'],
        ['triage-desktop-light.png', 1440, 900, false, 'light'],
        ['triage-desktop-dark.png', 1440, 900, false, 'dark'],
      ]) {
        const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, colorScheme: scheme });
        try {
          const p = await ctx.newPage();
          await openUi(p, daemon);
          await p.evaluate(() => { location.hash = '#/desk'; });
          await p.locator('.chat-ask-orb').click();
          await p.locator('.chat-tray.open').waitFor();
          await p.screenshot({ path: join(process.env.CALLI_TRIAGE_SHOTS, label), animations: 'disabled' });
        } finally { await ctx.close(); }
      }
    }

    const firstRow = tray.locator('.chat-ask.triage').first();
    const firstTitle = (await firstRow.locator('.chat-triage-title').textContent())?.trim();
    assert.match(firstTitle, /^关键拍板会话\d+$/, 'renders clean session title without （接手） suffix');
    assert.match((await firstRow.locator('.chat-triage-sub').textContent()) ?? '', /^请确认架构选型 \d+A 还是 \d+B$/, 'renders stripped decision summary');

    // Shelve the first item via × -> count drops from 6 to 5 and overflow disappears.
    await firstRow.locator('.chat-triage-shelve').tap();
    await orb.getByText('5 待答').waitFor();
    assert.equal(await tray.locator('.chat-triage-more').count(), 0, 'overflow footer disappears once <= 5 remain');

    // Tap the remaining top triage row -> opens its ThreadPeek directly!
    const nextRow = tray.locator('.chat-ask.triage').first();
    const nextTitle = (await nextRow.locator('.chat-triage-title').textContent())?.trim();
    await nextRow.locator('.chat-ask-row.triage-main').tap();
    const panel = page.locator('.chat-home > .agent-panel');
    await panel.locator('.agent-panel-heading', { hasText: nextTitle }).waitFor();
  } finally { await browser.close(); await daemon.stop(); }
});
