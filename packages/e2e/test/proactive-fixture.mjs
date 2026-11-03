import { api } from '../harness.mjs';

const post = async (daemon, text, extra = {}) => (await api(daemon, '/api/todos', { method: 'POST', body: JSON.stringify({ text, lane: 'you', ...extra }) })).json();

/** Real matters, and scripted runs on them: one of each state the desk can show. */
export async function arrangeProactive(daemon) {
  const sandboxTodo = await post(daemon, '修导出边界');
  const prepareTodo = await post(daemon, '周五的评审会');
  const mergedTodo = await post(daemon, '已经合入的事');
  const failedTodo = await post(daemon, '补迁移脚本');
  const at = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
  const runs = [
    { id: 'sandbox-1', matterId: sandboxTodo.id, kind: 'sandbox', repo: '/repo', branch: `calli/proactive/${sandboxTodo.id}`, threadId: 'x1', startedAt: at(40), endedAt: at(30), status: 'ready', summary: '补好导出的边界测试，修了空列表时的崩溃。', testReport: 'npm test: 12 passed', files: [{ path: 'src/export.ts', additions: 10, deletions: 2 }, { path: 'test/export.test.ts', additions: 24, deletions: 0 }] },
    { id: 'prepare-1', matterId: prepareTodo.id, kind: 'prepare', threadId: 'x2', startedAt: at(90), endedAt: at(85), status: 'ready', summary: '列好目标、待决策问题和上次遗留。', files: [{ path: `matters/${prepareTodo.id}/artifacts/outline.md`, additions: 12, deletions: 0 }] },
    { id: 'merged-1', matterId: mergedTodo.id, kind: 'sandbox', repo: '/repo', branch: `calli/proactive/${mergedTodo.id}`, threadId: 'x3', startedAt: at(200), endedAt: at(190), status: 'merged', summary: '文档里的命令更新了。', files: [{ path: 'docs/a.md', additions: 1, deletions: 1 }] },
    { id: 'failed-1', matterId: failedTodo.id, kind: 'sandbox', repo: '/repo', threadId: 'x4', startedAt: at(300), endedAt: at(295), status: 'failed', summary: '测试没跑起来：缺少数据库。' },
  ];
  const requests = { searches: [], read(search) { this.searches.push(search); }, reads() { return this.searches.length; }, diffs: 0, actions: [] };
  return { sandboxTodo, prepareTodo, mergedTodo, failedTodo, runs, requests, failNext: {} };
}

/** Answers the proactive API from the scripted runs, so a page sees them move. */
export async function routes(page, { runs, requests, failNext }) {
  await page.route(/\/api\/personal\/proactive(\?.*)?$/, route => { requests.read(new URL(route.request().url()).search); return route.fulfill({ json: { settings: { enabled: true, repos: [] }, runs } }); });
  await page.route(/\/api\/personal\/proactive\/runs\/[^/]+\/diff$/, route => { requests.diffs++; return route.fulfill({ json: { files: [{ path: 'src/export.ts', additions: 10, deletions: 2 }, { path: 'test/export.test.ts', additions: 24, deletions: 0 }] } }); });
  await page.route(/\/api\/personal\/proactive\/runs\/[^/]+\/(merge|discard|revert|approve)$/, route => {
    const [, id, action] = new URL(route.request().url()).pathname.match(/runs\/([^/]+)\/(\w+)$/);
    requests.actions.push(`${id}/${action}`);
    if (failNext[action]) { const error = failNext[action]; delete failNext[action]; return route.fulfill({ status: 409, json: { error } }); }
    const run = runs.find(item => item.id === id);
    run.status = { merge: 'merged', discard: 'discarded', revert: 'reverted', approve: 'approved' }[action];
    return route.fulfill({ json: run });
  });
  // The counts belong with the plans; the real ones are all zero because the runs here are scripted.
  await page.route(/\/api\/todos$/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const counts = Object.fromEntries(runs.map(run => [run.matterId, 1]));
    return route.fulfill({ response, json: (await response.json()).map(todo => ({ ...todo, proactiveRunCount: counts[todo.id] ?? 0 })) });
  });
}
