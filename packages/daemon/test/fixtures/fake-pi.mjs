// Fake pi RPC process for tests. Speaks pi's JSONL RPC protocol on stdio.
// Prompt text drives behaviour: "slow" waits until abort, "fail" ends with an error.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc') {
  console.error('fake-pi: expected --mode rpc');
  process.exit(2);
}
const ephemeral = args.includes('--no-session');
const sessionIdx = args.indexOf('--session');
let sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : 'pi-session-1';
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
let running = false;

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
    case 'get_messages': {
      // Tests can script what the "terminal" did to a session: a JSON file of messages per session id.
      if (process.env.FAKE_PI_MESSAGES_FILE) {
        try {
          const scripted = JSON.parse(readFileSync(process.env.FAKE_PI_MESSAGES_FILE, 'utf8'));
          if (Array.isArray(scripted[sessionId])) return reply({ messages: scripted[sessionId] });
        } catch {
          // fall through to the canned answer
        }
      }
      return reply({
        messages: String(sessionId).startsWith('hist')
          ? [
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
            ]
          : [],
      });
    }
    case 'compact':
      if (cmd.customInstructions === 'explode') return reply(null, false, 'nothing to compact');
      return reply({ summary: `summary ${cmd.customInstructions ?? ''}`.trim(), tokensBefore: 150000, estimatedTokensAfter: 32000 });
    case 'get_session_stats':
      return reply({
        sessionId,
        userMessages: 2,
        assistantMessages: 2,
        toolCalls: 3,
        tokens: { input: 900, output: 300, cacheRead: 0, cacheWrite: 0, total: 1200 },
        cost: 0.02,
        contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
      });
    case 'clone':
      if (sessionId === 'uncloneable') return reply({ cancelled: true });
      sessionId = `${sessionId}-clone`;
      return reply({ cancelled: false });
    case 'get_state':
      return reply({ sessionId, isStreaming: running, model: MODELS[0] });
    case 'prompt': {
      if (running) return reply(null, false, 'already streaming');
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
