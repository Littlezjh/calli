// Scrolling up near the top loads earlier history automatically in every panel surface:
// the assistant home (.chat-flow), thread preview (.agent-panel-body / .thread-peek-body),
// and the team member drawer (.agent-panel-body), preserving reading position without clicking.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, startDaemon, openUi, launchBrowser, openCollaboration, repoRoot } from '../harness.mjs';

let daemon;
let browser;
let dataDir;
let workdir;
const shots = process.env.CALLI_E2E_SHOTS_DIR;

const json = async (path, method = 'GET', body) => {
  const response = await api(daemon, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
};

const waitFor = async (check, what, ms = 30_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
};

const seedTurns = (store, threadId, prefix, count = 12, lastExtra = '') => {
  store.transaction(() => {
    for (let i = 1; i <= count; i++) {
      const add = (type, data) => store.appendEvent(threadId, `t${i}`, type, data);
      add('turn.started', { text: `${prefix}问题 ${i}` });
      const body = Array.from({ length: 6 }, (_, p) => `${prefix}回答 ${i} 第 ${p + 1} 段：用于验证向上滑动自动加载历史并保持阅读位置稳定。`).join('\n\n');
      add('message.delta', { text: i === count && lastExtra ? `${body}\n\n${lastExtra}` : body });
      add('turn.done', { stopReason: 'end_turn' });
    }
  });
};

const deferred = () => {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release: () => release?.() };
};

