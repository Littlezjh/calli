import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { api, startDaemon, openUi, launchBrowser, repoRoot } from '../harness.mjs';

let dir, daemon, browser;
const quota = (agent, gemini = 10, claude = 20) => writeFileSync(join(dir, `${agent}.json`), JSON.stringify({ 'Gemini Models': gemini, 'Claude Models': claude }));
const request = async (path, method = 'GET', body) => {
  const res = await api(daemon, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data;
};
const wait = async fn => {
  const end = Date.now() + 20000;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 60)); }
};
const thread = (id) => request(`/api/threads/${id}`);
const idle = id => wait(async () => { const t = await thread(id); return t.status !== 'running' && !['checking', 'preparing', 'countdown'].includes(t.autoHandover?.state) && !t.queued.length && t; });
const create = title => request('/api/threads', 'POST', { agent: 'agy', model: 'gemini-pro', cwd: daemon.workdir, title });
const send = (id, text, queue = false) => request(`/api/threads/${id}/turns`, 'POST', { text, queue });
const configure = (targets, enabled = true) => request('/api/handover-settings', 'PUT', { enabled, threshold: 90, orders: { agy: targets } });
const select = async (page, title, mobile = false) => {
  if (mobile) await page.locator('.menu-btn').click();
  await page.locator('.sidebar .thread-item').filter({ has: page.locator('.thread-title', { hasText: new RegExp(`^${title}$`) }) }).click();
};
const shots = join(repoRoot, 'e2e', 'shots', 'auto-handover');
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rah-auto-e2e-')); mkdirSync(shots, { recursive: true });
  for (const id of ['agy', 'agy2', 'agy3']) quota(id);
  daemon = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: [
    ...['agy', 'agy2', 'agy3'].map((id, i) => ({ id, adapter: 'agy', label: `Agent ${i + 1}`, command: ['fake-agy'], env: { FAKE_HANDOVER_QUOTA: join(dir, `${id}.json`) } })),
    { id: 'offline', adapter: 'agy', label: 'Offline', command: ['missing-auto-fixture'] },
  ] }) });
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await daemon?.stop(); rmSync(dir, { recursive: true, force: true }); });

test('near quota refreshes at turn end, writes summary, counts down, then hands over queued work', async () => {
  quota('agy'); await configure([{ agent: 'agy2', model: 'gemini-pro' }]);
  const source = await create('主动交接');
  await request('/api/agents/agy/quota');
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  try {
    await openUi(page, daemon); await select(page, source.title);
    await send(source.id, 'quota-near'); await send(source.id, 'next queued step', true);
    await page.locator('.auto-notice').filter({ hasText: '即将交接给' }).waitFor();
    const events = await request(`/api/threads/${source.id}/events`);
    assert.ok(events.some(e => e.type === 'turn.started' && e.data.handover));
    assert.equal(events.filter(e => e.type === 'turn.started').length, 2);
    await page.screenshot({ path: join(shots, 'countdown-desktop-light.png') });
    const next = await wait(async () => (await request('/api/threads')).find(t => t.handover?.sourceId === source.id));
    await idle(next.id);
    const starts = (await request(`/api/threads/${next.id}/events`)).filter(e => e.type === 'turn.started');
    assert.match(starts[0].data.text, /请写一份交接摘要/); assert.equal(starts[1].data.text, 'next queued step');
  } finally { await context.close(); }
});

