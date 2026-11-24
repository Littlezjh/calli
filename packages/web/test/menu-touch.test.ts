import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/Menu.tsx', import.meta.url), 'utf8');
const between = (start: string, end: string) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source boundary ${start}`);
  return source.slice(from, to);
};
const tracking = between('const ARM_DELAY_MS =', '\n/**\n * A menu with icons');
const arming = between('  useEffect(() => {\n    if (armed) return;', '  const branches:');

type Input = { type: string; pointerType?: string; pointerId?: number; touches?: unknown[]; cancelable?: boolean };

function fixture() {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const timers = new Map<number, { at: number; run: () => void }>();
  let now = 0, next = 0, cleanup = () => {}, armed = false;
  const context = {
    document: {
      addEventListener: (type: string, run: (event: any) => void) => listeners.set(type, [...listeners.get(type) ?? [], run]),
      removeEventListener: (type: string, run: (event: any) => void) => listeners.set(type, (listeners.get(type) ?? []).filter(value => value !== run)),
    },
    window: {
      setTimeout: (run: () => void, delay: number) => { const id = ++next; timers.set(id, { at: now + delay, run }); return id; },
      clearTimeout: (id: number) => timers.delete(id),
    },
    armed: false,
    setArmed: (value: boolean) => { armed = value; },
    useEffect: (run: () => (() => void)) => { cleanup = run(); },
  };
  const js = ts.transpileModule(tracking + arming, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const fingers = new Function('context', `with (context) { ${js}; return () => fingers; }`)(context) as () => number;
  const fire = (input: Input) => {
    let prevented = false, stopped = false;
    const event = { cancelable: true, ...input, preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } };
    for (const run of listeners.get(event.type) ?? []) { run(event); if (stopped) break; }
    return { prevented, stopped };
  };
  const tick = (elapsed: number) => {
    now += elapsed;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
  };
  return { fire, tick, fingers, armed: () => armed, cleanup: () => cleanup(), timers };
}

// A detached touch target cannot bubble touchend, but connected pointerup must release the menu after its usual delay.
test('touch pointer release arms after the unchanged delay without document touchend', () => {
  const f = fixture();
  f.fire({ type: 'pointerdown', pointerType: 'touch', pointerId: 1 });
  f.fire({ type: 'touchstart', touches: [{}] });
  f.fire({ type: 'pointerup', pointerType: 'touch', pointerId: 1 });
  assert.equal(f.fingers(), 0); assert.equal(f.armed(), false);
  for (const type of ['mousedown', 'mouseup', 'click']) assert.deepEqual(f.fire({ type }), { prevented: true, stopped: true });
  f.tick(399); assert.equal(f.armed(), false);
  f.tick(1); assert.equal(f.armed(), true);
});

// A pointer cancellation must also reset the module-level count used by the next menu's initial state.
test('touch pointer cancellation clears stale fingers for later menus', () => {
  const f = fixture();
  f.fire({ type: 'pointerdown', pointerType: 'touch', pointerId: 1 });
  f.fire({ type: 'touchstart', touches: [{}] });
  f.fire({ type: 'pointercancel', pointerType: 'touch', pointerId: 1 });
  f.tick(400); assert.equal(f.armed(), true); assert.equal(f.fingers(), 0);
  f.fire({ type: 'pointerdown', pointerType: 'touch', pointerId: 2 });
  assert.equal(f.fingers(), 1);
  f.fire({ type: 'pointerup', pointerType: 'touch', pointerId: 2 });
  assert.equal(f.fingers(), 0);
});

// One lifted finger is not enough: the last active touch pointer must release before the delay starts.
test('multiple touch pointers never arm while another finger remains down', () => {
  const f = fixture();
  f.fire({ type: 'pointerdown', pointerType: 'touch', pointerId: 1 });
  f.fire({ type: 'pointerdown', pointerType: 'touch', pointerId: 2 });
  f.fire({ type: 'pointerup', pointerType: 'touch', pointerId: 1 });
  f.tick(1000); assert.equal(f.armed(), false); assert.equal(f.fingers(), 1);
  f.fire({ type: 'pointercancel', pointerType: 'touch', pointerId: 2 });
  f.tick(400); assert.equal(f.armed(), true); assert.equal(f.fingers(), 0);
});

// A new press during the compatibility-click window must defer arming until that press has also ended.
test('a new finger during the arming delay does not enable the menu under that finger', () => {
  const f = fixture();
  f.fire({ type: 'pointerdown', pointerType: 'touch', pointerId: 1 });
  f.fire({ type: 'pointerup', pointerType: 'touch', pointerId: 1 });
  f.tick(200);
  f.fire({ type: 'pointerdown', pointerType: 'touch', pointerId: 2 });
  f.tick(200); assert.equal(f.armed(), false);
  f.fire({ type: 'pointerup', pointerType: 'touch', pointerId: 2 });
  f.tick(399); assert.equal(f.armed(), false);
  f.tick(1); assert.equal(f.armed(), true);
});

// Mouse and pen releases cannot override the touch finger that originally opened the menu.
test('non-touch pointer release cannot arm or change touch tracking', () => {
  const f = fixture();
  f.fire({ type: 'pointerdown', pointerType: 'touch', pointerId: 1 });
  for (const pointerType of ['mouse', 'pen']) f.fire({ type: 'pointerup', pointerType, pointerId: 2 });
  f.tick(1000); assert.equal(f.armed(), false); assert.equal(f.fingers(), 1);
});

// Existing touch-only browsers still release normally, and disposal removes timers/listeners for this menu.
test('legacy touch release remains supported and cleanup cannot arm an unmounted menu', () => {
  const f = fixture();
  f.fire({ type: 'touchstart', touches: [{}] });
  f.fire({ type: 'touchend', touches: [] });
  assert.equal(f.fingers(), 0); f.tick(400); assert.equal(f.armed(), true);
  const disposed = fixture();
  disposed.fire({ type: 'pointerdown', pointerType: 'touch', pointerId: 1 });
  disposed.fire({ type: 'pointerup', pointerType: 'touch', pointerId: 1 });
  disposed.cleanup(); disposed.tick(400);
  assert.equal(disposed.armed(), false); assert.equal(disposed.timers.size, 0);
  assert.deepEqual(disposed.fire({ type: 'click' }), { prevented: false, stopped: false });
});
