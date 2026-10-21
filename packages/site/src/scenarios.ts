import { zh as copy } from '../../web/src/i18n/locales/site/zh';

export const SCENARIOS = [
  { id: 'theme', threadId: 'demo-dark-mode', label: '发起一个任务', prompt: '设置页加一个深色模式开关，默认跟随系统。', hint: '看 agent 查找文件、修改代码，再汇报结果。' },
  { id: 'approval', threadId: 'demo-scroll-fix', label: '处理一次审批', prompt: '商品列表往下滚的时候会跳一下，图片加载出来以后更明显。查一下原因并修掉。', hint: '任务需要运行命令时，由你决定是否允许。' },
  { id: 'plan', threadId: 'demo-routes', label: '一起讨论方案', prompt: '想把接口迁到新的路由写法，先出个方案，别动代码。', hint: '回答一个问题，再看看 agent 如何调整方案。' },
  { id: 'collaboration', threadId: 'showcase-team', label: copy.collaboration, prompt: copy.collaborationPrompt, hint: copy.collaborationHint },
] as const;

export const EXAMPLES = [
  { ...SCENARIOS[3], route: '' },
  { id: 'handover', threadId: null, label: copy.handover, hint: copy.handoverHint, route: '#/handover' },
  { id: 'board', threadId: null, label: copy.boardExample, hint: copy.boardHint, route: '#/board' },
  { id: 'memory', threadId: null, label: copy.memoryExample, hint: copy.memoryHint, route: '#/memory' },
  ...SCENARIOS.slice(0, 3).map(s => ({ ...s, route: '' })),
];
export const DEFAULT_EXAMPLE = EXAMPLES[0];