test('same-instance switch continues the same native conversation and shows a durable divider', async () => {
  quota('agy'); await configure([{ agent: 'agy', model: 'claude-sonnet' }]);
  const source = await create('模型接手');
  await send(source.id, 'healthy first'); await idle(source.id);
  const session = (await thread(source.id)).agentSessionId;
  await send(source.id, 'quota-near'); await idle(source.id);
  assert.equal((await thread(source.id)).model, 'claude-sonnet');
  await send(source.id, 'continue on new model'); await idle(source.id);
  assert.equal((await thread(source.id)).agentSessionId, session);
  assert.equal((await request('/api/threads')).filter(t => t.handover?.sourceId === source.id).length, 0);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const page = await context.newPage();
  try {
    await openUi(page, daemon); await select(page, source.title, true);
    await page.locator('.handover-divider').filter({ hasText: '换用 claude-sonnet' }).waitFor();
    await page.screenshot({ path: join(shots, 'model-phone-dark.png') });
    await page.reload(); await select(page, source.title, true);
    await page.locator('.handover-divider').filter({ hasText: '换用 claude-sonnet' }).waitFor();
  } finally { await context.close(); }
});

test('cancel suppresses this episode; exhausted fallback skips unavailable and depleted targets', async () => {
  quota('agy'); quota('agy2', 95); await configure([{ agent: 'offline' }, { agent: 'agy2', model: 'gemini-pro' }, { agent: 'agy3', model: 'gemini-pro' }]);
  const source = await create('取消自动交接');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await openUi(page, daemon); await select(page, source.title, true);
    await send(source.id, 'quota-exhausted');
    await page.locator('.auto-notice').filter({ hasText: 'Agent 3' }).waitFor();
    await page.getByRole('button', { name: '取消这次交接' }).click(); await idle(source.id);
    assert.equal((await request('/api/threads')).some(t => t.handover?.sourceId === source.id), false);
    await send(source.id, 'another turn'); await idle(source.id);
    assert.equal((await request('/api/threads')).some(t => t.handover?.sourceId === source.id), false);
    quota('agy', 0); await send(source.id, 'recovered'); await idle(source.id);
    await send(source.id, 'quota-exhausted'); await idle(source.id);
    const next = (await request('/api/threads')).find(t => t.handover?.sourceId === source.id);
    assert.equal(next.agent, 'agy3'); await idle(next.id);
    const prompt = (await request(`/api/threads/${next.id}/events`)).find(e => e.type === 'turn.started').data.text;
    assert.match(prompt, /hub 从过程记录合成/); assert.match(prompt, /继续未完成的这一轮\n\nquota-exhausted/);
  } finally { await context.close(); quota('agy2'); }
});

for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
  test(`settings and conversation override: ${mobile ? 'phone' : 'desktop'} ${theme}`, async () => {
    await configure([{ agent: 'agy', model: 'gemini-pro' }, { agent: 'agy', model: 'claude-sonnet' }, { agent: 'agy2', model: 'gemini-pro' }]);
    const source = await create(`设置验收 ${mobile} ${theme}`);
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
    const page = await context.newPage();
    try {
      await openUi(page, daemon);
      if (mobile) await page.locator('.menu-btn').click();
      await page.locator('.sidebar').getByRole('button', { name: '配置', exact: true }).click();
      await page.getByRole('menuitem', { name: '自动交接', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '自动交接', exact: true });
      await dialog.locator('.auto-order-head').filter({ hasText: 'Agent 1' }).click();
      await dialog.getByRole('button', { name: '添加接手目标' }).waitFor();
      if (mobile) await dialog.getByRole('button', { name: '下移', exact: true }).first().click();
      else await dialog.locator('li').first().dragTo(dialog.locator('li').nth(1));
      assert.match(await dialog.locator('li').first().innerText(), /claude-sonnet/);
      const box = await dialog.boundingBox(), viewport = page.viewportSize();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await page.screenshot({ path: join(shots, `settings-${mobile ? 'phone' : 'desktop'}-${theme}.png`) });
      await dialog.getByRole('button', { name: '保存交接设置' }).click(); await dialog.waitFor({ state: 'detached' });
      assert.equal((await request('/api/handover-settings')).orders.agy[0].model, 'claude-sonnet');
      await select(page, source.title, mobile);
      await page.getByLabel('这个线程的更多操作').click(); await page.getByRole('menuitem', { name: '交接', exact: true }).click();
      const handover = page.getByRole('dialog', { name: '交接', exact: true });
      await handover.locator('.auto-choice').getByRole('button').click();
      await page.getByRole('menuitemradio', { name: '关闭', exact: true }).click();
      await wait(async () => (await thread(source.id)).autoHandover.override === false);
      await handover.locator('.auto-choice').getByRole('button').filter({ hasText: '关闭 · 本会话' }).waitFor();
      await page.screenshot({ path: join(shots, `conversation-${mobile ? 'phone' : 'desktop'}-${theme}.png`) });
    } finally { await context.close(); }
  });
}

