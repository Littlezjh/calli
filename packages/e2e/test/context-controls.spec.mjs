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
    FAKE_CODEX_WEEKLY_ONLY: '1', FAKE_CODEX_NO_EFFORT_MODEL: '1',
    RAH_AGENTS_JSON: JSON.stringify({ agents: ['claude', 'codex', 'pi'].map((id) => ({
      id, adapter: id, command: [process.execPath, join(repoRoot, 'daemon/test/fixtures', `fake-${id === 'claude' ? 'acp' : id}.mjs`)],
    })) }),
  });
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await daemon?.stop(); });
const waitFor = async (fn) => {
  for (let i = 0; i < 160; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail('state did not settle');
};
const read = async (thread) => (await api(daemon, `/api/threads/${thread.id}`)).json();
const send = async (thread, text) => {
  const res = await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text }) });
  assert.ok(res.ok);
};
async function makeThread(title, agent = 'codex') {
  const response = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent, cwd: daemon.workdir, title }) });
  assert.equal(response.status, 201);
  const thread = await response.json();
  await send(thread, 'usage');
  await waitFor(async () => (await read(thread)).status === 'idle');
  return thread;
}
async function select(page, thread, mobile = false) {
  await openUi(page, daemon);
  if (mobile) await page.locator('.menu-btn').click();
  await page.locator('.thread-title', { hasText: thread.title }).first().click();
  await page.locator('.usage:visible').waitFor();
}
async function shot(page, name) {
  await page.waitForTimeout(350);
  if (!process.env.RAH_E2E_SHOTS_DIR) return;
  mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `${name}.png`) });
}
async function fits(page, locator) {
  const bounds = await locator.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1 && bounds.y + bounds.height <= page.viewportSize().height + 1);
}

test('effort slider, model subview, reset and compression work in both themes and viewport sizes', async () => {
  for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
    const tag = `${mobile ? 'phone' : 'desktop'}-${colorScheme}`;
    const thread = await makeThread(`上下文操作 ${tag}`);
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme });
    try {
      const page = await context.newPage();
      await select(page, thread, mobile);
      await page.locator('.model-control-trigger').click();
      const slider = page.getByRole('slider', { name: '思考强度' });
      await slider.waitFor();
      await slider.press('Home');
      await waitFor(async () => (await read(thread)).effort === null);
      await page.waitForTimeout(350);
      assert.equal(await slider.getAttribute('aria-valuemax'), '3');
      const rail = await slider.locator('.effort-rail').boundingBox();
      if (mobile) await page.touchscreen.tap(rail.x + rail.width, rail.y + rail.height / 2);
      else {
        let patches = 0;
        page.on('request', (request) => { if (request.method() === 'PATCH' && request.url().endsWith(`/threads/${thread.id}`)) patches++; });
        await page.mouse.move(rail.x, rail.y + rail.height / 2);
        await page.mouse.down();
        await page.mouse.move(rail.x + rail.width, rail.y + rail.height / 2, { steps: 8 });
        assert.equal(patches, 0, 'dragging only previews the selection');
        await page.mouse.up();
        await waitFor(async () => (await read(thread)).effort === 'max');
        assert.equal(patches, 1, 'releasing writes once');
      }
      await waitFor(async () => (await read(thread)).effort === 'max');
      await shot(page, `effort-${tag}`);
      await fits(page, page.locator('.model-control-panel'));
      assert.equal(await slider.getAttribute('aria-valuetext'), '最大');
      await slider.press('ArrowLeft');
      await waitFor(async () => (await read(thread)).effort === 'high');
      await slider.press('End');
      await waitFor(async () => (await read(thread)).effort === 'max');
      await page.getByRole('button', { name: '恢复默认强度' }).click();
      await waitFor(async () => (await read(thread)).effort === null);
      await page.getByRole('button', { name: /切换模型/ }).click();
      await page.getByRole('menuitemradio', { name: 'GPT Small', exact: true }).click();
      await waitFor(async () => (await read(thread)).model === 'gpt-small');
      await waitFor(async () => (await slider.getAttribute('aria-valuemax')) === '2');
      assert.equal(await slider.getAttribute('aria-valuemax'), '2');
      await slider.press('End');
      await waitFor(async () => (await read(thread)).effort === 'high');
      await page.getByRole('button', { name: /切换模型/ }).click();
      await page.getByRole('menuitemradio', { name: 'GPT Basic', exact: true }).click();
      await page.getByText('当前模型不提供思考强度设置。').waitFor();
      assert.equal(await slider.count(), 0);
      await page.keyboard.press('Escape');
      await page.locator('.model-control-trigger').click();
      await page.getByRole('menuitemradio', { name: /GPT Big/ }).last().click();
      await slider.waitFor();
      await page.keyboard.press('Escape');
      const input = page.locator('.composer textarea');
      await input.fill('这段草稿需要保留');
      await page.locator('.usage:visible').click();
      await shot(page, `compact-${tag}`);
      await fits(page, page.getByRole('menu', { name: '上下文用量' }));
      await page.getByRole('button', { name: '压缩 精简较早的对话，释放上下文' }).click();
      await page.getByText('已开始压缩上下文。', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), '这段草稿需要保留');
      await input.fill('/usage');
      await input.press('Enter');
      const quota = page.getByRole('dialog', { name: /Codex 的额度|额度看板/ });
      await quota.getByText('本次仅返回每周额度，服务端未提供 5 小时窗口。').waitFor();
      const boardRow = quota.locator('.quota-board-row').filter({ hasText: 'Codex' });
      const quotaData = await boardRow.count() ? boardRow : quota;
      assert.equal(await quotaData.locator('.quota-chip').innerText(), '7D');
      await shot(page, `quota-weekly-${tag}`);
    } finally { await context.close(); }
  }
});

test('compression queues once during a turn and preserves a draft; pi uses its own compact command', async () => {
  const thread = await makeThread('排队压缩');
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await select(page, thread);
    await page.locator('.composer textarea').fill('下一轮草稿');
    await send(thread, 'delayed');
    await page.getByRole('button', { name: '停止', exact: true }).waitFor();
    await page.locator('.usage:visible').click();
    await page.getByRole('button', { name: /压缩 本轮结束后/ }).click();
    await waitFor(async () => (await read(thread)).queued.length === 1);
    await page.locator('.usage:visible').click();
    assert.ok(await page.getByRole('button', { name: /已排队压缩/ }).isDisabled());
    await page.keyboard.press('Escape');
    await page.getByText('已开始压缩上下文。', { exact: true }).waitFor();
    assert.equal(await page.locator('.composer textarea').inputValue(), '下一轮草稿');
    const pi = await makeThread('pi 压缩操作', 'pi');
    await select(page, pi);
    await page.locator('.usage:visible').click();
    await page.getByRole('button', { name: '压缩 精简较早的对话，释放上下文' }).click();
    await page.getByText('已压缩上下文：150.0k → 约 32.0k tokens。', { exact: true }).waitFor();
  } finally { await context.close(); }
});
