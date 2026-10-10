#!/usr/bin/env node
// Fake Codex app-server for tests. Speaks newline-delimited JSON-RPC on stdio, the way
// `codex app-server` does. Prompt text drives behaviour: "tool" runs a command, "edit" changes a
// file, "approve" asks for a command approval, "deny" offers a plain decline, "slow" waits until
// interrupted, "crash" exits. Settings ride with turn/start the way the adapter sends them.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const threadId = process.env.FAKE_CODEX_THREAD ?? 'codex-thread-1';
let nextTurnSeq = 1;
let nextServerRequestId = 1000;
let activeTurn = null; // { id }
// Settings as the adapter sets them: thread/start takes kebab-case sandbox, turn/start camelCase.
let currentModel = 'gpt-big';
let currentEffort = 'high';
let currentSandbox = 'read-only';
let currentApproval = 'on-request';

const sandboxName = () => ({ readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' })[currentSandbox] ?? currentSandbox;

const notify = (method, params) => out({ jsonrpc: '2.0', method, params: { threadId, ...params } });

const MODELS = [
  {
    id: 'gpt-big',
    model: 'gpt-big',
    displayName: 'GPT Big',
    description: 'For hard work',
    isDefault: true,
    inputModalities: ['text', 'image'],
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }],
  },
  {
    id: 'gpt-small',
    model: 'gpt-small',
    displayName: 'GPT Small',
    description: '',
    inputModalities: ['text'],
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
  },
  { id: 'gpt-hidden', model: 'gpt-hidden', displayName: 'Hidden', hidden: true, inputModalities: ['text'], supportedReasoningEfforts: [] },
];

// Every conversation the fake has on record, two per page so the adapter's paging is exercised.
const THREADS = [
  { id: 'codex-thread-1', cwd: '/tmp/one', name: 'Named chat', preview: '', updatedAt: 1791648439 },
  { id: 'codex-thread-2', cwd: '/tmp/two', name: null, preview: 'How do I…', updatedAt: 1791648000 },
  { id: 'codex-thread-3', cwd: '/tmp/three', name: 'Third', preview: '', updatedAt: 1791647000 },
];

/** A past conversation, as thread/turns/list reports it. */
const historyTurns = () => [
  {
    id: 'turn-1',
    status: 'completed',
    items: [
      { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'first question' }] },
      { type: 'reasoning', id: 'r1', content: [{ type: 'text', text: 'let me look' }], summary: [] },
      { type: 'commandExecution', id: 'exec-1', command: 'ls', cwd: '/tmp/one', status: 'completed', exitCode: 0, aggregatedOutput: 'a.txt' },
      { type: 'fileChange', id: 'fc-1', status: 'completed', changes: [{ path: '/tmp/one/notes.md', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] },
      { type: 'agentMessage', id: 'm1', text: 'first answer', phase: 'final_answer' },
    ],
  },
  {
    id: 'turn-2',
    status: 'completed',
    items: [
      { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'second question' }] },
      { type: 'plan', id: 'p1', text: '- [x] Read\n- [ ] Write\n' },
      { type: 'agentMessage', id: 'm2', text: 'second answer', phase: 'final_answer' },
    ],
  },
];

const applyTurnOverrides = (p) => {
  if (typeof p.model === 'string') currentModel = p.model;
  if (typeof p.effort === 'string') currentEffort = p.effort;
  if (typeof p.approvalPolicy === 'string') currentApproval = p.approvalPolicy;
  if (p.sandboxPolicy?.type) currentSandbox = p.sandboxPolicy.type;
};

const say = (text) => {
  const itemId = `msg-${nextTurnSeq}`;
  notify('item/started', { item: { type: 'agentMessage', id: itemId, text: '', phase: 'final_answer' } });
  for (const part of text.match(/.{1,4}/g) ?? []) notify('item/agentMessage/delta', { itemId, delta: part });
  notify('item/completed', { item: { type: 'agentMessage', id: itemId, text, phase: 'final_answer' } });
};

