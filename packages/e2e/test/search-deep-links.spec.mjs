// An exact Calli link is a read-only identity lookup, not a conversation keyword search.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { launchBrowser } from '../harness.mjs';

const TOKEN = 'search-fixture-token';
const at = '2026-11-01T12:00:00.000Z';
const thread = (id, title, extra = {}) => ({
  id, title, agent: 'pi', cwd: '/workspace', cwdReal: '/workspace', agentSessionId: null,
  status: 'idle', pinned: false, permissionMode: 'auto_edit', model: null, effort: null,
  archivedAt: null, sectionId: null, forkedFrom: null, unread: false, preview: null,
  terminalActivity: false, waiting: false, queued: [], resumeCommand: null, createdAt: at,
  updatedAt: at, ...extra,
});
const agent = {
  id: 'pi', label: 'Test agent', available: true,
  capabilities: { resume: false, approvals: false, permissionModes: ['auto_edit'], effortLevels: [], images: false, deleteSession: false, history: false, quota: false, fork: false, modelCatalog: false },
};
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

/** Serve the real built app with isolated HTTP state; no daemon or agent process is started. */
async function fixture() {
  const current = thread('current', '标题线索：当前会话');
  const lead = thread('lead', '协作主会话', { coordination: { rootId: 'lead', children: 1, paused: false } });
  const member = thread('member', '隐藏的团队成员', { coordination: { rootId: 'lead', children: 0, paused: false } });
  const source = thread('source', '旧的交接成员');
  const latest = thread('latest', '新的交接成员', { handover: { sourceId: source.id, title: source.title, agent: 'pi' } });
  const copySource = thread('copy-source', '可复制的交接原始成员');
  const copyLatest = thread('copy-latest', '可复制的交接链', { createdAt: '2026-11-01T12:01:00.000Z', updatedAt: '2026-11-01T12:01:00.000Z', handover: { sourceId: copySource.id, title: copySource.title, agent: 'pi' } });
  const local = [current, lead, member, latest, copySource, copyLatest, thread('empty', '还没有消息的会话'), thread('archived', '归档链接会话', { archivedAt: at, unread: true }), source, thread('shared', '本机会话身份')];
  const remote = [thread('shared', '远程会话身份'), thread('remote-listed', '可复制的远程会话'), thread('remote-archive', '远程归档会话', { archivedAt: at, unread: true }), thread('slow', '过期的远程结果')];
  const state = {
    hosts: [{ id: 'remote', label: 'Remote machine', target: 'fixture', status: 'online' }, { id: 'offline', label: 'Offline machine', target: 'fixture', status: 'offline' }],
    requests: [], mutations: [],
  };
  const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const proxy = /^\/api\/hosts\/([^/]+)\/proxy\/(.*)$/.exec(url.pathname);
    const machine = proxy ? decodeURIComponent(proxy[1]) : null;
    const path = proxy ? `/api/${proxy[2]}` : url.pathname;
    const record = { method: req.method, path: url.pathname, query: url.search, machine };
    state.requests.push(record);
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (!path.startsWith('/api/')) {
      const file = resolve(dist, url.pathname === '/' ? 'index.html' : `.${url.pathname}`);
      if (!file.startsWith(dist)) { res.writeHead(404); res.end(); return; }
      try {
        const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
        res.writeHead(200, { 'Content-Type': type }); res.end(readFileSync(file));
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    if (req.method !== 'GET') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      record.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      state.mutations.push(record);
      const id = /^\/api\/threads\/([^/]+)$/.exec(path)?.[1];
      const found = (machine ? remote : local).find(item => item.id === id);
      if (req.method === 'PATCH' && found) {
        if (record.body.archived === false) found.archivedAt = null;
        if (record.body.unread === false) found.unread = false;
        json(found); return;
      }
      json({ error: 'unexpected mutation' }, 400); return;
    }
    if (path === '/api/hosts') { json(state.hosts); return; }
    if (path === '/api/stream' || /^\/api\/threads\/[^/]+\/stream$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.write(': ready\n\n'); return;
    }
    if (path === '/api/threads') {
      // A restored thread joins the real feed; otherwise refresh would erase the newly opened row.
      json(machine
        ? remote.filter(item => ['shared', 'remote-listed'].includes(item.id) || item.id === 'remote-archive' && !item.archivedAt)
        : local.filter(item => ['current', 'lead', 'member', 'latest', 'copy-source', 'copy-latest', 'shared'].includes(item.id) || item.id === 'archived' && !item.archivedAt)); return;
    }
    const exact = /^\/api\/threads\/([^/]+)$/.exec(path);
    if (exact) {
      const id = decodeURIComponent(exact[1]);
      if (id === 'auth') { json({ error: 'unauthorized' }, 401); return; }
      if (id === 'failed') { json({ error: 'unavailable' }, 503); return; }
      if (id === 'dropped') { json({ error: 'node dropped', code: 'host_offline' }, 502); return; }
      const found = (machine ? remote : local).find(item => item.id === id);
      json(found ?? { error: 'thread missing' }, found ? 200 : 404); return;
    }
    if (path === '/api/agents') { json([agent]); return; }
    if (path === '/api/workdirs') { json({ workdirs: ['/workspace'], roots: [{ path: '/workspace', removable: false }] }); return; }
    if (path === '/api/general-settings') { json({ startupPage: 'new-thread', autoArchiveDays: null }); return; }
    if (path === '/api/draft-model-preferences') { json({}); return; }
    if (path === '/api/search') {
      json([{ threadId: 'current', turnId: 'turn-one', title: current.title, cwd: current.cwd, archived: false, role: 'user', snippet: '标题线索也出现在正文里', ts: at }]); return;
    }
    if (/\/history$/.test(path)) { json({ events: [], turnIds: [], hasOlder: false, nextCursor: null, snapshotSeq: 0 }); return; }
    if (/\/coordination$/.test(path)) { json(null); return; }
    if (/\/goal$/.test(path)) { json({ goal: null }); return; }
    if (/\/outputs$/.test(path)) { json({ changes: { files: [], added: 0, removed: 0, total: 0 }, images: [], files: [], seq: 0 }); return; }
    if (path === '/api/desktop') { json({ available: false }); return; }
    if (['/api/sections', '/api/schedules', '/api/todos', '/api/teams', '/api/extensions', '/api/agents/discover', '/api/agents/accounts/discover', '/api/agents/pi/models', '/api/work/sources'].includes(path)) { json([]); return; }
    // Optional features remain unavailable, as with an older hub.
    json({ error: 'fixture endpoint unavailable' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...state, base, local, remote,
    async open({ phone = false, theme = 'light', host = null } = {}) {
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: phone, hasTouch: phone, colorScheme: theme });
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await context.addInitScript(({ host, theme, token }) => {
        localStorage.setItem('calli.token', token);
        if (host) localStorage.setItem('calli.host', host);
        localStorage.setItem('calli.appearance', JSON.stringify({ mode: theme, palette: 'paper' }));
        localStorage.setItem('calli.pet.presence', 'off');
        localStorage.setItem('calli_onboard_dismissed', '1');
      }, { host, theme, token: TOKEN });
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.locator('.sidebar .thread-row').first().waitFor({ state: 'attached' });
      if (phone) await page.locator('.menu-btn').click();
      return { context, page, errors };
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

const lookup = (page) => page.locator('.thread-link-search');
const hit = (page) => lookup(page).locator('.thread-link-result');
async function search(page) {
  await page.getByRole('button', { name: '搜索线程', exact: true }).click();
  return page.getByRole('searchbox');
}
const linkedReads = (f, id) => f.requests.filter(req => req.method === 'GET' && req.path.endsWith(`/threads/${id}`));
/** Read the actual menu's clipboard payload instead of reconstructing a link in the test. */
async function copyLink(page, row) {
  await row.click({ button: 'right' });
  const menu = page.locator('.menu-float');
  await menu.getByRole('menuitem', { name: '复制深度链接', exact: true }).click();
  await menu.waitFor({ state: 'detached' });
  return page.evaluate(() => navigator.clipboard.readText());
}

for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
  // Filtering hidden identities must not open, mark read, restore, or load their conversation.
  test(`exact link search is read-only until clicked: ${phone ? 'phone' : 'desktop'} ${theme}`, { timeout: 30000 }, async () => {
    const f = await fixture(); const { context, page, errors } = await f.open({ phone, theme });
    try {
      const copied = new Map();
      if (!phone) {
        const team = page.locator('.team-group', { hasText: '协作主会话' });
        await team.locator('.handover-toggle').click();
        copied.set('member', await copyLink(page, team.locator('.handover-member', { hasText: '隐藏的团队成员' })));
        assert.equal(copied.get('member'), `${f.base}/#/thread/member`);
        const chain = page.locator('.handover-group', { has: page.locator('.thread-title', { hasText: '可复制的交接链' }) });
        await chain.locator('.handover-toggle').click();
        copied.set('copy-source', await copyLink(page, chain.locator('.handover-member', { hasText: '原始' })));
        assert.equal(copied.get('copy-source'), `${f.base}/#/thread/copy-source`);
      }
      await page.locator('.sidebar .thread-row', { hasText: '标题线索：当前会话' }).locator('.thread-item').click();
      await page.locator('.topbar-title', { hasText: '标题线索：当前会话' }).waitFor({ state: 'attached' });
      if (phone) await page.locator('.menu-btn').click();
      const box = await search(page);
      const mutations = f.mutations.length;
      for (const id of ['empty', 'archived', 'member', 'source', ...(copied.has('copy-source') ? ['copy-source'] : [])]) {
        await box.fill(copied.get(id) ?? (id === 'empty' ? `#/thread/${id}` : `${f.base}/?token=must-not-travel#/thread/${id}`));
        await hit(page).waitFor();
        assert.equal(await hit(page).count(), 1);
        assert.ok((await hit(page).innerText()).includes(f.local.find(item => item.id === id).title));
        assert.equal(await page.locator('.sidebar .thread-row, .sidebar .search-hits').count(), 0, 'identity lookup has no title/fulltext branch');
        assert.equal(f.requests.some(req => req.path === '/api/search'), false);
        assert.equal(f.requests.some(req => new RegExp(`/threads/${id}/(?:history|outputs|events)`).test(req.path)), false, 'filtering does not read conversation details');
        assert.equal(f.mutations.length, mutations, 'filtering has no side effects');
        assert.equal(await page.evaluate(() => localStorage.getItem('calli.host')), null);
        assert.equal(await page.evaluate(() => localStorage.getItem('calli.token')), TOKEN);
        assert.ok((await page.locator('.topbar-title').textContent()).includes('标题线索：当前会话'));
      }
      assert.equal(f.local.find(item => item.id === 'archived').archivedAt, at);
      assert.equal(f.local.find(item => item.id === 'archived').unread, true);
      await box.fill(`${f.base}/?token=must-not-travel#/thread/archived?token=also-drop`);
      await hit(page).getByText('已归档', { exact: true }).waitFor();
      if (process.env.CALLI_E2E_SHOTS_DIR) {
        mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `search-link-${phone ? 'phone' : 'desktop'}-${theme}.png`) });
      }
      await page.evaluate(() => { window.searchHashes = []; window.addEventListener('hashchange', () => window.searchHashes.push(location.hash)); });
      await hit(page).click();
      await page.locator('.topbar-title', { hasText: '归档链接会话' }).waitFor({ state: 'attached' });
      assert.equal(f.local.find(item => item.id === 'archived').archivedAt, null, 'explicit open uses the existing archive-restore flow');
      assert.ok(f.mutations.some(req => req.path === '/api/threads/archived' && req.body.archived === false));
      const hashes = await page.evaluate(() => window.searchHashes);
      assert.ok(hashes.includes('#/thread/archived'), 'explicit open follows the canonical identity route');
      assert.ok(hashes.every(hash => !hash.includes('token')), 'opening uses a token-free route');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
    } finally { await context.close(); await f.close(); }
  });
}

