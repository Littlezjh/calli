import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildOnce, startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';
let daemon, browser;
const shots = process.env.RAH_E2E_SHOTS_DIR;
before(async () => {
  await buildOnce();
  daemon = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: ['claude', 'codex', 'traex', 'zcode', 'agy', 'pi'].map(id => ({ id, adapter: id, command: [process.execPath, join(repoRoot, 'daemon/test/fixtures', `fake-${['claude', 'traex'].includes(id) ? 'acp' : id}.mjs`)] })) }) });
  browser = await launchBrowser();
  if (shots) mkdirSync(shots, { recursive: true });
});
after(async () => { await browser?.close(); await daemon?.stop(); });

const planChoice = page => page.getByRole(page.viewportSize().width <= 640 ? 'menuitemcheckbox' : 'option', { name: /^计划模式/ });
const attachChoice = page => page.getByRole(page.viewportSize().width <= 640 ? 'menuitem' : 'option', { name: '添加图片或视频', exact: true });

const create = async (agent, title, workMode = 'plan') => {
  const res = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent, title, cwd: daemon.workdir, workMode, permissionMode: 'full_access' }) });
  assert.equal(res.status, 201); return res.json();
};
const select = async (page, title, mobile) => {
  await openUi(page, daemon);
  if (mobile) await page.locator('.menu-btn').click();
  await page.locator('.thread-title', { hasText: title }).first().click();
};
const send = async (page, text) => {
  await page.locator('.composer textarea').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');
};

test('pi plans and executes in the same conversation on desktop and phone in both themes', { timeout: 120000 }, async () => {
  for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme });
    try {
      const page = await context.newPage();
      const title = `pi 设计方案 ${mobile} ${colorScheme}`;
      const thread = await create('pi', title, 'execute');
      await select(page, title, mobile);
      await page.getByRole('button', { name: '添加与模式', exact: true }).click();
      await planChoice(page).click();
      await page.locator('.composer textarea[placeholder="先分析和讨论方案"]').waitFor();
      await send(page, '设计一个简洁的登录页');
      await page.getByText('设计方案：', { exact: true }).waitFor();
      await page.getByRole('button', { name: '开始执行', exact: true }).waitFor();
      if (shots) await page.screenshot({ path: join(shots, `pi-plan-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
      const before = await (await api(daemon, `/api/threads/${thread.id}`)).json();
      await page.reload();
      if (mobile) await page.locator('.menu-btn').click();
      await page.locator('.thread-title', { hasText: title }).first().click();
      await page.getByRole('button', { name: '开始执行', exact: true }).click();
      await page.getByText(/此前只讨论、不实施的限制已解除/).waitFor();
      await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'hidden' });
      const after = await (await api(daemon, `/api/threads/${thread.id}`)).json();
      assert.equal(after.workMode, 'execute');
      assert.equal(after.agentSessionId, before.agentSessionId);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      if (shots) await page.screenshot({ path: join(shots, `pi-execute-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
    } finally { await context.close(); }
  }
});

test('Plan discussion, questions, refresh and execution on desktop and phone in both themes', { timeout: 120000 }, async () => {
  for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme });
    try {
      const page = await context.newPage();
      const title = `计划测试 ${mobile} ${colorScheme}`;
      const thread = await create('codex', title);
      await select(page, title, mobile);
      await page.getByRole('button', { name: '添加与模式', exact: true }).waitFor();
      await send(page, 'plan-question');
      await page.getByRole('region', { name: '智能体提问' }).waitFor();
      if (shots) await page.screenshot({ path: join(shots, `question-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
      await page.reload();
      if (mobile) await page.locator('.menu-btn').click();
      await page.locator('.thread-title', { hasText: title }).first().click();
      await page.getByRole('radio', { name: /桌面和手机/ }).click();
      await page.getByRole('button', { name: '提交回答', exact: true }).click();
      await page.getByRole('button', { name: '开始执行', exact: true }).waitFor();
      await page.locator('.proposal').getByText('实施计划', { exact: true }).last().waitFor();
      assert.equal(await page.getByText('正在整理…', { exact: true }).count(), 0);
      if (shots) await page.screenshot({ path: join(shots, `plan-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
      const before = await (await api(daemon, `/api/threads/${thread.id}`)).json();
      await page.getByRole('button', { name: '开始执行', exact: true }).click();
      await page.getByText(/按我们讨论的计划开始执行/).first().waitFor();
      await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'hidden' });
      const after = await (await api(daemon, `/api/threads/${thread.id}`)).json();
      assert.equal(after.workMode, 'execute'); assert.equal(after.permissionMode, 'full_access'); assert.equal(after.agentSessionId, before.agentSessionId);
      await page.getByRole('button', { name: '添加与模式', exact: true }).click();
      await planChoice(page).click();
      await page.locator('.composer textarea[placeholder="先分析和讨论方案"]').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    } finally { await context.close(); }
  }
});

