#!/usr/bin/env node
// A stand-in for the Antigravity CLI in headless stream-json mode, for tests.
// Prompt text drives behaviour: "tool" runs a command, "command" needs a permission that headless
// mode cannot ask for, "slow" waits until interrupted, "crash" exits.
const args = process.argv.slice(2);

if (args[0] === 'models') {
  process.stderr.write('Fetching available models...\n');
  process.stdout.write('fast-low\tFast (Low)\nfast-high\tFast (High)\nnot a model line\nbig-thinking\tBig (Thinking)\n');
  process.exit(0);
}

// One-off print mode with a prompt of its own: how agy answers the commands it handles itself.
const promptIndex = args.indexOf('-p');
if (promptIndex >= 0 && args[promptIndex + 1] !== undefined) {
  const text = args[promptIndex + 1];
  if (text === '/help') {
    process.stdout.write('/config (settings)\tOpen settings panel\n/effort\tSet the reasoning effort\n/model\tSet a model\n/skills\tList available skills\n/usage (quota)\tView model quota usage\n/broken\tAlways fails\n');
  } else if (text === '/skills') {
    process.stdout.write('make-video\tTurn a brief into a video\nreview\tReview the current change\n');
  } else if (text.startsWith('/usage') || text.startsWith('/quota')) {
    process.stdout.write(`Fast models\tWeekly Limit Remaining\t97%\nSlow | models\tFive Hour Limit Remaining\t40%\n`);
  } else if (text === '/config') {
    process.stdout.write('colorScheme\tterminal\nallowNonWorkspaceAccess\tfalse\n');
  } else if (text === '/broken') {
    process.stderr.write('error: /broken failed: not available here\n');
    process.exit(1);
  } else {
    process.stdout.write(`print:${text}\n`);
  }
  process.exit(0);
}

const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!args.includes('-p=') || flag('--input-format') !== 'stream-json' || flag('--output-format') !== 'stream-json') {
  process.stderr.write('fake-agy: expected stream-json in both directions and -p=\n');
  process.exit(2);
}

const conversation = flag('--conversation') ?? 'agy-conv-1';
const model = flag('--model') ?? 'default';
const fullAccess = args.includes('--dangerously-skip-permissions');
const mode = fullAccess ? 'always-proceed' : (flag('--mode') ?? 'request-review');

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
let stepIndex = 0;
const step = (fields) => out({ event: 'step_update', step_update: { conversation_id: conversation, ...fields } });
const result = (fields) => out({ event: 'result', result: { conversation_id: conversation, ...fields } });

setTimeout(() => out({ event: 'init', conversation_id: conversation, init: { cwd: process.cwd(), tools: [], permission_mode: mode } }), 10);

let waiting = false;
process.on('SIGINT', () => {
  if (waiting) result({ status: 'ERROR', response: 'partial', error: 'interrupted' });
  process.exit(1);
});

function runTurn(text) {
  step({ step_index: stepIndex++, state: 'DONE', step_type: 'user_input' });
  if (text.includes('crash')) {
    process.stderr.write('fake-agy: something broke\n');
    process.exit(7);
  }
  if (text.includes('slow')) {
    step({ step_index: stepIndex, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'working' });
    waiting = true;
    return;
  }
  if (text.includes('tool')) {
    const index = stepIndex++;
    const info = { name: 'run_command', parameters: { CommandLine: 'echo hi' } };
    step({ step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: info });
    step({ step_index: index, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { ...info, output: 'hi\r\n' } });
  }
  if (text.includes('command') && !fullAccess) {
    const index = stepIndex++;
    const info = { name: 'run_command', parameters: { CommandLine: 'make test' } };
    step({ step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: info });
    step({ step_index: index, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { ...info, error: { type: 'TOOL_ERROR', message: 'user denied permission to run command' } } });
    process.stderr.write('jetski: no output produced\n');
    return result({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] });
  }
  const index = stepIndex++;
  const reply = `echo:${text};model:${model};mode:${mode};conv:${conversation}`;
  step({ step_index: index, state: 'ACTIVE', step_type: 'agent_response', text_delta: reply });
  step({ step_index: index, state: 'DONE', step_type: 'agent_response', text_delta: '\n' });
  result({ status: 'SUCCESS', response: reply + '\n', num_turns: 1 });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.event !== 'user') {
      process.stderr.write(`warning: ignoring unsupported stream input message event "${msg.event}"\n`);
      continue;
    }
    runTurn(String(msg.message?.content ?? ''));
  }
});
process.stdin.on('end', () => process.exit(0));