// The same ID can exist on two machines; null always means the main hub, not the selected API.
test('main and remote scopes are exact and switch only on explicit open', { timeout: 30000 }, async () => {
  const f = await fixture(); const { context, page, errors } = await f.open({ host: 'remote' });
  try {
    const box = await search(page);
    await box.fill(`${f.base}/#/thread/shared`);
    await hit(page).getByText('本机会话身份', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('calli.host')), 'remote');
    assert.ok(linkedReads(f, 'shared').some(req => req.machine === null));
    assert.equal(linkedReads(f, 'shared').some(req => req.machine === 'remote'), false);
    await hit(page).click();
    await page.locator('.topbar-title', { hasText: '本机会话身份' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('calli.host')), null);
    await page.getByRole('tab', { name: '全部', exact: true }).click();
    const remoteRow = page.locator('.sidebar .thread-row', { has: page.getByText('可复制的远程会话', { exact: true }) });
    await remoteRow.waitFor();
    const remoteLink = await copyLink(page, remoteRow.locator('.thread-item'));
    assert.equal(remoteLink, `${f.base}/#/thread/remote-listed?machine=remote`, 'merged row copy retains its own machine');
    assert.equal(await page.evaluate(() => localStorage.getItem('calli.host')), null, 'copying a remote row does not switch machines');
    const nextBox = await search(page);
    await nextBox.fill(remoteLink);
    await hit(page).getByText('可复制的远程会话', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('calli.host')), null, 'searching the actual copied URL is also read-only');
    assert.ok(linkedReads(f, 'remote-listed').every(req => req.machine === 'remote'));
    await nextBox.fill(`${f.base}/#/thread/remote-archive?machine=remote`);
    await hit(page).getByText('远程归档会话', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('calli.host')), null);
    assert.equal(f.remote.find(item => item.id === 'remote-archive').archivedAt, at);
    assert.ok(linkedReads(f, 'remote-archive').every(req => req.machine === 'remote'));
    await hit(page).click();
    await page.locator('.topbar-title', { hasText: '远程归档会话' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('calli.host')), 'remote');
    assert.equal(f.remote.find(item => item.id === 'remote-archive').archivedAt, null);
    assert.ok(f.mutations.some(req => req.path === '/api/hosts/remote/proxy/threads/remote-archive' && req.body.archived === false));
    assert.deepEqual(errors, []);
  } finally { await context.close(); await f.close(); }
});

