#!/usr/bin/env node
/**
 * A stand-in for OpenSSH, for tests of the hub's other machines: "machines" are directories on
 * this one. It understands what the hub asks of ssh and nothing more:
 *
 *   fake-ssh [-o k=v]... [-T] [-L local.sock:remote.sock] -- target command
 *
 * FAKE_SSH_HOSTS is a JSON file: { "<target>": { "home": "/dir" } | { "fail": "what ssh prints" } }.
 * The command runs in sh with HOME set to the machine's home, so `$HOME/...` lands in that
 * directory. `-L` relays this end to the socket at the other. The tunnel's pid is written to
 * <home>/ssh.pid, so a test can drop the connection by killing it.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';

const args = process.argv.slice(2);
let forward = null;
let target = null;
let command = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') i++;
  else if (a === '-L') forward = args[++i];
  else if (a === '-T' || a === '-N') continue;
  else if (a === '--') {
    target = args[i + 1];
    command = args.slice(i + 2).join(' ');
    break;
  } else {
    console.error(`fake-ssh: unexpected argument ${a}`);
    process.exit(255);
  }
}

const hosts = JSON.parse(readFileSync(process.env.FAKE_SSH_HOSTS ?? '', 'utf8'));
const host = hosts[target];
if (!host) {
  console.error(`ssh: Could not resolve hostname ${target}: Name or service not known`);
  process.exit(255);
}
if (host.fail) {
  console.error(host.fail);
  process.exit(255);
}

let server = null;
if (forward) {
  const [local, remote] = forward.split(':');
  rmSync(local, { force: true });
  server = createServer((client) => {
    const upstream = connect(remote);
    upstream.on('error', (err) => {
      console.error(`channel 2: open failed: connect failed: ${err.code === 'ENOENT' ? 'No such file or directory' : 'Connection refused'}`);
      client.destroy();
    });
    client.on('error', () => upstream.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise((done) => server.listen(local, done));
  writeFileSync(join(host.home, 'ssh.pid'), String(process.pid));
}

const child = spawn('sh', ['-c', command], { stdio: 'inherit', env: { ...process.env, HOME: host.home } });
const finish = (code) => {
  server?.close();
  if (forward) rmSync(forward.split(':')[0], { force: true });
  process.exit(code);
};
child.on('exit', (code) => finish(code ?? 255));
process.on('SIGTERM', () => {
  child.kill();
  finish(255);
});
