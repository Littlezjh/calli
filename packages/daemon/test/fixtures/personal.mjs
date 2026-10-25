import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/** A portable coding agent needs only shell execution, its scoped env and the prompt. */
export function personalFixture(text) {
  const command = text.split('\n')[0];
  if (!['personal-ui', 'personal-start', 'personal-notify', 'personal-quiet', 'personal-wish', '由 Limi 发起的事项跟进。', '# 交接信息'].includes(command)) return null;
  if (command === '# 交接信息' && !text.includes('## 关联事项与接续说明')) return null;
  const cli = (args, input = '') => JSON.parse(execFileSync(process.execPath, [join(process.env.LIMI_BIN_DIR, 'limi'), ...args], { input, encoding: 'utf8' }));
  if (command === 'personal-ui') {
    const list = cli(['todo']);
    for (const todo of list.filter(item => item.text === '周五前交报销' || item.text === '确认合同修改')) {
      cli(['todo', 'propose-done', todo.id, '--rev', String(todo.rev), '--evidence-file', '-'], '已核对凭证，等待你确认。');
    }
    for (const text of ['预约护照续签', '查收快递']) cli(['todo', 'add', '--owner', 'me', '--text-file', '-'], text);
    const todo = cli(['todo', 'add', '--owner', 'agent', '--text-file', '-'], '核对报销凭证');
    cli(['todo', 'update', todo.id, '--rev', String(todo.rev), '--note-file', '-'], '## 欠谁什么\n给你整理好报销凭证\n## 定了什么\n只处理本月凭证\n## 做到哪\n已收齐电子发票\n## 下一步\n核对金额与日期');
    cli(['wish', '--text-file', '-'], '顺路看看周末的展览');
    cli(['notify', '--text-file', '-'], '凭证已整理好，等你确认。');
    return '私人计划已整理。';
  }
  if (command === 'personal-start') {
    const todo = cli(['todo', 'add', '--owner', 'me', '--text-file', '-'], 'A lasting commitment');
    const updated = cli(['todo', 'update', todo.id, '--rev', String(todo.rev), '--note-file', '-', '--follow-up', new Date(Date.now() + 3600000).toISOString()], '## 欠谁什么\nFinish the report\n## 定了什么\nKeep it short\n## 做到哪\nDraft ready\n## 下一步\nReview the draft');
    return JSON.stringify(updated);
  }
  if (command === 'personal-notify') { cli(['notify', '--text-file', '-'], 'Invisible notice fixture'); return 'Notice recorded.'; }
  if (command === 'personal-quiet') { cli(['quiet']); return 'Nothing needs attention.'; }
  if (command === 'personal-wish') { cli(['wish', '--text-file', '-'], 'Optional idea'); cli(['quiet']); return 'Saved an optional idea.'; }
  const list = cli(['todo']);
  const id = list.find(item => text.includes(item.id))?.id;
  const todo = cli(['todo', 'show', id]);
  if (command === '由 Limi 发起的事项跟进。' && process.env.FAKE_PERSONAL_FOLLOW_UP_MODE_FILE) {
    const mode = readFileSync(process.env.FAKE_PERSONAL_FOLLOW_UP_MODE_FILE, 'utf8').trim();
    cli(['todo', 'update', id, '--rev', String(todo.rev), '--follow-up', new Date(Date.now() + 3600000).toISOString(),
      ...(mode === 'progress' ? ['--note-file', '-'] : [])], `${todo.note.text}\nProgress made`);
    if (mode === 'error') throw new Error('fixture follow-up failed');
    if (mode !== 'done') cli(['quiet']);
    return 'Follow-up recorded.';
  }
  if (todo.proposals.some(p => p.kind === 'done' && p.state === 'open')) { cli(['quiet']); return 'Already awaiting confirmation.'; }
  if (!todo.note.text.includes('Draft ready')) throw new Error('continuation note missing');
  const next = cli(['todo', 'update', id, '--rev', String(todo.rev), '--note-file', '-'], '## 欠谁什么\nFinish the report\n## 定了什么\nKeep it short\n## 做到哪\nReviewed the draft\n## 下一步\nAwait confirmation');
  const proposal = cli(['todo', 'propose-done', id, '--rev', String(next.rev), '--evidence-file', '-'], 'The draft has been reviewed.');
  return JSON.stringify(proposal);
}