// Link failures stay in the search result, without falling through to normal search or signing out.
test('invalid, foreign, missing, unknown, offline and auth errors stay separate from keywords', { timeout: 30000 }, async () => {
  const f = await fixture(); const { context, page, errors } = await f.open();
  try {
    const box = await search(page);
    for (const value of ['#/thread/', '#/thread/%', `http://other.invalid/#/thread/shared`, `${f.base}/other/#/thread/shared`, `${f.base}/#/thread/shared 关键词`]) {
      await box.fill(value);
      await lookup(page).getByText('会话链接无效或不属于当前 Calli。', { exact: true }).waitFor();
      assert.equal(await hit(page).count(), 0);
    }
    for (const [value, message] of [
      ['#/thread/missing', '找不到链接中的会话，它可能已被删除。'],
      ['#/thread/sha', '找不到链接中的会话，它可能已被删除。'],
      ['#/thread/shared?machine=unknown', '找不到这台机器'],
      ['#/thread/shared?machine=offline', '这台机器现在连不上，它的线程要等连上才看得到。'],
      ['#/thread/auth', 'token 无效或已过期，请重新输入'],
      ['#/thread/failed', '无法定位会话，请检查连接后重试。'],
      ['#/thread/dropped?machine=remote', '这台机器现在连不上，它的线程要等连上才看得到。'],
    ]) {
      await box.fill(value);
      await lookup(page).getByText(message, { exact: true }).waitFor();
      assert.equal(await hit(page).count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('calli.token')), TOKEN);
      assert.equal(await page.evaluate(() => localStorage.getItem('calli.host')), null);
    }
    assert.equal(f.requests.some(req => req.path.includes('/api/hosts/offline/proxy/')), false, 'known offline machines are not queried');
    assert.equal(f.requests.some(req => req.path.includes('/api/hosts/unknown/proxy/')), false, 'unknown machines are not queried');
    assert.equal(f.requests.some(req => req.path === '/api/search'), false);
    assert.deepEqual(f.mutations, []);
    await box.fill('标题线索');
    await page.locator('.sidebar .thread-row', { hasText: '标题线索：当前会话' }).waitFor();
    await page.locator('.search-hits .search-hit').waitFor();
    assert.ok(f.requests.some(req => req.path === '/api/search' && req.query === '?q=%E6%A0%87%E9%A2%98%E7%BA%BF%E7%B4%A2'));
    assert.equal(await lookup(page).count(), 0, 'ordinary title/directory/fulltext behavior remains');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await f.close(); }
});

