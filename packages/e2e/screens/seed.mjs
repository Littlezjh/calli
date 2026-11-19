// A hub filled with made-up data that looks like real use, so a change that only shows with
// data (long titles, tool steps, tables, errors, several sections) can be seen and measured.
// Shared by screens.mjs (screenshots) and test/ui-rules.spec.mjs (layout rules).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, api } from '../harness.mjs';

const ASK_1 = '帮我把 README 的安装步骤过一遍，确认新机器能一次跑通';
const ASK_2 = '对比一下三种缓存方案，列个表';
const ASK_3 = '很好，跑一遍测试收尾';

/** The first fake pi session plays this script turn by turn: tools, a table, code and prose. */
const SCRIPT = {
  'pi-session-1': [
    { role: 'user', content: ASK_1 },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '先装依赖，再按 README 的步骤逐条验证，遇到缺的前提要记下来。' },
      { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm install' } },
    ] },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'added 312 packages in 18s' }], isError: false },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'README.md' } }] },
    { role: 'toolResult', toolCallId: 'c2', toolName: 'read', content: [{ type: 'text', text: '# Demo\n\n安装与环境说明……' }], isError: false },
    { role: 'assistant', content: [{ type: 'text', text: '依赖装好了，README 的三步也验证过：\n\n1. `npm install` 成功，无额外系统依赖\n2. `.env` 模板字段齐全\n3. `npm run build` 通过\n\n新机器按文档操作可以一次跑通。' }] },
    { role: 'user', content: ASK_2 },
    { role: 'assistant', content: [{ type: 'text', text: '三种方案的取舍如下：\n\n| 方案 | 命中率 | 实现成本 | 失效方式 |\n|---|---|---|---|\n| 进程内 LRU | 中 | 低 | 重启丢失 |\n| Redis | 高 | 中 | TTL 与主动删除 |\n| HTTP 缓存头 | 视客户端而定 | 低 | ETag 协商 |\n\n建议先上进程内 LRU，量起来再换 Redis：\n\n```ts\nconst cache = new LRUCache<string, Result>({ max: 500, ttl: 60_000 });\n```\n\n这样改动最小，回滚也只是一行配置。' }] },
    { role: 'user', content: ASK_3 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c3', name: 'bash', arguments: { command: 'npm test' } }] },
    { role: 'toolResult', toolCallId: 'c3', toolName: 'bash', content: [{ type: 'text', text: '174 passed, 0 failed in 3.2s' }], isError: false },
    { role: 'assistant', content: [{ type: 'text', text: '174 个测试全部通过，这轮收尾。' }] },
  ],
};

/** Titles that stress the list: long Chinese, mixed English, short. */
const MORE_TITLES = [
  '把支付回调的重试改成指数退避，并补上幂等键的校验和告警',
  'Fix flaky e2e on WebKit',
  '周报',
  '整理 onboarding 文档里过期的截图和命令',
];

async function idle(daemon, id) {
  for (let i = 0; i < 200; i++) {
    const thread = await (await api(daemon, `/api/threads/${id}`)).json();
    if (thread.status !== 'running') return thread;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`turn on ${id} never finished`);
}

async function thread(daemon, title) {
  const res = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title }) });
  if (!res.ok) throw new Error(`creating ${title}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function say(daemon, id, text) {
  await api(daemon, `/api/threads/${id}/turns`, { method: 'POST', body: JSON.stringify({ text }) });
  await idle(daemon, id);
}

/**
 * Starts a hub and fills it. Returns the daemon, the seeded threads by role, and stop().
 * `env` reaches the daemon as in startDaemon.
 */
export async function seedHub(env = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'calli-screens-'));
  const messagesFile = join(scratch, 'messages.json');
  writeFileSync(messagesFile, JSON.stringify(SCRIPT));
  const daemon = await startDaemon({ FAKE_PI_MESSAGES_FILE: messagesFile, FAKE_PI_FIRST_OUTPUT_DELAY_MS: '50', ...env });
  try {
    // The scripted thread first: a fresh fake pi names its session pi-session-1.
    const rich = await thread(daemon, '核对 README 安装步骤与缓存方案');
    for (const ask of [ASK_1, ASK_2, ASK_3]) await say(daemon, rich.id, ask);
    const failed = await thread(daemon, '调用模型服务失败的线程');
    await say(daemon, failed.id, 'wait-first-fail');
    const others = [];
    for (const title of MORE_TITLES) {
      const made = await thread(daemon, title);
      await say(daemon, made.id, `${title}，先看一下现状`);
      others.push(made);
    }
    await api(daemon, '/api/sections', { method: 'POST', body: JSON.stringify({ name: '文档与发布' }) });
    return {
      daemon,
      threads: { rich, failed, others },
      async stop() {
        await daemon.stop();
        rmSync(scratch, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await daemon.stop();
    rmSync(scratch, { recursive: true, force: true });
    throw err;
  }
}
