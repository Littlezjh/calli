import { useState } from 'react';
import type { AgentInfo, SlashCommand } from '../api';
import { IconBack, IconBolt, IconCheck, IconChevron, IconList, IconPaperclip, IconSparkle, IconTarget } from './icons';

export type GoalCapability = NonNullable<AgentInfo['capabilities']['goal']>;
export type GoalAction = NonNullable<GoalCapability['actions']>[number];

interface Props {
  commands: SlashCommand[];
  planMode?: { active: boolean; disabled: boolean; onChange: (active: boolean) => void };
  goal?: GoalCapability;
  running: boolean;
  attachTitle: string;
  onAttach: () => void;
  onBrowse: (section: 'actions' | 'skills') => void;
  onGoal: (action: GoalAction) => void;
  close: () => void;
}

export const GOAL_LABELS: Record<GoalAction, string> = {
  set: '设置目标', show: '查看目标', pause: '暂停目标', resume: '继续目标', clear: '清除目标',
};
/** A compact phone menu. Browsing opens the composer's full-width command palette. */
export function ComposerMenu({ commands, planMode, goal, running, attachTitle, onAttach, onBrowse, onGoal, close }: Props) {
  const [page, setPage] = useState<'home' | 'goal'>('home');
  const unknownKinds = commands.some(c => !c.kind);
  const skillTitle = unknownKinds ? '技能与命令' : '技能';
  const pick = (action: () => void) => { close(); action(); };

  if (page === 'home') return <div className="composer-menu-list">
    <button type="button" role="menuitem" className="pop-item" title={attachTitle} onClick={() => pick(onAttach)}>
      <span className="pop-item-icon"><IconPaperclip size={19} /></span><span className="pop-item-label">添加图片或视频</span>
    </button>
    {(planMode || goal) && <div className="pop-divider" />}
    {planMode && <button type="button" role="menuitemcheckbox" aria-checked={planMode.active} className="pop-item" disabled={planMode.disabled}
      title={planMode.disabled ? '当前轮结束后可切换模式' : planMode.active ? '关闭计划模式，继续执行任务' : '先分析和讨论方案'}
      onClick={() => pick(() => planMode.onChange(!planMode.active))}>
      <span className="pop-item-icon"><IconList size={19} /></span>
      <span className="pop-item-text"><span className="pop-item-label">计划模式</span></span>
      {planMode.active && <span className="pop-item-check"><IconCheck size={16} /></span>}
    </button>}
    {goal && <button type="button" role="menuitem" className="pop-item" onClick={() => setPage('goal')}>
      <span className="pop-item-icon"><IconTarget size={19} /></span>
      <span className="pop-item-text"><span className="pop-item-label">目标模式</span></span><IconChevron size={14} />
    </button>}
    <div className="pop-divider" />
    <button type="button" role="menuitem" className="pop-item" onClick={() => pick(() => onBrowse('actions'))}>
      <span className="pop-item-icon"><IconBolt size={19} /></span><span className="pop-item-text"><span className="pop-item-label">操作</span></span><IconChevron size={14} />
    </button>
    <button type="button" role="menuitem" className="pop-item" onClick={() => pick(() => onBrowse('skills'))}>
      <span className="pop-item-icon"><IconSparkle size={19} /></span><span className="pop-item-text"><span className="pop-item-label">{skillTitle}</span></span><IconChevron size={14} />
    </button>
  </div>;

  return <>
    <div className="composer-menu-heading"><button type="button" className="icon-btn" aria-label="返回添加菜单" onClick={() => setPage('home')}><IconBack size={18} /></button><span>目标模式</span></div>
    {goal && <div className="composer-menu-list">
      {(goal.actions ?? ['set', ...goal.controls]).map(action => {
        const starts = action === 'set' || action === 'resume';
        const blocked = running ? !goal.controls.some(c => c === action) : starts && planMode?.active;
        return <button type="button" role="menuitem" className="pop-item" key={action} disabled={!!blocked} onClick={() => pick(() => onGoal(action))}>
          <span className="pop-item-text"><span className="pop-item-label">{GOAL_LABELS[action]}</span>{blocked && <small className="pop-item-hint">{running ? '当前轮结束后可操作' : '先关闭计划模式'}</small>}</span>
        </button>;
      })}
    </div>}
  </>;
}