test('collaboration default and overrides; lead CLI sends to the replacement member', async () => {
  quota('agy', 0); quota('agy2'); quota('agy3');
  await configure([{ agent: 'agy2', model: 'gemini-pro' }], false);
  const root = await request('/api/threads', 'POST', { agent: 'agy3', model: 'gemini-pro', cwd: daemon.workdir, title: '协作接手验收' });
  await request(`/api/threads/${root.id}/coordination`, 'POST', {});
  const command = async (args, text) => {
    const encoded = Buffer.from(JSON.stringify({ args, text })).toString('base64');
    await send(root.id, `LIMI_COMMAND:${encoded}`); await idle(root.id);
  };
  await command(['spawn', '--agent', 'agy', '--model', 'gemini-pro', '--name', 'worker', '--message-file', '-', '--request-id', 'spawn-auto'], 'hello');
  let team = await request(`/api/threads/${root.id}/coordination`); const oldId = team.members[0].id; await idle(oldId);
  assert.equal((await thread(oldId)).autoHandover.source, 'collaboration'); assert.equal((await thread(oldId)).autoHandover.enabled, true);
  await request(`/api/threads/${root.id}/collaboration-handover`, 'PATCH', { enabled: false });
  assert.equal((await thread(oldId)).autoHandover.enabled, false);
  await request(`/api/threads/${oldId}/auto-handover`, 'PATCH', { enabled: true });
  assert.equal((await thread(oldId)).autoHandover.source, 'thread');
  await command(['send', 'worker', '--message-file', '-', '--request-id', 'near-auto'], 'quota-near');
  await wait(async () => (await thread(oldId)).autoHandover.state === 'countdown');
  await command(['send', 'worker', '--message-file', '-', '--request-id', 'during-auto'], 'during countdown');
  team = await wait(async () => { const t = await request(`/api/threads/${root.id}/coordination`); return t.members[0].id !== oldId && t; });
  const next = team.members[0]; assert.equal(next.name, 'worker'); await idle(next.id);
  await wait(async () => (await request(`/api/threads/${next.id}/events`)).some(e => e.type === 'turn.started' && e.data.text.includes('during countdown')));
  await command(['send', 'worker', '--message-file', '-', '--request-id', 'after-auto'], 'after handover');
  await wait(async () => (await request(`/api/threads/${next.id}/events`)).some(e => e.type === 'turn.started' && e.data.text.includes('after handover')));
  await idle(next.id);
  team = await request(`/api/threads/${root.id}/coordination`);
  assert.ok(team.messages.some(m => m.from === next.id && m.kind === 'result'));
  assert.ok(team.messages.some(m => m.text.includes('成员 worker 已从 agy 交接给 agy2')));
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' });
  const page = await context.newPage();
  try {
    await openUi(page, daemon); await select(page, root.title);
    await page.getByRole('button', { name: '查看智能体', exact: true }).click();
    const panel = page.getByRole('region', { name: '智能体面板' });
    await panel.locator('.auto-member-mark').waitFor();
    assert.match(await page.locator('.sidebar .team-group .handover-toggle').innerText(), /1 个智能体/);
    assert.equal(await panel.getByRole('switch').getAttribute('aria-checked'), 'false');
    await page.screenshot({ path: join(shots, 'members-desktop-dark.png') });
  } finally { await context.close(); }
});
