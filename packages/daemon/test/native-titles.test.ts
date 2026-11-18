import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { AttachmentStore } from '../src/attachments.js';
import { Workdirs } from '../src/workdirs.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import { CodexAppServerAdapter } from '../src/adapters/codex.js';
import { writeClaudeTitle } from '../src/adapters/claude-history.js';
import type { AgentAdapter } from '../src/adapters/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const wait = async (check: () => boolean, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); }
};
const records = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const titles = (path: string) => records(path).filter(r => r.type === 'custom-title').map(r => r.customTitle);

test('writeClaudeTitle appends a custom-title record and the sidecar, as /rename does, once per title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-claude-title-'));
  try {
    const path = join(dir, 'abc.jsonl');
    // A torn last line is closed before the record.
    writeFileSync(path, '{"type":"user","sessionId":"abc"}');
    await writeClaudeTitle(path, 'abc', '  修复\n登录超时 ');
    assert.deepEqual(titles(path), ['修复 登录超时']);
    assert.deepEqual(records(path).at(-1), { type: 'custom-title', customTitle: '修复 登录超时', sessionId: 'abc' });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'abc', 'custom-title.json'), 'utf8')), { customTitle: '修复 登录超时' });

    await writeClaudeTitle(path, 'abc', '修复 登录超时');
    assert.deepEqual(titles(path), ['修复 登录超时'], 'the same title is not appended again');
    appendFileSync(path, '{"type":"assistant","sessionId":"abc"}\n');
    await writeClaudeTitle(path, 'abc', '新名字');
    assert.deepEqual(titles(path), ['修复 登录超时', '新名字']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'abc', 'custom-title.json'), 'utf8')), { customTitle: '新名字' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex names a thread that is not loaded through a short-lived app-server', async () => {
  const home = mkdtempSync(join(tmpdir(), 'calli-codex-title-'));
  try {
    const codex = new CodexAppServerAdapter([process.execPath, join(here, 'fixtures', 'fake-codex.mjs')], { CODEX_HOME: home });
    await codex.renameSessions([{ agentSessionId: 'cold-thread', cwd: home, title: ' 支付重构 ' }, { agentSessionId: 'blank', cwd: home, title: '  ' }]);
    const index = records(join(home, 'session_index.jsonl'));
    assert.deepEqual(index.map(r => [r.id, r.thread_name]), [['cold-thread', '支付重构']]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a thread renamed while its Claude session is not running is named in the transcript; old names are backfilled once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-native-titles-'));
  const cwd = join(dir, 'project'); mkdirSync(cwd);
  const config = join(dir, 'claude');
  const transcript = (id: string) => {
    const path = join(config, 'projects', 'p', `${id}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{"type":"user","sessionId":"${id}"}\n`);
    return path;
  };
  const adapters = new Map<string, AgentAdapter>([['claude', new ClaudeAcpAdapter([process.execPath, join(here, 'fixtures', 'fake-acp.mjs')], { CLAUDE_CONFIG_DIR: config })]]);
  const store = new Store(dir);
  const workdirs = () => new Workdirs([cwd], join(dir, 'dirs.json'), join(dir, 'scratch'));
  let manager = new ThreadManager(store, adapters, workdirs(), new AttachmentStore(dir));
  try {
    const renamed = await manager.createThread({ agent: 'claude', cwd });
    store.updateThread(renamed.id, { agentSessionId: 'sess-renamed' });
    const renamedPath = transcript('sess-renamed');
    await manager.updateThread(renamed.id, { title: '支付重构' });
    await wait(() => titles(renamedPath).length > 0);
    assert.deepEqual(titles(renamedPath), ['支付重构']);

    const auto = await manager.createThread({ agent: 'claude', cwd });
    store.updateThread(auto.id, { agentSessionId: 'sess-auto' });
    const autoPath = transcript('sess-auto');
    manager.autoRename(auto.id, '自动取的名');
    await wait(() => titles(autoPath).length > 0);

    // Names from before the write-back: user and extension titles go back, first-message ones do not.
    const old = await manager.createThread({ agent: 'claude', cwd, title: '早先改的名' });
    store.updateThread(old.id, { agentSessionId: 'sess-old' });
    store.setTitleBy(old.id, 'user');
    const oldPath = transcript('sess-old');
    const first = await manager.createThread({ agent: 'claude', cwd, title: '第一句话' });
    store.updateThread(first.id, { agentSessionId: 'sess-first' });
    store.setTitleBy(first.id, 'default');
    const firstPath = transcript('sess-first');
    await manager.shutdown();
    store.saveHubSetting('native_titles_v1', false);
    manager = new ThreadManager(store, adapters, workdirs(), new AttachmentStore(dir));
    await wait(() => store.hubSetting('native_titles_v1', false));
    assert.deepEqual(titles(oldPath), ['早先改的名']);
    assert.deepEqual(titles(firstPath), []);
    assert.deepEqual(titles(renamedPath), ['支付重构'], 'a title already at the tail is not appended again');
    assert.ok(existsSync(join(config, 'projects', 'p', 'sess-old', 'custom-title.json')));
  } finally {
    await manager.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
