// Fake ACP agent for tests. Speaks newline-delimited JSON-RPC on stdio.
if (process.argv.includes('--version')) { process.stdout.write('fixture 1.2.3\n'); process.exit(0); }
// Prompt text drives behaviour: "approve" asks permission, "slow" waits until cancelled.
// FAKE_ACP_FLAVOR=traex shapes the answers the way TRAE CLI does: no modes in session/new,
// the effort option is named reasoning_effort, and "delete" on the command line (its CLI,
// which the adapter runs for deletion) logs to FAKE_ACP_DELETE_LOG and exits.
import { claudeUsage } from './live-usage.mjs';
import { coordinationFixture } from './coordination.mjs';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { recordSession } from './fake-session-store.mjs';

// TRAE exposes both ACP metadata and a Codex-compatible app-server on one CLI.
if (process.argv.includes('app-server')) {
  await import('./fake-codex.mjs');
} else {

if (process.argv[2] === 'models') {
  if (process.env.FAKE_TRAEX_MODELS_FAIL === '1') process.exit(1);
  const rows = process.env.FAKE_TRAEX_MODELS_FILE ? JSON.parse(readFileSync(process.env.FAKE_TRAEX_MODELS_FILE, 'utf8')) : [
    { name: 'Big 1.0', config_name: 'big', _meta: { trae: { load: { percent: 184 }, weeklyQuota: { applies: true, usedPercent: 1, resetTime: 1792339199 } } } },
    { name: 'Small 1.0', config_name: 'small', _meta: { trae: { load: { percent: 0 } } } },
  ];
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}

if (process.argv[2] === 'delete') {
  // CLI mode, not an ACP server: the traex adapter deletes sessions this way.
  if (process.env.FAKE_ACP_DELETE_LOG) appendFileSync(process.env.FAKE_ACP_DELETE_LOG, process.argv[4] + '\n');
  process.exit(0);
}

const traex = process.env.FAKE_ACP_FLAVOR === 'traex';
// The ids the agent's messages carry in the canned history below; a fork can stop at any of them.
const HIST_MESSAGE_IDS = ['m1a', 'm1b', 'm2'];

const rl = createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sessionId = process.env.FAKE_ACP_SESSION ?? 'acp-session-1';
let pendingPrompt = null; // { id, cancelled }
let nextAgentRequestId = 1000;
const awaitingInput = new Map();
let currentMode = 'default';
let currentModel = 'default';
let currentEffort = 'default';
let currentSpeed = 'off';
// No "auto" mode on purpose: the adapter must fall back to acceptEdits for auto_edit.
const knownModes = traex
  // The modes TRAE CLI answers to, without the agent announcing them in session/new.
  ? ['default', 'plan', 'auto', 'bypass_permissions']
  : ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const sessionInfo = () => ({
  // TRAE CLI does not report its modes; the adapter must still set one it accepts.
  ...(traex ? {} : { modes: { currentModeId: currentMode, availableModes: knownModes.map((id) => ({ id, name: id })) } }),
  configOptions: [
    ...(process.env.FAKE_ACP_SPEED && currentModel !== 'small' ? [{ id: 'fast', category: 'model_config', type: 'select', currentValue: currentSpeed, options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] }] : []),
    {
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: [
        { value: 'default', name: 'Default', description: 'Big 1.0' },
        { value: 'big', name: 'Big 1.0', description: 'For hard work' },
        { value: 'small', name: 'Small 1.0', description: '' },
        { value: 'broken', name: 'Broken 1.0', description: 'Not on this account' },
      ],
    },
    // Like the real agent: the small model has no effort option at all, and big lacks "max".
    // TRAE CLI names the option reasoning_effort and offers its own levels.
    ...(currentModel === 'small'
      ? []
      : [
          {
            id: traex ? 'reasoning_effort' : 'effort',
            category: 'thought_level',
            type: 'select',
            currentValue: currentEffort,
            options: (traex ? ['low', 'medium', 'high', 'xhigh'] : ['default', 'low', 'high', ...(currentModel === 'big' ? [] : ['max'])]).map((v) => ({
              value: v,
              name: v,
            })),
          },
        ]),
  ],
});
const awaitingPermission = new Map(); // request id -> prompt id

