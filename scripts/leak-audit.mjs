#!/usr/bin/env node
// 泄露审计：隐藏的 <calli-*> 注入块只允许出现在 prompt（事件 data.text）里，
// 不允许出现在用户可见面。只读扫描一个 hub.db，发现泄露时退出码 1，可挂 CI。
//
//   node scripts/leak-audit.mjs [hub.db 路径]
//   缺省扫 $XDG_STATE_HOME/calli/data/hub.db（线上库也能扫，只读打开）。
//   加 --fix：把泄露的 preview 用 askedText 就地洗干净（displayText 不动；设计内卡片不改）。
//
// 设计内可见（不算泄露，单独归类计数）：
// - displayText 里的 <calli-references> 块：排队/重试/复制要保留引用，网页渲染时剥掉
//   （web/src/context-references.ts）。
// - 「来自 … 的结果/任务」交回卡与派活卡：设计就是给用户看的入口。
// - 「# 接手 / # 交回 / 交接」卡：接手简报，设计内可见。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fix = process.argv.includes('--fix');
const positional = process.argv.slice(2).find(a => !a.startsWith('--'));
const dbPath = positional ?? join(process.env.XDG_STATE_HOME ?? join(process.env.HOME, '.local/state'), 'calli/data/hub.db');
const db = new DatabaseSync(dbPath, { readOnly: !fix });

let askedText = null;
if (fix) {
  ({ askedText } = await import(new URL('../packages/daemon/dist/util.js', import.meta.url)));
  if (typeof askedText !== 'function') throw new Error('askedText not found — run npm run build -w @calli/daemon first');
}

const CARD = /^(?:来自 .+ 的(?:结果|任务)|#\s*(?:接手|交回)|来源机器|#\s*交接)/;
const BLOCK = /<calli-[a-z-]+>/;

function scan(label, rows) {
  const leaks = [];
  const allowed = [];
  for (const { id, v } of rows) {
    const s = String(v ?? '');
    if (!BLOCK.test(s)) continue;
    (CARD.test(s) || /^<calli-references>/.test(s) ? allowed : leaks).push({ id, v: s, head: s.slice(0, 100).replace(/\n/g, '⏎') });
  }
  console.log(`${label}: ${rows.length} checked, ${allowed.length} by-design, ${leaks.length} LEAKS`);
  for (const l of leaks.slice(0, 10)) console.log('  LEAK', l.id?.slice(0, 8), JSON.stringify(l.head));
  return { leaks, allowed };
}

const starts = db.prepare("SELECT thread_id, data FROM events WHERE type='turn.started'").all()
  .map(x => { const d = JSON.parse(x.data); return { id: `${x.thread_id}/${d.turnId}`, v: d.displayText }; });
const previews = db.prepare('SELECT id, preview FROM threads WHERE preview IS NOT NULL').all()
  .map(r => ({ id: r.id, v: r.preview }));

const { leaks: displayLeaks } = scan('turn.displayText', starts);
const { leaks: previewLeaks } = scan('thread.preview', previews);

// --fix：预览是「最新一句人话」，用 askedText 洗回人话（与 store 写入时同一函数、同一 80 字截断）。
// displayText 不修：事件按序追加不可变，且泄露为零、设计内卡片靠渲染层剥块。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (fix && previewLeaks.length) {
  const update = db.prepare('UPDATE threads SET preview = ? WHERE id = ?');
  for (const { id, v } of previewLeaks) {
    const clean = askedText(v).trim().slice(0, 80);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try { update.run(clean, id); break; }
      catch (error) { if (attempt === 5) throw error; await sleep(200); }
    }
    console.log('  FIXED', id.slice(0, 8), JSON.stringify(clean));
  }
}

const leaks = displayLeaks.length + (fix ? 0 : previewLeaks.length);
console.log(leaks ? `FAIL: ${leaks} leak(s)` : 'OK: no leaks');
process.exit(leaks ? 1 : 0);
