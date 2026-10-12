// Fake pi RPC process for tests. Speaks pi's JSONL RPC protocol on stdio.
// Prompt text drives behaviour: "slow" waits until abort, "fail" ends with an error.
import { coordinationFixture } from './coordination.mjs';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
// `pi mcp list --json` is a shell command, not an RPC session: FAKE_PI_MCP=1 reports the zai vision
// MCP server as connected, anything else no servers at all.
if (args[0] === 'mcp' && args[1] === 'list' && args.includes('--json')) {
  const servers =
    process.env.FAKE_PI_MCP === '1'
      ? [{ name: 'zai-mcp-server', enabled: true, state: 'connected', tools: ['image_analysis', 'ui_diff_check'] }]
      : [];
  process.stdout.write(JSON.stringify({ servers, errors: [] }) + '\n');
  process.exit(0);
}
if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc') {
  console.error('fake-pi: expected --mode rpc');
  process.exit(2);
}
const ephemeral = args.includes('--no-session');
const sessionIdx = args.indexOf('--session');
let sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : 'pi-session-1';
// pi keeps sessions by directory. `--fork <id>` copies one into the directory pi is started in;
// the copy's id says where it lives: `<id>-in-<directory name>`.
const here = basename(process.cwd());
const forkIdx = args.indexOf('--fork');
if (forkIdx >= 0) sessionId = `${args[forkIdx + 1]}-in-${here}`;
// Opening such a copy from any other directory is what the real pi refuses to do without asking.
const home = /-in-([^-]+)(?:-fork-e\d+)?$/.exec(sessionId)?.[1];
if (sessionIdx >= 0 && home && home !== here) {
  console.log('Session found in different project');
  console.log('Fork this session into current directory? [y/N] ');
  console.log('Aborted.');
  process.exit(0);
}
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
let running = false;
let contextUnknown = false;

// "think" maps like a real provider: null means unsupported, xhigh/max need an explicit mapping.
const MODELS = [
  {
    id: 'think',
    provider: 'fake',
    name: 'Think',
    reasoning: true,
    input: ['text', 'image'],
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
  },
  { id: 'plain', provider: 'fake', name: 'Plain', reasoning: false, input: ['text'] },
  { id: 'loose', provider: 'fake', name: 'Loose', reasoning: true, input: ['text'] },
];

const HIST_MESSAGES = [
  { role: 'system', content: '' },
  { role: 'user', content: 'run the tests', timestamp: 1 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'need to run them' },
      { type: 'toolCall', id: 'c9', name: 'bash', arguments: { command: 'npm test' } },
    ],
  },
  { role: 'toolResult', toolCallId: 'c9', toolName: 'bash', content: [{ type: 'text', text: '12 passed' }], isError: false },
  { role: 'assistant', content: [{ type: 'text', text: 'All 12 pass.' }] },
  { role: 'user', content: [{ type: 'text', text: 'and this picture?' }, { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', mimeType: 'image/png' }], timestamp: 2 },
  { role: 'assistant', content: [{ type: 'text', text: 'A single pixel.' }] },
];

const userText = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''));

/**
 * What a session holds. Tests can script what the "terminal" did to one: a JSON file of messages
 * per session id. Sessions named hist… hold a canned two-turn conversation. A session made by
 * `fork` holds what its source did before the message it was forked from.
 */
function messagesOf(id) {
  const forked = /^(.*)-fork-e(\d+)$/.exec(String(id));
  if (forked) {
    const source = messagesOf(forked[1]);
    let seen = 0;
    const cut = source.findIndex((m) => m.role === 'user' && ++seen === Number(forked[2]));
    return cut < 0 ? source : source.slice(0, cut);
  }
  // A copy made into another directory holds what its source holds.
  const moved = /^(.*)-in-[^-]+$/.exec(String(id));
  if (moved) return messagesOf(moved[1]);
  if (process.env.FAKE_PI_MESSAGES_FILE) {
    try {
      const scripted = JSON.parse(readFileSync(process.env.FAKE_PI_MESSAGES_FILE, 'utf8'));
      if (Array.isArray(scripted[id])) return scripted[id];
    } catch {
      // fall through to the canned answer
    }
  }
  return String(id).startsWith('hist') ? HIST_MESSAGES : [];
}