/** The scripted part of one turn. `done` finishes it. */
const runTurn = (text, turnId, done) => {
  const userItem = { type: 'userMessage', id: `user-${nextTurnSeq}`, content: [{ type: 'text', text }] };
  notify('item/started', { item: userItem, turnId });
  notify('item/completed', { item: userItem, turnId });

  if (text.includes('crash')) {
    setTimeout(() => process.exit(1), 20);
    return;
  }
  if (text.includes('tool')) {
    const id = 'exec-1';
    notify('item/started', { turnId, item: { type: 'commandExecution', id, command: 'npm test', cwd: '/tmp/one', status: 'inProgress' } });
    notify('item/commandExecution/outputDelta', { turnId, itemId: id, delta: 'par' });
    notify('item/commandExecution/outputDelta', { turnId, itemId: id, delta: 'tial' });
    notify('item/completed', { turnId, item: { type: 'commandExecution', id, command: 'npm test', cwd: '/tmp/one', status: 'completed', exitCode: 0, aggregatedOutput: 'partial out', durationMs: 12 } });
  }
  if (text.includes('fail')) {
    const id = 'exec-9';
    notify('item/started', { turnId, item: { type: 'commandExecution', id, command: 'false', cwd: '/tmp/one', status: 'inProgress' } });
    notify('item/completed', { turnId, item: { type: 'commandExecution', id, command: 'false', cwd: '/tmp/one', status: 'completed', exitCode: 1, aggregatedOutput: 'boom', durationMs: 3 } });
  }
  if (text.includes('edit')) {
    const id = 'fc-1';
    const changes = [{ path: '/tmp/one/src/app.ts', kind: { type: 'update' }, diff: '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n' }];
    notify('item/started', { turnId, item: { type: 'fileChange', id, status: 'inProgress', changes: [changes[0]] } });
    changes.push({ path: '/tmp/one/src/new.ts', kind: { type: 'add' }, diff: '+export const x = 1;\n' });
    notify('item/fileChange/patchUpdated', { turnId, itemId: id, changes });
    notify('item/completed', { turnId, item: { type: 'fileChange', id, status: 'completed', changes } });
  }
  if (text.includes('reason')) {
    const id = 'reason-1';
    notify('item/started', { turnId, item: { type: 'reasoning', id, content: [], summary: [] } });
    notify('item/reasoning/summaryTextDelta', { turnId, itemId: id, summaryIndex: 0, delta: 'thinking ' });
    notify('item/reasoning/summaryTextDelta', { turnId, itemId: id, summaryIndex: 0, delta: 'hard' });
  }
  if (text.includes('plan')) {
    notify('turn/plan/updated', { turnId, plan: [{ step: 'Read the code', status: 'completed' }, { step: 'Write the fix', status: 'inProgress' }] });
  }
  if (text.includes('usage')) {
    notify('thread/tokenUsage/updated', { turnId, tokenUsage: { total: { totalTokens: 9000, inputTokens: 8000, outputTokens: 1000 }, last: { totalTokens: 9000 }, modelContextWindow: 100000 } });
  }
  if (text.includes('model?')) {
    say(`model:${currentModel};effort:${currentEffort};sandbox:${sandboxName()};approval:${currentApproval}`);
    return done();
  }
  if ((text.includes('approve') || text.includes('deny')) && currentApproval !== 'never') {
    const id = 'exec-2';
    const command = 'rm -rf /tmp/one/build';
    notify('item/started', { turnId, item: { type: 'commandExecution', id, command, cwd: '/tmp/one', status: 'inProgress' } });
    const requestId = nextServerRequestId++;
    const available = text.includes('deny')
      ? ['accept', 'acceptForSession', 'decline', 'cancel']
      : ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm'] } }, 'cancel'];
    out({
      jsonrpc: '2.0',
      id: requestId,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId,
        turnId,
        itemId: id,
        kind: 'command',
        command,
        cwd: '/tmp/one',
        proposedExecpolicyAmendment: ['rm'],
        availableDecisions: available,
      },
    });
    // The decision comes back as a response; until then the turn waits.
    awaitingApproval.set(requestId, { itemId: id, command, turnId, done });
    return;
  }
  if (text.includes('slow')) return; // only turn/interrupt ends this
  say(`echo:${text}`);
  notify('thread/tokenUsage/updated', { turnId, tokenUsage: { total: { totalTokens: 500 }, modelContextWindow: 100000 } });
  done();
};

const awaitingApproval = new Map(); // request id -> the turn waiting for its decision

const finishTurn = (turnId, status, error = null) =>
  notify('turn/completed', { turn: { id: turnId, items: [], itemsView: 'notLoaded', status, error, startedAt: 1, completedAt: 2, durationMs: 1 } });

