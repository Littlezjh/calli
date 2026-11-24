import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Budgets and ratchets for the UI's source (AGENTS.md "界面" and docs/LESSONS.md).
// A budget is met, not raised: a change that reaches one moves something out first (a component
// of its own, a stylesheet beside it, a lazily loaded module). A ratchet only goes down: when a
// change lowers a count, lower the number here in the same change. Raising either needs the
// owner's agreement, named in the commit.

const src = join(import.meta.dirname, '..', 'src');
const read = (path: string) => readFileSync(join(src, path), 'utf8');
const lines = (text: string) => text.split('\n').length;

const BUDGET = {
  'App.tsx': 3900,
  'styles.css': 15600,
};

const RATCHET = {
  /** `font-size: 12.5px` and the like instead of a size variable. */
  rawFontSizes: 921,
  /** How many different raw font sizes there are; a type scale needs only a handful. */
  distinctFontSizes: 27,
  /** `border-radius: 8px` and the like instead of a --radius variable. */
  rawRadii: 147,
  /** `z-index: 60` and the like instead of a --z variable. */
  rawZIndexes: 63,
  /** Colours written outside a custom property's definition (masks included). */
  rawColours: 23,
};

test('the largest UI files stay within their budgets', () => {
  for (const [file, budget] of Object.entries(BUDGET)) {
    const count = lines(read(file));
    assert.ok(count <= budget, `${file} has ${count} lines, over its budget of ${budget}: move something out first`);
  }
});

test('raw style values only go down', () => {
  const css = read('styles.css');
  const outsideVars = css.split('\n').filter((line) => !/^\s*--[\w-]+\s*:/.test(line)).join('\n');
  const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+px)/g)].map((m) => m[1]);
  const counts = {
    rawFontSizes: fontSizes.length,
    distinctFontSizes: new Set(fontSizes).size,
    rawRadii: [...css.matchAll(/border-radius:\s*[0-9][^;]*/g)].filter((m) => !m[0].includes('var(')).length,
    rawZIndexes: [...css.matchAll(/z-index:\s*[0-9]+/g)].length,
    rawColours: [...outsideVars.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)].length,
  };
  for (const [key, limit] of Object.entries(RATCHET)) {
    const count = counts[key as keyof typeof counts];
    assert.ok(count <= limit, `styles.css: ${key} is ${count}, above ${limit}. Use the variables at the top of styles.css`);
  }
});

test('components use the app\'s own controls, not the browser\'s', () => {
  const files = readdirSync(join(src, 'components')).filter((f) => f.endsWith('.tsx')).map((f) => join('components', f));
  files.push('App.tsx');
  const found: string[] = [];
  for (const file of files) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/<select[\s>]/.test(code)) found.push(`${file}: native <select>, use Popover`);
    if (/\b(?:window\.)?(?:alert|confirm|prompt)\(/.test(code)) found.push(`${file}: native alert/confirm/prompt, use Dialog`);
    if (/\p{Extended_Pictographic}/u.test(code)) found.push(`${file}: emoji, use icons.tsx`);
  }
  assert.deepEqual(found, []);
});