/** The user messages of a session, numbered from one: e1, e2, … */
const forkPoints = (id) =>
  messagesOf(id)
    .filter((m) => m.role === 'user')
    .map((m, i) => ({ entryId: `e${i + 1}`, text: userText(m) }));

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = JSON.parse(line);
  const reply = (data, success = true, error) =>
    out({ id: cmd.id, type: 'response', command: cmd.type, success, ...(success ? { data } : { error }) });

  switch (cmd.type) {
    case 'get_available_models':
      // Probes must not create sessions in pi's session list.
      if (!ephemeral) return reply(null, false, 'probe ran without --no-session');
      return reply({ models: MODELS });
    case 'get_commands':
      if (!ephemeral) return reply(null, false, 'probe ran without --no-session');
      return reply({
        commands: [
          { name: 'fix-tests', description: 'Fix failing tests', source: 'prompt' },
          { name: 'skill:pdf', description: 'Work with PDF files', source: 'skill' },
          { name: 'deploy', source: 'extension' },
          // Tests turn on the vision extension (describe_image) with FAKE_PI_VISION=1.
          ...(process.env.FAKE_PI_VISION === '1' ? [{ name: 'vision', description: 'Manage describe_image', source: 'extension' }] : []),
        ],
      });
    case 'set_model':
    case 'set_thinking_level':
      return reply({});
    case 'get_messages':
      return reply({ messages: messagesOf(sessionId) });
    // The user messages a copy can be forked from, each with the id `fork` takes.
    case 'get_fork_messages':
      return reply({ messages: forkPoints(sessionId) });
    // A copy that holds everything before one user message; this pi moves over to it.
    case 'fork': {
      const point = forkPoints(sessionId).find((m) => m.entryId === cmd.entryId);
      if (!point) return reply(null, false, `no entry ${cmd.entryId}`);
      sessionId = `${sessionId}-fork-${cmd.entryId}`;
      return reply({ text: point.text, cancelled: false });
    }
    case 'compact':
      if (cmd.customInstructions === 'explode') return reply(null, false, 'nothing to compact');
      contextUnknown = true;
      return reply({ summary: `summary ${cmd.customInstructions ?? ''}`.trim(), tokensBefore: 150000, estimatedTokensAfter: 32000 });
    case 'get_session_stats':
      return reply({
        sessionId,
        userMessages: 2,
        assistantMessages: 2,
        toolCalls: 3,
        tokens: { input: 900000, output: 300000, cacheRead: 400000, cacheWrite: 100000, total: 1700000 },
        cost: 0.02,
        contextUsage: { tokens: contextUnknown ? null : 1200, contextWindow: 200000, percent: contextUnknown ? null : 0.6 },
      });
    case 'clone':
      if (sessionId === 'uncloneable') return reply({ cancelled: true });
      sessionId = `${sessionId}-clone`;
      return reply({ cancelled: false });
    case 'get_state':
      return reply({ sessionId, isStreaming: running, model: MODELS[0] });
    case 'prompt': {
      if (running) return reply(null, false, 'already streaming');
      const collaboration = coordinationFixture(cmd.message);
      if (collaboration !== null) {
        reply({ disposition: 'started' });
        out({ type: 'agent_start' });
        out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: collaboration } });
        out({ type: 'agent_settled', aborted: false });
        return;
      }

      contextUnknown = false;
      running = true;
      reply({ disposition: 'started' });
      out({ type: 'agent_start' });
      out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' } });
      // "slowthink" spaces the turn out, so a UI test can watch it run. It interleaves tool calls
      // with text on purpose: a group, then text, then another group — the order the view must
      // keep instead of hoisting every step above the answer.
      if (cmd.message.includes('slowthink')) {
        setTimeout(() => {
          out({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } });
          out({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a.txt' }] }, isError: false });
        }, 500);
        setTimeout(() => {
          out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi there ' + cmd.message } });
        }, 1300);
        setTimeout(() => {
          out({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'bash', args: { command: 'npm test' } });
        }, 2100);
        setTimeout(() => {
          out({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'bash', result: { content: [{ type: 'text', text: '12 passed' }] }, isError: false });
          running = false;
          out({ type: 'agent_settled', aborted: false });
        }, 2900);
        return;
      }
      // "manysteps" is a turn that looks around a lot before it says anything: four calls in a
      // row, a remark, then two more with the last one slow. The view folds each finished run of
      // calls into one line that counts them, and keeps the call in flight on screen.
      if (cmd.message.includes('manysteps')) {
        const call = (id, toolName, args, text) => {
          out({ type: 'tool_execution_start', toolCallId: id, toolName, args });
          if (text !== undefined) out({ type: 'tool_execution_end', toolCallId: id, toolName, result: { content: [{ type: 'text', text }] }, isError: false });
        };
        setTimeout(() => {
          call('m1', 'read', { path: 'src/a.ts' }, 'export const a = 1;');
          call('m2', 'read', { path: 'src/b.ts' }, 'export const b = 2;');
          call('m3', 'grep', { pattern: 'TODO' }, 'src/a.ts:3');
          call('m4', 'bash', { command: 'ls src' }, 'a.ts b.ts');
        }, 200);
        setTimeout(() => {
          out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'looked around, now checking: ' } });
        }, 700);
        setTimeout(() => {
          call('m5', 'bash', { command: 'npm run lint' }, 'clean');
          call('m6', 'bash', { command: 'npm test' });
        }, 1200);
        setTimeout(() => {
          out({ type: 'tool_execution_end', toolCallId: 'm6', toolName: 'bash', result: { content: [{ type: 'text', text: '12 passed' }] }, isError: false });
          out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'all good' } });
          running = false;
          out({ type: 'agent_settled', aborted: false });
        }, 4200);
        return;
      }
      // "forkflow" is the shape of a turn watched on a phone: an edit lands (so the turn has
      // diffs), the agent says something on the way, and then a long command runs. While that
      // command is still running the turn is not finished — a summary of changed files must not
      // show yet, and the live steps must stay visible.
      if (cmd.message.includes('forkflow')) {
        setTimeout(() => {
          out({ type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: { path: 'demo.ts', content: 'export const one = 1;\n' } });
          out({ type: 'tool_execution_end', toolCallId: 'w1', toolName: 'write', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
        }, 200);
        setTimeout(() => {
          out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'files done, now the long run: ' } });
        }, 1000);
        setTimeout(() => {
          out({ type: 'tool_execution_start', toolCallId: 'c9', toolName: 'bash', args: { command: 'npm test' } });
        }, 1800);
        setTimeout(() => {
          out({ type: 'tool_execution_end', toolCallId: 'c9', toolName: 'bash', result: { content: [{ type: 'text', text: '12 passed' }] }, isError: false });
          running = false;
          out({ type: 'agent_settled', aborted: false });
        }, 6000);
        return;
      }
      out({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } });
      out({ type: 'tool_execution_update', toolCallId: 'c1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'partial' }] } });
      out({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a.txt' }] }, isError: false });
      if (cmd.images?.length) {
        out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `images:${cmd.images.length}:${cmd.images.map((i) => i.mimeType).join(',')};` } });
      }
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi ' } });
      const marker = process.env.FAKE_PI_LABEL ? `[${process.env.FAKE_PI_LABEL}] ` : '';
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: marker + 'there ' + cmd.message } });
      if (cmd.message.includes('fail')) {
        out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider exploded' } });
        running = false;
        return out({ type: 'agent_settled', aborted: false });
      }
      if (cmd.message.includes('slow')) return;
      running = false;
      return out({ type: 'agent_settled', aborted: false });
    }
    case 'abort':
      reply({});
      if (running) {
        running = false;
        out({ type: 'agent_settled', aborted: true });
      }
      return;
    default:
      return reply(null, false, `unknown command ${cmd.type}`);
  }
});
