import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Deliberately use the same CLI a real agent would execute, with its injected environment.
export function coordinationFixture(text) {
  const body = text.split('<limi-coordination>')[0].trim();
  if (body.endsWith('LIMI_REPORT')) return '文档审查完成。\n\n已检查接口约定、目录分工和异常处理。建议补充重启后的恢复步骤，测试覆盖其余预期行为。';
  if (body === 'LIMI_ENV') return `limi-ready:${Boolean(process.env.LIMI_SOCKET && process.env.LIMI_KEY)};cwd:${process.cwd()}`;
  const command = /LIMI_COMMAND:([A-Za-z0-9+/=]+)/.exec(body);
  if (command && !body.startsWith('[协作消息')) {
    const { args, text: message = '' } = JSON.parse(Buffer.from(command[1], 'base64').toString());
    return execFileSync('limi', args, { input: message, encoding: 'utf8' }).trim();
  }
  if (body.endsWith('LIMI_WRITE')) {
    writeFileSync('review-document.md', '# Design\n\nFirst draft.\n');
    execFileSync('limi', ['send', 'reviewer', '--message-file', '-', '--request-id', 'review-draft'], { input: 'LIMI_REVIEW', encoding: 'utf8' });
    return '文档初稿已写入 review-document.md，已请求审查。';
  }
  if (body.endsWith('LIMI_REVIEW')) return `审查完成：${readFileSync('review-document.md', 'utf8').includes('First draft') ? '请补充异常处理。' : '未找到初稿。'}`;
  if (body.includes('请补充异常处理。') && body.startsWith('[协作消息')) {
    writeFileSync('review-document.md', '# Design\n\nFirst draft.\n\n## Errors\nReport failures.\n');
    return '已根据审查补充异常处理。';
  }
  if (body.startsWith('[协作消息') && body.includes('状态：')) return '已收到成员结果，将继续检查并汇总。';
  if (body.startsWith('请审查接口文档')) return '已收到协作要求。';
  return null;
}