const swipeUpToTop = async (cdp, locator) => {
  const box = await locator.boundingBox();
  assert.ok(box, 'scroll container has a bounding box');
  const x = Math.round(box.x + box.width / 2);
  const startY = Math.round(box.y + Math.min(180, box.height * 0.25));
  const endY = Math.round(box.y + Math.min(box.height - 40, startY + 420));
  for (let pass = 0; pass < 8; pass++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
    for (let step = 1; step <= 6; step++) {
      const y = Math.round(startY + ((endY - startY) * step) / 6);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise(resolve => setTimeout(resolve, 80));
    const top = await locator.evaluate(el => el.scrollTop);
    if (top < 500) break;
  }
};

const scrollUpToTop = async (page, cdp, locator, mobile) => {
  if (mobile) {
    await swipeUpToTop(cdp, locator);
    return;
  }
  const box = await locator.boundingBox();
  assert.ok(box, 'scroll container has a bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100_000);
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'calli-e2e-panel-older-'));
  workdir = mkdtempSync(join(tmpdir(), 'calli-e2e-panel-older-work-'));
  const { Store } = await import(join(repoRoot, 'daemon/dist/store.js'));
  const store = new Store(dataDir);
  store.saveHubSetting('personal', { directory: workdir, agent: 'pi', model: null });
  store.createThread({ id: 'peek-long', agent: 'pi', cwd: workdir, title: '预览历史会话', permissionMode: 'auto_edit', model: null, effort: null });
  seedTurns(store, 'peek-long', '预览');
  store.createThread({ id: 'assistant-long', agent: 'pi', cwd: workdir, title: '助手', permissionMode: 'auto_edit', model: null, effort: null });
  seedTurns(store, 'assistant-long', '助手', 12, '[打开预览历史](thread://peek-long)');
  store.saveHubSetting('personalRouter', { threadId: 'assistant-long', introduced: true, lastReply: null, lastReplyAt: null });
  store.close();

  daemon = await startDaemon({ CALLI_DATA_DIR: dataDir, CALLI_WORKDIRS: workdir });
  browser = await launchBrowser();
  if (shots) mkdirSync(shots, { recursive: true });
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
  test(`assistant home and side preview load older messages on scroll up (${mobile ? 'phone' : 'desktop'}-${colorScheme})`, { timeout: 60_000 }, async () => {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: mobile, hasTouch: mobile, colorScheme,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const cdp = await context.newCDPSession(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const olderHold = deferred();
    const peekHold = deferred();
    try {
      await openUi(page, daemon);
      await page.evaluate(() => { location.hash = '#/desk'; });
      const flow = page.locator('.chat-flow');
      await flow.locator('.row.user[data-turn="t12"]').waitFor();
      assert.equal(await flow.locator('.thread .bubble').count(), 2, 'initial assistant page renders 2 recent turns');

      const assistantRequests = [];
      page.on('request', req => { if (req.url().includes('/threads/assistant-long/history?before=')) assistantRequests.push(req.url()); });
      let holdFirst = true;
      await page.route('**/threads/assistant-long/history?before=*', async route => {
        if (holdFirst) { holdFirst = false; await olderHold.promise; }
        await route.continue();
      });

      await scrollUpToTop(page, cdp, flow, mobile);
      await waitFor(() => assistantRequests.length >= 1, 'assistant scroll-up triggered older history request');
      await flow.locator('.older-row .spinner').waitFor();
      const anchorBefore = await flow.locator('.row.user[data-turn="t11"]').evaluate(el => el.getBoundingClientRect().top);
      olderHold.release();

      await page.waitForFunction(() => document.querySelectorAll('.chat-flow .thread .bubble').length === 10);
      await page.waitForTimeout(150);
      const anchorAfter = await flow.locator('.row.user[data-turn="t11"]').evaluate(el => el.getBoundingClientRect().top);
      assert.ok(Math.abs(anchorAfter - anchorBefore) <= 4, `assistant reading position stays put (${anchorBefore} -> ${anchorAfter})`);
      assert.equal(assistantRequests.length, 1, 'restoring scroll position does not trigger duplicate requests');

      // Second scroll up loads the remaining 2 oldest turns and removes the older button.
      await scrollUpToTop(page, cdp, flow, mobile);
      await page.waitForFunction(() => document.querySelectorAll('.chat-flow .thread .bubble').length === 12);
      await page.waitForTimeout(150);
      assert.equal(await flow.locator('.older-messages').count(), 0, 'no load-older button left once oldest page is loaded');
      assert.equal(assistantRequests.length, 2, 'exactly two older pages fetched');
      if (shots) await page.screenshot({ path: join(shots, `assistant-scroll-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`), animations: 'disabled' });

      // Now open the linked thread in ThreadPeek (side panel) and verify scroll-up auto-loading there too.
      const link = flow.locator('a.thread-link', { hasText: '打开预览历史' });
      await link.scrollIntoViewIfNeeded();
      if (mobile) await link.tap(); else await link.click();
      const panel = page.locator('.chat-home > .agent-panel');
      const peekBody = panel.locator('.agent-panel-body');
      await peekBody.locator('.row.user[data-turn="t12"]').waitFor();
      assert.equal(await peekBody.locator('.thread .bubble').count(), 2, 'initial preview page renders 2 recent turns');

      const peekRequests = [];
      page.on('request', req => { if (req.url().includes('/threads/peek-long/history?before=')) peekRequests.push(req.url()); });
      let holdPeekFirst = true;
      await page.route('**/threads/peek-long/history?before=*', async route => {
        if (holdPeekFirst) { holdPeekFirst = false; await peekHold.promise; }
        await route.continue();
      });

      await scrollUpToTop(page, cdp, peekBody, mobile);
      await waitFor(() => peekRequests.length >= 1, 'preview scroll-up triggered older history request');
      await peekBody.locator('.older-row .spinner').waitFor();
      const peekBefore = await peekBody.locator('.row.user[data-turn="t11"]').evaluate(el => el.getBoundingClientRect().top);
      peekHold.release();

      await page.waitForFunction(() => document.querySelectorAll('.chat-home > .agent-panel .thread .bubble').length === 10);
      await page.waitForTimeout(150);
      const peekAfter = await peekBody.locator('.row.user[data-turn="t11"]').evaluate(el => el.getBoundingClientRect().top);
      assert.ok(Math.abs(peekAfter - peekBefore) <= 4, `preview reading position stays put (${peekBefore} -> ${peekAfter})`);
      assert.equal(peekRequests.length, 1);

      await scrollUpToTop(page, cdp, peekBody, mobile);
      await page.waitForFunction(() => document.querySelectorAll('.chat-home > .agent-panel .thread .bubble').length === 12);
      await page.waitForTimeout(150);
      assert.equal(await peekBody.locator('.older-messages').count(), 0);
      assert.equal(peekRequests.length, 2);
      if (shots) await page.screenshot({ path: join(shots, `peek-scroll-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`), animations: 'disabled' });
      assert.deepEqual(errors, []);
    } finally {
      olderHold.release();
      peekHold.release();
      await context.close();
    }
  });
}

test('assistant scroll-up error pauses auto-retry until the user clicks retry', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    const flow = page.locator('.chat-flow');
    await flow.locator('.row.user[data-turn="t12"]').waitFor();
    let attempts = 0;
    await page.route('**/threads/assistant-long/history?before=*', async route => {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'history temporarily unavailable' }) });
      await route.continue();
    });

    const box = await flow.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100_000);
    await flow.locator('.older-row [role="alert"]').waitFor();
    assert.equal(attempts, 1);

    // Further upward wheels must not spam failing requests while an error is shown.
    await page.mouse.wheel(0, -2000);
    await page.waitForTimeout(200);
    assert.equal(attempts, 1);

    await flow.locator('.older-messages', { hasText: '重试' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-flow .thread .bubble').length === 10);
    assert.equal(attempts, 2);
  } finally {
    await context.close();
  }
});