test('native plan approvals, cancellation, and unsupported agents', { timeout: 60000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    for (const agent of ['claude', 'zcode']) {
      const title = `原生计划审批 ${agent}`;
      const thread = await create(agent, title);
      await select(page, title, false);
      await send(page, 'plan-approval');
      await page.getByRole('region', { name: '计划审批' }).waitFor();
      await page.getByRole('button', { name: '开始执行', exact: true }).click();
      await page.getByText('已提交计划意见', { exact: true }).waitFor();
      await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'hidden' });
      const updated = await (await api(daemon, `/api/threads/${thread.id}`)).json();
      assert.equal(updated.workMode, 'execute');
      const events = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
      assert.equal(events.filter(e => e.type === 'turn.started').length, 1);
    }
    const title = '取消计划提问'; await create('codex', title); await select(page, title, false); await send(page, 'plan-question');
    await page.getByRole('button', { name: '提交回答', exact: true }).waitFor();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await page.getByText('本次询问已结束', { exact: true }).waitFor();
    await create('pi', '普通 Pi', 'execute'); await select(page, '普通 Pi', false);
    await page.getByRole('button', { name: '添加与模式', exact: true }).click();
    assert.equal(await planChoice(page).count(), 1);
    assert.equal(await attachChoice(page).count(), 1);
  } finally { await context.close(); }
});

test('add menu keeps Plan and attachments accessible and the crowded mobile model dial circular', { timeout: 180000 }, async () => {
  for (const width of [1440, 390, 360]) for (const colorScheme of ['light', 'dark']) {
    const mobile = width < 640;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, colorScheme });
    try {
      const page = await context.newPage();
      const title = `输入框 ${width} ${colorScheme}`;
      const thread = await create('codex', title, 'execute');
      await select(page, title, mobile);
      const add = page.getByRole('button', { name: '添加与模式', exact: true });
      const plan = planChoice(page);
      const input = page.locator('.composer textarea');
      assert.equal(await page.getByRole('button', { name: '工作模式', exact: true }).count(), 0);
      await add.click();
      assert.equal(await plan.getAttribute('aria-checked'), 'false');
      await plan.click();
      await page.locator('.composer textarea[placeholder="先分析和讨论方案"]').waitFor();
      await add.click();
      assert.equal(await plan.getAttribute('aria-checked'), 'true');
      if (shots) await page.screenshot({ path: join(shots, `add-${width}-${colorScheme}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.reload();
      if (mobile) await page.locator('.menu-btn').click();
      await page.locator('.thread-title', { hasText: title }).first().click();
      await add.click();
      assert.equal(await plan.getAttribute('aria-checked'), 'true');
      await plan.click();
      await page.locator('.composer textarea[placeholder="先分析和讨论方案"]').waitFor({ state: 'hidden' });
      const updated = await (await api(daemon, `/api/threads/${thread.id}`)).json();
      assert.equal(updated.workMode, 'execute');
      assert.equal(updated.permissionMode, 'full_access');
      await add.click();
      const chooser = page.waitForEvent('filechooser');
      await attachChoice(page).click();
      await (await chooser).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6r0AAAAASUVORK5CYII=', 'base64') });
      await page.locator('.attachment img').waitFor();
      await page.locator('.attachment-remove').click();
      await send(page, 'usage');
      await page.getByText('echo:usage', { exact: true }).waitFor();
      await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'hidden' });
      await send(page, 'slow');
      await page.getByRole('button', { name: '停止', exact: true }).waitFor();
      await input.fill('继续检查布局，保持模型按钮为圆形。');
      await page.getByRole('button', { name: '排队发送', exact: true }).waitFor();
      await page.getByRole('button', { name: '协作', exact: true }).waitFor();
      await page.locator('.composer-bar .usage').waitFor();
      // A shorter viewport exercises the available space above an on-screen keyboard.
      if (mobile) await page.setViewportSize({ width, height: 450 });
      await input.focus();
      const dial = page.getByRole('button', { name: /^模型与思考强度：/ });
      const rect = await dial.boundingBox();
      if (mobile) assert.equal(rect.width, rect.height, `circular dial at ${width}px`);
      const layout = await page.locator('.composer-bar').evaluate(bar => {
        const bounds = bar.getBoundingClientRect();
        const buttons = [...bar.querySelectorAll('button')].map(el => ({ label: el.getAttribute('aria-label') || el.textContent, rect: el.getBoundingClientRect() })).filter(b => b.rect.width > 0);
        return {
          overflow: buttons.filter(b => b.rect.left < bounds.left - 1 || b.rect.right > bounds.right + 1).map(b => b.label),
          overlap: buttons.slice(1).filter((b, i) => b.rect.left < buttons[i].rect.right - 1).map(b => b.label),
        };
      });
      assert.deepEqual(layout, { overflow: [], overlap: [] });
      if (shots) await page.screenshot({ path: join(shots, `toolbar-${width}-${colorScheme}.png`), animations: 'disabled' });
      await add.click();
      assert.equal(await plan.isDisabled(), true);
      assert.equal(await attachChoice(page).isEnabled(), true);
      const menu = await (mobile ? page.getByRole('menu', { name: '添加与模式', exact: true }) : page.locator('.command-menu')).boundingBox();
      const trigger = await add.boundingBox();
      assert.ok(menu.y >= 0 && menu.y + menu.height <= trigger.y, 'add menu stays above the composer');
      if (shots) await page.screenshot({ path: join(shots, `add-running-${width}-${colorScheme}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '停止', exact: true }).click();
      await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'hidden' });
    } finally { await context.close(); }
  }
});
