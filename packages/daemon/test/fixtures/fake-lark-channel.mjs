#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (Object.keys(process.env).some(key => key.startsWith('CALLI_'))) throw new Error('Hub credentials must not reach Lark');
const config = process.env.FAKE_LARK_DATA ? JSON.parse(readFileSync(process.env.FAKE_LARK_DATA, 'utf8')) : {};
if (process.env.FAKE_LARK_LOG) appendFileSync(process.env.FAKE_LARK_LOG, JSON.stringify(args) + '\n');
const key = args.slice(0, 2).join(' ');
const arg = name => args[args.indexOf(name) + 1];
if (config.delay) await new Promise(r => setTimeout(r, config.delay));
if (args[0] === '--help') { console.log('Readonly Lark fixture'); process.exit(0); }
if (key === 'auth status') { console.log(JSON.stringify({ identities: { user: { available: config.loggedIn !== false, status: 'needs_refresh', openId: config.identity ?? 'ou_self' } } })); process.exit(0); }
if (key === 'event consume') {
  const mode = config.realtime ?? {};
  if (arg('--as') !== (args[2].startsWith('im.') ? 'bot' : 'user')) throw new Error('Wrong event identity');
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ ok: true, data: { decision: { status: mode.consoleOff ? 'blocked' : 'ready',
      preconditions: [{ name: 'console_event_published', status: mode.consoleOff ? 'blocked' : 'ok' }] } } }));
    process.exit(0);
  }
  if (mode.busy) { console.error('another event bus is already connected to this app'); process.exit(1); }
  if (mode.stderr) console.error(mode.stderr);
  console.error('event consumer ready');
  for (const event of mode.events ?? []) console.log(JSON.stringify(event));
  if (mode.exitCode !== undefined) process.exit(mode.exitCode);
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
}
const allowed = ['task +get-my-tasks', 'im +messages-search', 'im +flag-list', 'calendar +agenda', 'contact +search-user', 'im +chat-search', 'im +threads-messages-list'];
if (!allowed.includes(key) || arg('--as') !== 'user') throw new Error('Only explicit readonly user commands are allowed');
if (config.fail === key) { console.error('sensitive_cli_output_must_not_escape'); process.exit(1); }
const tasks = config.tasks ?? [{ guid: 'task_fixture', summary: '准备季度评审材料', due: { timestamp: String(Date.now() + 36e5) } }];
let data;
if (key === 'task +get-my-tasks') {
  if (!args.includes('--complete=false')) throw new Error('Only incomplete tasks');
  data = { tasks: args.includes('--page-token') ? config.taskPage2 ?? [] : tasks, has_more: !args.includes('--page-token') && Boolean(config.taskPage2), page_token: 'tasks-page-2' };
} else if (key === 'im +messages-search') {
  if (!args.includes('--sender') && !args.includes('--chat-id')) throw new Error('Unscoped message search');
  if (!args.includes('--start') || !args.includes('--end')) throw new Error('Missing message cursor');
  data = { messages: config.messages ?? (config.threaded ? [{ message_id: 'message_fixture', thread_id: 'omt_fixture', root_id: 'om_fixture_root', sender: { id: 'ou_watch' }, content: '请确认材料' }, { message_id: 'reply_fixture', root_id: 'om_fixture_root', sender: { id: 'ou_watch' }, content: '请看回复链' }] : []), has_more: false };
} else if (key === 'im +threads-messages-list') {
  if (!args.includes('--thread') || arg('--order') !== 'asc') throw new Error('Missing thread or ascending order');
  const topic = config.topics?.[arg('--thread')] ?? {};
  if (topic.fail) { console.error('sensitive_topic_error'); process.exit(1); }
  data = { messages: args.includes('--page-token') ? topic.page2 ?? [] : topic.messages ?? [],
    has_more: !args.includes('--page-token') && Boolean(topic.page2), page_token: 'topic-page-2' };
} else if (key === 'im +flag-list') data = { flag_items: config.flags ?? [], messages: config.flagMessages ?? [], has_more: false };
else if (key === 'calendar +agenda') data = { events: config.events ?? [] };
else if (key === 'contact +search-user') data = { users: [{ open_id: 'ou_fixture', localized_name: '示例同事', department: '示例团队' }] };
else data = { chats: [{ chat_id: 'oc_fixture', name: '示例项目群', description: '测试用群' }] };
console.log(JSON.stringify({ ok: true, identity: 'user', data }));
