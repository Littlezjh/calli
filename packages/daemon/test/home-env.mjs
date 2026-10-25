// Each test worker and its fake agents use an isolated home, never the developer's home.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const testHome = mkdtempSync(join(tmpdir(), 'limi-test-home-'));
process.env.HOME = testHome;
process.on('exit', () => rmSync(testHome, { recursive: true, force: true }));
