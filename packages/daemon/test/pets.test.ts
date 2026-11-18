import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { AttachmentStore } from '../src/attachments.js';
import { createHttpServer } from '../src/http.js';
import { PET, PetService, keptFrames } from '../src/pets.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';

const TOKEN = 'test-token-0123456789';
const ARCHIVE = fileURLToPath(new URL('../assets/pets/dafeiyu-0843238.tar.gz', import.meta.url));

test('installs bundled frames with no network access and joins concurrent callers', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'calli-pets-'));
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network unavailable'); });
  try {
    const pets = new PetService(root);
    assert.equal(pets.status().installed, false);
    const installation = pets.install();
    assert.equal(pets.install(), installation);
    await installation;
    const status = pets.status();
    assert.equal(status.installed, true);
    assert.equal(status.commit, PET.commit);
    assert.equal(status.installing, false);
    assert.equal(status.error, null);
    assert.equal(network.mock.callCount(), 0);
    for (const [clip, count] of Object.entries(PET.clips)) {
      const frames = readdirSync(join(root, PET.id, clip)).sort();
      assert.equal(frames.length, keptFrames(count));
      assert.deepEqual(frames.slice(0, 2), [`${clip}_001.webp`, `${clip}_003.webp`]);
      for (const frame of frames) {
        const bytes = readFileSync(join(root, PET.id, clip, frame));
        assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
        assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      }
    }
    assert.match(pets.license() ?? '', /MIT License/);
    assert.match(pets.license() ?? '', /Copyright \(c\) 2026 PC2005-cloud/);
    assert.match(readFileSync(join(root, PET.id, 'SOURCE'), 'utf8'), new RegExp(PET.commit));
    assert.equal(existsSync(join(root, `${PET.id}.partial`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing installation works without opening the bundled archive again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-pets-'));
  try {
    await new PetService(root).install();
    const pets = new PetService(root, join(root, 'unavailable.tar.gz'));
    await pets.install();
    assert.equal(pets.status().installed, true);
    assert.match(pets.license() ?? '', /MIT License/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a damaged bundle leaves no partial installation and a repaired bundle can be retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-pets-'));
  const archive = join(root, 'damaged.tar.gz');
  writeFileSync(archive, 'damaged archive');
  const pets = new PetService(root, archive);
  try {
    await assert.rejects(pets.install(), /checksum mismatch/);
    assert.equal(pets.status().installed, false);
    assert.equal(pets.status().installing, false);
    assert.match(pets.status().error ?? '', /checksum mismatch/);
    assert.equal(existsSync(join(root, PET.id)), false);
    assert.equal(existsSync(join(root, `${PET.id}.partial`)), false);
    copyFileSync(ARCHIVE, archive);
    await pets.install();
    assert.equal(pets.status().installed, true);
    assert.equal(pets.status().error, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an older cached version is replaced with the bundled commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-pets-'));
  const dir = join(root, PET.id);
  mkdirSync(dir);
  writeFileSync(join(dir, 'INSTALLED'), 'old-commit');
  writeFileSync(join(dir, 'obsolete'), 'old artwork');
  try {
    const pets = new PetService(root);
    assert.equal(pets.status().installed, false);
    await pets.install();
    assert.equal(pets.status().installed, true);
    assert.equal(readFileSync(join(dir, 'INSTALLED'), 'utf8').trim(), PET.commit);
    assert.equal(existsSync(join(dir, 'obsolete')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundled frames are served without a token; everything else about pets needs one', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'calli-pets-data-'));
  const root = mkdtempSync(join(tmpdir(), 'calli-pets-'));
  const store = new Store(dataDir);
  const manager = new ThreadManager(store, new Map(), [dataDir], new AttachmentStore(dataDir));
  const pets = new PetService(root);
  const server = createHttpServer({ manager, token: TOKEN, webDir: null, version: 'test', pets });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  try {
    assert.equal((await fetch(`${base}/api/pets`)).status, 401);
    const status = await (await fetch(`${base}/api/pets`, { headers: auth })).json();
    assert.equal(status.installed, false); assert.equal(status.commit, PET.commit);
    assert.equal((await fetch(`${base}/pets/${PET.id}/idle/idle_001.webp`)).status, 404);

    const started = await fetch(`${base}/api/pets/install`, { method: 'POST', headers: auth });
    assert.equal(started.status, 202);
    assert.equal((await started.json()).commit, PET.commit);
    for (let i = 0; i < 200 && !pets.status().installed; i++) await new Promise((resolve) => setTimeout(resolve, 10));

    const frame = await fetch(`${base}/pets/${PET.id}/idle/idle_001.webp`);
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get('content-type'), 'image/webp');
    assert.deepEqual(Buffer.from(await frame.arrayBuffer()), readFileSync(join(root, PET.id, 'idle', 'idle_001.webp')));
    assert.equal((await fetch(`${base}/pets/${PET.id}/idle/thinking_001.webp`)).status, 404);
    assert.equal((await fetch(`${base}/pets/${PET.id}/LICENSE.txt`)).status, 404);
    assert.equal((await fetch(`${base}/pets/${PET.id}/..%2F..%2Fidle/idle_001.webp`)).status, 404);
    assert.equal((await fetch(`${base}/pets/other/idle/idle_001.webp`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.shutdown();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