// Late reads cannot overwrite a newer query or a resolver invalidated by registry changes.
test('stale queries and resolver dependencies never revive old link results', { timeout: 30000 }, async () => {
  const f = await fixture(); const { context, page, errors } = await f.open();
  const releases = [];
  try {
    const box = await search(page);
    let started;
    let pending = new Promise(resolve => { started = resolve; });
    await page.route('**/api/hosts/remote/proxy/threads/slow', async route => {
      started();
      await new Promise(resolve => releases.push(resolve));
      await route.fulfill({ json: f.remote.find(item => item.id === 'slow') });
    });
    await box.fill('#/thread/slow?machine=remote'); await pending;
    await lookup(page).getByRole('status').getByText('正在定位会话…', { exact: true }).waitFor();
    await box.fill('#/thread/empty');
    await hit(page).getByText('还没有消息的会话', { exact: true }).waitFor();
    releases.shift()(); await page.waitForTimeout(100);
    assert.equal(await hit(page).getByText('过期的远程结果', { exact: true }).count(), 0);
    pending = new Promise(resolve => { started = resolve; });
    await box.fill('#/thread/slow?machine=remote'); await pending;
    f.hosts[0].status = 'offline';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await lookup(page).getByText('这台机器现在连不上，它的线程要等连上才看得到。', { exact: true }).waitFor();
    releases.shift()(); await page.waitForTimeout(100);
    assert.equal(await hit(page).count(), 0, 'a late response from the old resolver remains hidden');
    f.hosts[0].status = 'online';
    pending = new Promise(resolve => { started = resolve; });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await pending;
    releases.shift()();
    await hit(page).getByText('过期的远程结果', { exact: true }).waitFor();
    f.hosts[0].status = 'offline';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await lookup(page).getByText('这台机器现在连不上，它的线程要等连上才看得到。', { exact: true }).waitFor();
    assert.equal(await hit(page).count(), 0, 'a displayed result is also invalidated when the resolver changes');
    assert.deepEqual(f.mutations, []);
    assert.equal(await page.evaluate(() => localStorage.getItem('calli.host')), null);
    assert.deepEqual(errors, []);
  } finally { releases.forEach(release => release()); await context.close(); await f.close(); }
});
