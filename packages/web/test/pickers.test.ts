import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effortsForModel, imagesBlocked, modelName, modelRows } from '../src/components/Pickers.js';

const claude = [
  { id: 'default', label: 'Default (recommended)', description: 'Opus 5.5' },
  { id: 'opus', label: 'Opus 5.5', description: 'For complex work' },
  { id: 'haiku', label: 'Haiku 5.5' },
];
const pi = [{ id: 'zai/glm', label: 'GLM (zai)' }];

test('with no override, the button shows the model the agent default points at', () => {
  assert.equal(modelName(claude, null), 'Opus 5.5');
  assert.equal(modelName(pi, null), '默认模型');
  assert.equal(modelName([], null), '默认模型');
});

test('a chosen model shows its own label, and an unknown id shows as-is', () => {
  assert.equal(modelName(claude, 'haiku'), 'Haiku 5.5');
  assert.equal(modelName(claude, 'gone-model'), 'gone-model');
});

test('the agent default is folded into one row, so there is no duplicate default', () => {
  const rows = modelRows(claude);
  assert.deepEqual(rows.map((r) => r.value), [null, 'opus', 'haiku']);
  assert.equal(rows[0].hint, '当前是 Opus 5.5');
  assert.equal(rows.filter((r) => r.label.includes('Default')).length, 0);
});

test('agents without their own default get a plain default row', () => {
  const rows = modelRows(pi);
  assert.deepEqual(rows.map((r) => r.value), [null, 'zai/glm']);
  assert.equal(rows[0].label, '默认模型');
});

test('effort levels follow the model, with the agent default looked up under its own id', () => {
  const models = [
    { id: 'default', label: 'Default', description: 'Opus 5.5', efforts: ['low', 'high', 'max'] },
    { id: 'old', label: 'Opus 4.6', efforts: ['low', 'high'] },
    { id: 'tiny', label: 'Haiku 4.5', efforts: [] },
    { id: 'unknown', label: 'No info' },
  ];
  const agentWide = ['low', 'medium', 'high'];
  assert.deepEqual(effortsForModel(models, null, agentWide), ['low', 'high', 'max']);
  assert.deepEqual(effortsForModel(models, 'old', agentWide), ['low', 'high']);
  assert.deepEqual(effortsForModel(models, 'tiny', agentWide), [], 'a model can have no effort setting');
  assert.deepEqual(effortsForModel(models, 'unknown', agentWide), agentWide, 'missing info falls back');
  assert.deepEqual(effortsForModel([], null, agentWide), agentWide);
});

test('an agent that flags its default model (pi) gets the same treatment as one with a "default" alias', () => {
  const models = [
    { id: 'z/vision', label: 'GLM-4.6V', efforts: ['off', 'low'], images: true },
    { id: 'z/main', label: 'GLM-5.3', efforts: ['low', 'high', 'max'], images: false, isDefault: true },
  ];
  assert.equal(modelName(models, null), 'GLM-5.3');
  assert.deepEqual(effortsForModel(models, null, ['medium']), ['low', 'high', 'max']);
  const rows = modelRows(models);
  assert.deepEqual(rows.map((r) => r.value), [null, 'z/vision', 'z/main'], 'the real model stays selectable by name');
  assert.equal(rows[0].hint, '当前是 GLM-5.3');
});

test('imagesBlocked says why pictures cannot be sent, and nothing when they can or it is unknown', () => {
  const models = [
    { id: 'a', label: 'Vision', images: true },
    { id: 'b', label: 'TextOnly', images: false, isDefault: true },
    { id: 'c', label: 'Unknown' },
  ];
  assert.equal(imagesBlocked(models, 'a'), null);
  assert.match(imagesBlocked(models, 'b') ?? '', /TextOnly 不能读图片/);
  assert.match(imagesBlocked(models, null) ?? '', /TextOnly/, 'no override means the default model');
  assert.equal(imagesBlocked(models, 'c'), null);
  assert.equal(imagesBlocked([], null), null);
});

test('permissionHint: the middle level means edits only for an agent that cannot ask', async () => {
  const { permissionHint } = await import('../src/permissions.js');
  assert.match(permissionHint('auto_edit', true), /询问/);
  assert.match(permissionHint('auto_edit', false), /拒绝/);
  assert.equal(permissionHint('full_access', false), permissionHint('full_access', true));
  assert.equal(permissionHint('unknown', true), '');
});

test('a model that cannot see is still offered pictures when the agent can show them to it', async () => {
  const { imagesNote } = await import('../src/components/Pickers.js');
  const models = [
    { id: 'p/plain', label: 'Plain', images: false },
    { id: 'p/blind', label: 'Blind', images: false, imagesVia: 'describe_image' },
    { id: 'p/eyes', label: 'Eyes', images: true },
  ];
  assert.match(imagesBlocked(models, 'p/plain') ?? '', /Plain 不能读图片/);
  assert.equal(imagesBlocked(models, 'p/blind'), null);
  assert.match(imagesNote(models, 'p/blind') ?? '', /Blind 不能直接看图，会用 describe_image/);
  assert.equal(imagesNote(models, 'p/eyes'), null);
  assert.equal(imagesNote(models, 'p/plain'), null);
});