rl.on('line', (line) => {
  const msg = JSON.parse(line);

  // A decision for an approval we asked about.
  if (msg.id !== undefined && msg.method === undefined) {
    const pending = awaitingApproval.get(msg.id);
    if (!pending) return;
    awaitingApproval.delete(msg.id);
    const decision = msg.result?.decision;
    const option = typeof decision === 'string' ? decision : Object.keys(decision ?? {})[0];
    notify('serverRequest/resolved', { requestId: msg.id });
    if (option === 'accept' || option === 'acceptWithExecpolicyAmendment' || option === 'acceptForSession') {
      notify('item/completed', {
        turnId: pending.turnId,
        item: { type: 'commandExecution', id: pending.itemId, command: pending.command, cwd: '/tmp/one', status: 'completed', exitCode: 0, aggregatedOutput: 'gone', durationMs: 5 },
      });
      say(`approved:${option}`);
      pending.done();
    } else if (option === 'decline') {
      notify('item/completed', {
        turnId: pending.turnId,
        item: { type: 'commandExecution', id: pending.itemId, command: pending.command, cwd: '/tmp/one', status: 'failed', exitCode: 1, aggregatedOutput: 'declined', durationMs: 5 },
      });
      say('denied');
      pending.done();
    } else {
      // cancel (or no answer): the turn is interrupted.
      activeTurn = null;
      finishTurn(pending.turnId, 'interrupted', { message: 'interrupted' });
    }
    return;
  }

  switch (msg.method) {
    case 'initialize':
      return out({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake-codex/0.160', codexHome: '/tmp/codex' } });
    case 'model/list':
      return out({ jsonrpc: '2.0', id: msg.id, result: { data: MODELS, nextCursor: null } });
    case 'thread/start':
      if (typeof msg.params?.sandbox === 'string') currentSandbox = msg.params.sandbox.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace('Fullaccess', 'FullAccess');
      if (typeof msg.params?.approvalPolicy === 'string') currentApproval = msg.params.approvalPolicy;
      if (typeof msg.params?.model === 'string') currentModel = msg.params.model;
      return out({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: threadId, cwd: '/tmp/one' }, model: currentModel, reasoningEffort: currentEffort, sandbox: { type: 'readOnly' }, approvalPolicy: currentApproval } });
    case 'thread/resume':
      if (typeof msg.params?.sandbox === 'string') currentSandbox = msg.params.sandbox.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (typeof msg.params?.approvalPolicy === 'string') currentApproval = msg.params.approvalPolicy;
      return out({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params?.threadId ?? threadId, cwd: '/tmp/one' }, model: currentModel, reasoningEffort: currentEffort, sandbox: { type: 'readOnly' }, approvalPolicy: currentApproval } });
    case 'turn/start': {
      applyTurnOverrides(msg.params ?? {});
      const turnId = `turn-${nextTurnSeq++}`;
      const text = (msg.params?.input ?? []).filter((i) => i.type === 'text').map((i) => i.text).join('');
      const images = (msg.params?.input ?? []).filter((i) => i.type === 'localImage');
      out({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } } });
      activeTurn = turnId;
      notify('turn/started', { turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } });
      if (images.length) say(`images:${images.map((i) => i.path).join(',')}`);
      setTimeout(() => runTurn(text, turnId, () => { activeTurn = null; finishTurn(turnId, 'completed'); }), 15);
      return;
    }
    case 'turn/interrupt':
      if (activeTurn) {
        const turnId = activeTurn;
        activeTurn = null;
        finishTurn(turnId, 'interrupted', { message: 'interrupted' });
      }
      return out({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'thread/compact/start':
      return out({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'thread/list': {
      const start = msg.params?.cursor ? Number(msg.params.cursor) : 0;
      const page = THREADS.slice(start, start + 2);
      const next = start + 2 < THREADS.length ? String(start + 2) : null;
      return out({ jsonrpc: '2.0', id: msg.id, result: { data: page, nextCursor: next } });
    }
    case 'thread/turns/list':
      if (String(msg.params?.threadId).startsWith('hist-')) return out({ jsonrpc: '2.0', id: msg.id, result: { data: historyTurns(), nextCursor: null } });
      return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown thread' } });
    case 'thread/fork':
      return out({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: `${msg.params?.threadId}-fork`, cwd: '/tmp/one' }, model: currentModel } });
    case 'thread/delete':
      if (process.env.FAKE_CODEX_DELETE_LOG) appendFileSync(process.env.FAKE_CODEX_DELETE_LOG, msg.params?.threadId + '\n');
      return out({ jsonrpc: '2.0', id: msg.id, result: {} });
    default:
      if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });
  }
});
