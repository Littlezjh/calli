import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referencesFile } from '../src/artifacts.js';

test('artifact references match whole paths, including encoded links, spaces and source lines', () => {
  const path = '/tmp/report/截图 (1).png';
  for (const text of [
    `[截图](<${path}>)`,
    `[截图](file://${encodeURI(path)})`,
    `[截图](${encodeURI(path)} "Caption")`,
    `\`${path}\``,
    `"${path}"`,
  ]) assert.equal(referencesFile(text, path), true, text);
  assert.equal(referencesFile('[日志](/tmp/report/log.txt:12)', '/tmp/report/log.txt'), true);
  assert.equal(referencesFile('[日志](/tmp/report/log.txt#L12-L20)', '/tmp/report/log.txt'), true);
  assert.equal(referencesFile('图片在：/tmp/report/chart.png。', '/tmp/report/chart.png'), true);
  assert.equal(referencesFile('`/tmp/report/a%20b.png`', '/tmp/report/a%20b.png'), true);
});

test('mentions do not grant path prefixes, web URLs, relative paths or double-decoded paths', () => {
  for (const text of [
    '/tmp/report/chart.png.bak', '/tmp/report/chart.png/child',
    '[web](https://example.com/tmp/report/chart.png)',
    'https://example.com/tmp/report/chart.png',
    'tmp/report/chart.png', '/tmp/report/',
    '[file](file://remote/tmp/report/chart.png)',
    '[file](/tmp/report/%2563hart.png)',
  ]) assert.equal(referencesFile(text, '/tmp/report/chart.png'), false, text);
});
