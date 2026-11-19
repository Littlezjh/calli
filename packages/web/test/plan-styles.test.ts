import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The conversation's plan list and the assistant's hours-to-month panel both grew out of names
// like .plan-list, and the panel's card rules sat further down the file, silently clobbering the
// conversation's (docs/design/plan-progress-playground.html). The panel's rules now live scoped
// under its own .plan-view class; this keeps them there.

const css = readFileSync(join(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8');

/** Class names only the assistant's plan panel (PlanView) uses. */
const PANEL_ONLY = ['ranges', 'group', 'state', 'meta', 'row', 'more', 'skeleton'];

test('the plan panel keeps its styles scoped under .plan-view', () => {
  const offenders: string[] = [];
  for (const line of css.split('\n')) {
    const selector = line.replace(/\{.*$/, '');
    if (selector.includes('.plan-view')) continue;
    if (PANEL_ONLY.some((c) => selector.includes(`.plan-${c}`))) offenders.push(line.trim());
  }
  assert.deepEqual(offenders, []);
});
