import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredEvent } from '../src/events.js';
import { handoverBrief, handoverContext, handoverPrompt, synthesizeBrief, synthesizeHandover } from '../src/handover.js';

let seq = 0;
const ev = (turnId: string | null, type: StoredEvent['type'], data: Record<string, unknown> = {}): StoredEvent => ({
  threadId: 't',
  seq: ++seq,
  turnId,
  type,
  ts: new Date().toISOString(),
  data,
});

test('the handover prompt tells the agent what its successor can and cannot see', () => {
  const prompt = handoverPrompt('Claude Code 2');
  assert.match(prompt, /Claude Code 2/);
  assert.match(prompt, /看不到这段对话/);
  assert.match(prompt, /## 任务/);
  // What was checked, what was not, and what is half-done: the successor cannot tell from the diff.
  assert.match(prompt, /## 验证情况 — .*还没验证.*改到一半/);
});

test('the successor is told to check the working tree and run the checks before going on', () => {
  const text = handoverContext({
    threadId: 't', agentId: 'claude', agentLabel: 'Claude Code', adapter: 'claude',
    cwd: '/work', cwdReal: '/work', sessionId: null, resumeCommand: null,
  });
  const requirements = text.split('## 接手要求')[1];
  assert.match(requirements, /git status/);
  assert.match(requirements, /最近的提交/);
  assert.match(requirements, /init\.sh/);
  assert.match(requirements, /发现坏的先修好，再接着做/);
});

test('a synthesized summary assembles what the log knows and says what it does not', () => {
  const events = [
    ev('u1', 'turn.started', { text: '把登录页改成深色' }),
    ev('u1', 'tool.start', { id: 'a', title: 'edit', content: [{ type: 'diff', path: 'src/login.ts' }] }),
    ev('u1', 'tool.end', { id: 'a', content: [{ type: 'diff', path: 'src/login.ts' }] }),
    ev('u1', 'tool.start', { id: 'b', title: 'edit', content: [{ type: 'diff', path: 'src/theme.ts' }, { type: 'diff', path: 'src/login.ts' }] }),
    ev('u1', 'message.delta', { text: '改好了两个文件' }),
    ev('u1', 'turn.done', {}),
    ev('u2', 'turn.started', { text: '测试也补一下' }),
    ev('u2', 'plan.updated', { entries: [{ content: '改登录页', status: 'completed' }, { content: '补测试', status: 'pending' }] }),
    ev('u2', 'message.delta', { text: '还差测试' }),
    ev('u2', 'turn.error', { code: 'rate_limited', error: 'quota exceeded' }),
  ];
  const text = synthesizeHandover(events, { title: '深色登录页', from: 'Claude Code', target: 'pi' });
  assert.match(text, /深色登录页/);
  assert.match(text, /Claude Code/);
  assert.match(text, /pi/);
  assert.match(text, /1\. 把登录页改成深色/);
  assert.match(text, /2\. 测试也补一下/);
  assert.match(text, /- src\/login\.ts\n- src\/theme\.ts/, 'files appear once each, in order');
  assert.match(text, /\[x\] 改登录页/);
  assert.match(text, /\[ \] 补测试/);
  assert.match(text, /还差测试/);
  assert.match(text, /rate_limited：quota exceeded/);
  assert.match(text, /可能不全/);
});

test('a handover or imported turn is not listed as one of the user\'s asks', () => {
  const events = [
    ev('u1', 'turn.started', { text: '做点事' }),
    ev('u1', 'message.delta', { text: '做完了' }),
    ev('u1', 'turn.done', {}),
    ev('h1', 'turn.started', { text: '请写一份交接摘要', handover: 'claude-2' }),
    ev('h1', 'message.delta', { text: '## 任务' }),
    ev('h1', 'turn.done', {}),
  ];
  const text = synthesizeHandover(events, { title: 't', from: 'pi', target: 'Claude Code 2' });
  assert.match(text, /1\. 做点事/);
  assert.doesNotMatch(text, /请写一份交接摘要/);
  assert.match(text, /做完了/);
  assert.doesNotMatch(text, /## 任务/, 'the handover turn\u2019s own text is not the thread\u2019s last answer');
});

test('the brief handover points at the source and keeps progress to a few lines', () => {
  const head = handoverBrief({ threadId: 'src', from: 'Claude Code 3', cwd: '/work', worktree: { root: '/work', branch: 'feat' }, lead: true });
  assert.match(head, /calli history src/);
  assert.match(head, /分支 feat/);
  assert.match(head, /主控/);
  assert.doesNotMatch(handoverBrief({ threadId: 'src', from: 'pi', cwd: '/work' }), /主控/);
  const files = Array.from({ length: 12 }, (_, i) => ({ type: 'diff', path: `f${i}.ts` }));
  const text = synthesizeBrief([
    ev('u1', 'turn.started', { text: 'with hub additions', displayText: '先做第一步' }),
    ev('u1', 'tool.start', { id: 'a', content: files }),
    ev('u1', 'message.delta', { text: '做完了\n第一步' }),
    ev('u1', 'turn.done', {}),
    ev('u2', 'turn.started', { text: '再重跑一次' }),
    ev('u2', 'turn.error', { code: 'plan_exhausted', error: 'limit' }),
  ]);
  assert.match(text, /最近的要求：先做第一步/, 'the failed ask is carried over separately, and hub additions are left out');
  assert.doesNotMatch(text, /再重跑一次/);
  assert.match(text, /f7\.ts 等 12 个/);
  assert.match(text, /中断原因：plan_exhausted：limit/);
  assert.equal(synthesizeBrief([]), '');
});
