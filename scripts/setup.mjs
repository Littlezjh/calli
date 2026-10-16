#!/usr/bin/env node
// One command to a working .env: creates it from the template if missing, fills in a random
// access token when empty, and prints the token so it can be pasted straight into the browser.
//
//   npm run setup
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

if (!existsSync(examplePath)) {
  console.error('.env.example not found — run this from a full checkout of the repository.');
  process.exit(1);
}
if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  console.log(`Created ${envPath} from the template.`);
}

let lines = readFileSync(envPath, 'utf8').split('\n');
const at = lines.findIndex((l) => /^RAH_TOKEN=/.test(l));
const current = at >= 0 ? lines[at].slice('RAH_TOKEN='.length).trim() : '';
if (current) {
  console.log('RAH_TOKEN is already set. To see it:');
  console.log(`  grep '^RAH_TOKEN=' ${envPath}`);
} else {
  const token = randomBytes(24).toString('hex');
  if (at >= 0) lines[at] = `RAH_TOKEN=${token}`;
  else lines.push(`RAH_TOKEN=${token}`);
  writeFileSync(envPath, lines.join('\n'));
  console.log('Generated a random access token:');
  console.log(`  ${token}`);
  console.log('Use it to sign in at http://127.0.0.1:8787/ .');
}

console.log(`
Next:
  npm run build
  RAH_ENV_FILE=../../.env npm start -w @rah/daemon   # from the repo root`);