const update = (u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });

rl.on('line', (line) => {
  const msg = JSON.parse(line);

  // Responses to our permission request.
  if (msg.id !== undefined && msg.method === undefined) {
    const input = awaitingInput.get(msg.id);
    if (input) {
      awaitingInput.delete(msg.id);
      if (input.kind === 'plan' && msg.result?.outcome?.outcome === 'selected') {
        const modes = { 'exit-plan-default': 'default', 'exit-plan-auto': 'auto', 'exit-plan-accept-edits': 'acceptEdits', 'exit-plan-bypass': 'bypassPermissions' };
        currentMode = modes[msg.result.outcome.optionId];
        update({ sessionUpdate: 'current_mode_update', currentModeId: currentMode });
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer:${JSON.stringify(msg.result)};mode:${currentMode}` } });
      out({ jsonrpc: '2.0', id: input.prompt, result: { stopReason: 'end_turn' } });
      pendingPrompt = null; return;
    }
    const promptId = awaitingPermission.get(msg.id);
    if (promptId === undefined) return;
    awaitingPermission.delete(msg.id);
    const outcome = msg.result?.outcome;
    const text = outcome?.outcome === 'selected' ? `approved:${outcome.optionId}` : 'denied';
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    out({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    pendingPrompt = null;
    return;
  }

  switch (msg.method) {
    case 'initialize':
      return out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    case 'session/new':
      out({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'compact', description: 'Summarise the conversation', input: { hint: '<instructions>' } },
              { name: 'review', description: 'Review a change', input: null },
              ...(process.env.FAKE_ACP_PROJECT_COMMAND && process.cwd().includes(process.env.FAKE_ACP_PROJECT_COMMAND)
                ? [{ name: 'project-only', description: 'Only in this project' }]
                : []),
            ],
          },
        },
      });
      return out({ jsonrpc: '2.0', id: msg.id, result: { sessionId, ...sessionInfo() } });
    case 'session/list': {
      // Tests describe the agent's existing sessions in a JSON file. Two per page, to exercise paging.
      const file = process.env.FAKE_ACP_SESSIONS_FILE;
      const all = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
      const start = msg.params?.cursor ? Number(msg.params.cursor) : 0;
      const page = all.slice(start, start + 2);
      const next = start + 2 < all.length ? String(start + 2) : undefined;
      return out({ jsonrpc: '2.0', id: msg.id, result: { sessions: page, ...(next ? { nextCursor: next } : {}) } });
    }
    case 'session/fork':
      if (msg.params.sessionId === 'unforkable') {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'cannot fork this one' } });
      }
      {
        // The real agent reads where to stop from this extension field: the id of the last message to keep.
        const at = msg.params._meta?.jetbrains?.air?.fork;
        if (at && (at.version !== 1 || !HIST_MESSAGE_IDS.includes(at.messageId))) {
          return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Fork point message ${at.messageId} was not found` } });
        }
        // Asked for from a worktree, the copy is one that runs there; its id says so.
        const cwd = String(msg.params.cwd ?? '');
        const into = basename(dirname(cwd)) === '.worktrees' ? `-in-${basename(cwd)}` : '';
        return out({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `${msg.params.sessionId}-fork${at ? `-at-${at.messageId}` : ''}${into}` } });
      }
    case 'session/load': {
      const replay = (u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: u } });
      if (String(msg.params.sessionId).startsWith('hist-')) {
        // A two-turn conversation, replayed the way the real agent does: all of it before the response.
        replay({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'first ' } });
        replay({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'question' } });
        replay({ sessionUpdate: 'agent_thought_chunk', messageId: 'm1a', content: { type: 'text', text: 'let me look' } });
        replay({ sessionUpdate: 'tool_call', toolCallId: 'h1', title: 'Edit notes.md', kind: 'edit', status: 'pending' });
        replay({ sessionUpdate: 'tool_call_update', toolCallId: 'h1', status: 'completed', rawOutput: 'ok', content: [{ type: 'diff', path: 'notes.md', oldText: 'a', newText: 'b' }] });
        replay({ sessionUpdate: 'agent_message_chunk', messageId: 'm1b', content: { type: 'text', text: 'first answer' } });
        replay({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'second question' } });
        replay({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } });
        replay({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'second answer' } });
      } else {
        replay({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed (should be dropped)' } });
      }
      return out({ jsonrpc: '2.0', id: msg.id, result: sessionInfo() });
    }
    case 'session/set_config_option':
      if (msg.params.configId === 'model' && msg.params.value === 'broken') {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
      }
      if (msg.params.configId === 'model') currentModel = msg.params.value;
      else if (msg.params.configId === 'fast' && process.env.FAKE_ACP_SPEED && currentModel !== 'small') currentSpeed = msg.params.value;
      else if (msg.params.configId === (traex ? 'reasoning_effort' : 'effort')) currentEffort = msg.params.value;
      else return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown config option' } });
      return out({ jsonrpc: '2.0', id: msg.id, result: { configOptions: sessionInfo().configOptions } });
    case 'session/delete':
      if (msg.params.sessionId === 'undeletable') {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'session is locked' } });
      }
      // Tests read this file to see which sessions the daemon asked to delete.
      if (process.env.FAKE_ACP_DELETE_LOG) appendFileSync(process.env.FAKE_ACP_DELETE_LOG, msg.params.sessionId + '\n');
      return out({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'session/set_mode':
      if (!knownModes.includes(msg.params.modeId)) {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown mode' } });
      }
      currentMode = msg.params.modeId;
      update({ sessionUpdate: 'current_mode_update', currentModeId: currentMode });
      return out({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'session/set_model':
      currentModel = msg.params.modelId;
      return out({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'session/cancel':
      if (pendingPrompt) {
        out({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'cancelled' } });
        pendingPrompt = null;
      }
      return;
    case '_session/goal': {
      if (msg.params.action !== 'clear') throw new Error('unsupported goal control');
      if (pendingPrompt) {
        out({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'end_turn' } });
        pendingPrompt = null;
      }
      out({ jsonrpc: '2.0', id: msg.id, result: {} }); return;
    }
    case 'session/prompt': {
      recordSession(traex ? 'traex' : 'claude', msg.params.sessionId);
      const blocks = msg.params.prompt;
      const text = blocks.filter((p) => p.type === 'text').map((p) => p.text).join('');
      if (text === 'speed?') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `speed:${currentSpeed}` } });
        if (process.env.FAKE_ACP_SPEED_REVOKED) { currentSpeed = 'off'; update({ sessionUpdate: 'config_option_update', configOptions: sessionInfo().configOptions }); }
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return;
      }
      if (text === 'plan-draft') { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `mode:${currentMode};model:${currentModel};effort:${currentEffort}` } }); out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return; }
      if (text === 'plan-question' || text === 'plan-approval') {
        pendingPrompt = msg;
        const id = nextAgentRequestId++;
        awaitingInput.set(id, { prompt: msg.id, kind: text === 'plan-approval' ? 'plan' : 'question' });
        if (text === 'plan-approval') {
          const options = ['exit-plan-default', 'exit-plan-accept-edits', 'exit-plan-bypass'].map(optionId => ({ optionId, name: optionId, kind: 'allow_once' }));
          out({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId, options, toolCall: { toolCallId: 'plan', title: 'ExitPlanMode', rawInput: { plan: '## 实施计划\n\n1. 阅读代码\n2. 完成验证' } } } });
        } else out({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { sessionId, mode: 'form', toolCallId: 'ask', message: '优先支持哪一端？', requestedSchema: { type: 'object', properties: { question_0: { type: 'string', oneOf: [{ const: '桌面和手机', title: '桌面和手机' }, { const: '先做桌面', title: '先做桌面' }] }, question_0_custom: { type: 'string', title: '补充回答' } } } } });
        return;
      }
      if (process.env.FAKE_LIVE_USAGE && text.includes('live usage')) {
        claudeUsage(sessionId, process.cwd(), msg.id);
        pendingPrompt = msg;
        if (!text.includes('slow')) setTimeout(() => {
          if (pendingPrompt !== msg) return;
          pendingPrompt = null;
          out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: {
            inputTokens: 180, outputTokens: 50, cachedReadTokens: 60, cachedWriteTokens: 10, totalTokens: 300,
          } } });
        }, 2400);
        return;
      }
      if (!traex && /^\/goal(?:\s|$)/.test(text)) {
        if (text.includes('slow')) { pendingPrompt = msg; return; }
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text === '/goal' ? '当前没有目标。' : text === '/goal clear' ? '目标已清除。' : '原生目标完成。' } });
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return;
      }
      if (/^\/compact(?:\s|$)/.test(text)) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'manual-native', title: 'Compact conversation', status: 'in_progress', _meta: { claudeCode: { toolName: 'compact' } } });
        pendingPrompt = msg;
        setTimeout(() => {
          if (pendingPrompt !== msg) return;
          pendingPrompt = null;
          if (process.env.FAKE_COMPACT_FAIL) return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'compaction failed' } });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'manual-native', status: 'completed', _meta: { claudeCode: { toolName: 'compact' } } });
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '上下文压缩完成。' } });
          out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }, Number(process.env.FAKE_COMPACT_DELAY ?? 20));
        return;
      }
      if (text.startsWith('auto-compact')) {
        const native = text.includes('native');
        const status = text.includes('fail') ? 'failed' : text.includes('cancel') ? 'cancelled' : 'completed';
        const compact = (status, first) => update(native
          ? { sessionUpdate: 'compaction_update', compactionId: 'auto-1', status }
          : { sessionUpdate: first ? 'tool_call' : 'tool_call_update', toolCallId: 'auto-1', title: 'Compact conversation', status, _meta: { claudeCode: { toolName: 'compact' } }, rawOutput: { trigger: 'automatic' } });
        compact('in_progress', true); compact(status, false);
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '继续处理。' } });
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return;
      }
      const collaboration = coordinationFixture(text);
      if (collaboration !== null) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: collaboration } });
        out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        return;
      }

      const images = blocks.filter((p) => p.type === 'image');
      if (images.length) {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `images:${images.length}:${images.map((i) => i.mimeType).join(',')};` },
        });
      }
      if (text.includes('edit file')) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Preparing file…', kind: 'edit', status: 'pending', rawInput: {} });
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'e1',
          title: `Edit ${process.cwd()}/src/app.ts`,
          content: [{ type: 'diff', path: `${process.cwd()}/src/app.ts`, oldText: 'const a = 1;\nconst b = 2;', newText: 'const a = 1;\nconst b = 3;\nconst c = 4;' }],
        });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed', rawOutput: 'ok' });
      }
      if (text.includes('plan')) {
        update({
          sessionUpdate: 'plan',
          entries: [
            { content: 'Read the code', priority: 'high', status: 'completed' },
            { content: 'Write the fix', priority: 'medium', status: 'in_progress' },
            { content: 'Run the tests', priority: 'medium', status: 'pending' },
          ],
        });
      }
      if (text.includes('usage')) {
        update({ sessionUpdate: 'usage_update', used: 52000, size: 200000, cost: { amount: 0.42, currency: 'USD' } });
      }
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'a.txt' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}` } });
      if (text.includes('model?')) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `model:${currentModel};mode:${currentMode};effort:${currentEffort}` } });
        return out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
      if (text.includes('approve') && currentMode !== 'bypassPermissions' && currentMode !== 'bypass_permissions') {
        const reqId = nextAgentRequestId++;
        awaitingPermission.set(reqId, msg.id);
        pendingPrompt = { id: msg.id };
        return out({
          jsonrpc: '2.0',
          id: reqId,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 't2', title: 'Edit file', kind: 'edit' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        });
      }
      if (text.includes('out of plan')) {
        return out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: "Internal error: You've hit your session limit · resets 10:10am (UTC)" } });
      }
      if (text.includes('slow')) {
        pendingPrompt = { id: msg.id };
        return;
      }
      return out({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', ...(process.env.FAKE_TELEMETRY ? { usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 40, cachedWriteTokens: 10, totalTokens: 170 } } : {}) } });
    }
    default:
      if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });
  }
});

}
