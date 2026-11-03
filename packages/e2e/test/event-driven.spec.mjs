// The realtime line and a matter's received messages. The status and the first list are scripted:
// a live Lark connection cannot exist here. The empty list comes from the real signals route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon, launchBrowser, api, openUi } from '../harness.mjs';

const lark = { enabled: true, people: [], chats: [], intervalMin: 30 };
const status = { cli: true, loggedIn: true, lastRunAt: null, nextRunAt: null, lastError: null, lastSignals: 0 };

test('the Lark card says when events are stuck elsewhere, and folds what failed to load', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let realtime = 'busy-elsewhere';
    await page.route('**/api/personal/channels/lark', route => route.request().method() === 'GET' ? route.fulfill({ json: lark }) : route.continue());
    await page.route('**/api/personal/channels/lark/status', route => route.fulfill({ json: { ...status, realtime, topicErrors: realtime !== 'busy-elsewhere' ? [] : [{ ref: 'omt_1', error: 'lark_read_failed' }] } }));
    await openUi(page, daemon);
    const open = async () => {
      await page.evaluate(() => { location.hash = '#/todos'; });
      await page.locator('.personal-summary').click();
      await page.locator('.lark-body').waitFor();
    };
    await open();
    await page.locator('.lark-realtime .personal-warning', { hasText: '事件通道被其他机器占用，10 分钟自动重试' }).waitFor();
    const toggle = page.getByRole('button', { name: '1 个话题拉取失败' });
    assert.equal(await page.locator('.lark-realtime li').count(), 0, 'folded until asked');
    await toggle.click();
    await page.locator('.lark-realtime li', { hasText: 'omt_1' }).getByText('lark_read_failed').waitFor();
    await page.locator('.lark-body .personal-talk-hint', { hasText: '多关注 XX 的消息' }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.personal-settings').waitFor({ state: 'detached' });

    realtime = 'live';
    await page.reload();
    await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
    await open();
    await page.locator('.lark-live', { hasText: '实时' }).waitFor();
    assert.equal(await page.locator('.lark-realtime .personal-warning').count(), 0);

    realtime = 'connecting';
    await page.reload();
    await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
    await open();
    assert.equal(await page.locator('.lark-realtime').count(), 0, 'connecting passes in silence');
  } finally { await browser.close(); await daemon.stop(); }
});

test('a matter reads its received messages only when asked; failure can be retried and empty says so', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    const post = async text => (await api(daemon, '/api/todos', { method: 'POST', body: JSON.stringify({ text, lane: 'you', source: { type: 'lark-task', ref: 'task-1' } }) })).json();
    const full = await post('有消息的事'), empty = await post('没消息的事');
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let reads = 0;
    await page.route(`**/api/personal/signals?matterId=${full.id}`, route => {
      if (++reads === 1) return route.fulfill({ status: 500, json: { error: '读取失败' } });
      return route.fulfill({ json: { signals: [
        { key: 'a', at: new Date().toISOString(), summary: '老板问周报什么时候给', source: null, updatedAt: new Date().toISOString(), disposition: { outcome: 'delivered' } },
        { key: 'b', at: new Date().toISOString(), summary: '群里闲聊', source: null, updatedAt: new Date().toISOString(), disposition: { outcome: 'filtered', reason: 'not-a-request' } },
        { key: 'c', at: new Date().toISOString(), summary: '有人提到这件事', source: null, updatedAt: new Date().toISOString(), disposition: { outcome: 'router' } },
      ] } });
    });
    await openUi(page, daemon);
    await page.evaluate(() => { location.hash = '#/desk'; });
    await page.getByRole('button', { name: '按进度', exact: true }).click();
    await page.locator(`#desk-pile-${full.id}`).click();
    const toggle = page.locator('.desk-signals .desk-subscriptions-toggle');
    await toggle.getByText('收到过的消息').waitFor();
    assert.equal(reads, 0, 'nothing is read until it opens');
    await toggle.click();
    const signals = page.locator('.desk-signals');
    await signals.getByRole('alert').waitFor();
    await signals.getByRole('button', { name: '重试', exact: true }).click();
    await signals.locator('li').first().waitFor();
    await toggle.getByText('收到过的消息 3').waitFor();
    const rows = await signals.locator('li').allTextContents();
    assert.match(rows[0], /老板问周报什么时候给.*已直投给工作线程/);
    assert.match(rows[1], /群里闲聊.*被过滤：不是在找你/);
    assert.match(rows[2], /有人提到这件事.*送了助手/);
    await toggle.click();
    await toggle.click();
    assert.equal(reads, 2, 'reopening does not read again');
    await page.keyboard.press('Escape');
    await page.locator('.desk-spread').waitFor({ state: 'detached' });

    await page.locator(`#desk-pile-${empty.id}`).click();
    await page.locator('.desk-signals .desk-subscriptions-toggle').click();
    await page.locator('.desk-signals').getByText('还没有收到过消息').waitFor();
  } finally { await browser.close(); await daemon.stop(); }
});
