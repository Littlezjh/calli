import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredEvent } from '../src/events.js';
import { handoverPrompt, synthesizeHandover } from '../src/handover.js';

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