test('team member panel loads older messages on scroll up without clicking', async () => {
  const root = await json('/api/threads', 'POST', { agent: 'pi', cwd: workdir, title: '成员滚动测试' });
  await json(`/api/threads/${root.id}/coordination`, 'POST', {});
  const directive = Buffer.from(JSON.stringify({
    args: ['spawn', '--agent', 'pi', '--name', 'worker', '--message-file', '-', '--request-id', 'scroll-older'],
    text: '成员初始任务',
  })).toString('base64');
  await json(`/api/threads/${root.id}/turns`, 'POST', { text: `CALLI_COMMAND:${directive}` });
  const member = await waitFor(async () => (await json(`/api/threads/${root.id}/coordination`)).members[0], 'member created');
  await waitFor(async () => (await json(`/api/threads/${member.id}`)).status === 'idle', 'member idle');

  for (let i = 2; i <= 4; i++) {
    const text = `成员问题 ${i}\n\n` + Array.from({ length: 6 }, (_, p) => `成员补充 ${i}-${p + 1}：确保面板有足够滚动高度。`).join('\n\n');
    await json(`/api/threads/${member.id}/turns`, 'POST', { text });
    await waitFor(async () => (await json(`/api/threads/${member.id}`)).status === 'idle', `member turn ${i} idle`);
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const cdp = await context.newCDPSession(page);
  const hold = deferred();
  try {
    await openUi(page, daemon);
    await page.locator('.thread-row', { hasText: root.title }).click();
    await openCollaboration(page);
    await page.getByRole('button', { name: '协作设置', exact: true }).click();
    await page.getByRole('button', { name: '查看智能体', exact: true }).click();
    await page.locator('.agent-member', { hasText: 'worker' }).click();

    const body = page.locator('.agent-panel.detail .agent-panel-body');
    await body.locator('.thread .bubble', { hasText: '成员问题 4' }).waitFor();
    assert.equal(await body.locator('.thread .bubble').count(), 2);

    const requests = [];
    page.on('request', req => { if (req.url().includes(`/threads/${member.id}/history?before=`)) requests.push(req.url()); });
    await page.route(`**/threads/${member.id}/history?before=*`, async route => {
      await hold.promise;
      await route.continue();
    });

    await scrollUpToTop(page, cdp, body, false);
    await waitFor(() => requests.length >= 1, 'member panel scroll-up triggered older history request');
    await body.locator('.older-row .spinner').waitFor();
    const beforeTop = await body.locator('.thread .bubble', { hasText: '成员问题 3' }).evaluate(el => el.getBoundingClientRect().top);
    hold.release();

    await body.locator('.thread .bubble', { hasText: '成员问题 2' }).waitFor();
    await page.waitForTimeout(150);
    assert.equal(await body.locator('.thread .bubble').count(), 3);
    const afterTop = await body.locator('.thread .bubble', { hasText: '成员问题 3' }).evaluate(el => el.getBoundingClientRect().top);
    assert.ok(Math.abs(afterTop - beforeTop) <= 4, `member panel reading position stays put (${beforeTop} -> ${afterTop})`);
    assert.equal(await body.locator('.older-messages').count(), 0);
    assert.equal(requests.length, 1);
  } finally {
    hold.release();
    await context.close();
  }
});
