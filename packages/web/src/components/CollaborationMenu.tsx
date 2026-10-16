import { useState, type ReactNode } from 'react';
import type { AgentMention } from '../api';
import { AgentMark, IconBack, IconCheck, IconSettings } from './icons';

interface Props {
  options: AgentMention[];
  selected: AgentMention[];
  icon: (mention: AgentMention) => string | undefined;
  onSelect: (mention: AgentMention) => void;
  settings: ReactNode;
  unavailable: string;
}

/** Choosing a collaborator and configuring defaults are separate actions. */
export function CollaborationMenu({ options, selected, icon, onSelect, settings, unavailable }: Props) {
  const [page, setPage] = useState<'choose' | 'settings'>('choose');
  return <div className="coord-picker">
    <div className="coord-picker-head">
      {page === 'settings' && <button type="button" className="icon-btn" aria-label="返回选择智能体" onClick={() => setPage('choose')}><IconBack size={18} /></button>}
      <strong>{page === 'settings' ? '协作设置' : '选择协作智能体'}</strong>
      {page === 'choose' && <button type="button" className="tool-btn" onClick={() => setPage('settings')}><IconSettings size={16} /><span>协作设置</span></button>}
    </div>
    {page === 'settings' ? settings : <>
      <p className="coord-picker-hint">选择后填写给它的任务，发送时一起交给主智能体。</p>
      <div className="coord-picker-list">
        {(['member', 'agent'] as const).map(kind => <div key={kind}>
          {options.some(m => m.kind === kind) && <div className="coord-caption">{kind === 'member' ? '当前成员' : '添加助手'}</div>}
          {options.filter(m => m.kind === kind).map(m => {
            const chosen = selected.some(v => v.id === m.id && v.kind === m.kind);
            const mark = icon(m);
            return <button type="button" role="menuitem" className={`pop-item coord-pick${chosen ? ' chosen' : ''}`} key={`${m.kind}:${m.id}`} aria-label={`给 ${m.label} 分配任务`} onClick={() => onSelect(m)}>
              <span className="pop-item-icon">{mark && <AgentMark path={mark} size={19} />}</span>
              <span className="pop-item-text"><span className="pop-item-label">{m.label}</span><small className="pop-item-hint">{chosen ? '已选 · 继续填写任务' : kind === 'member' ? '给当前成员追加任务' : '选择并填写任务'}</small></span>
              {chosen && <span className="pop-item-check"><IconCheck size={16} /></span>}
            </button>;
          })}
        </div>)}
        {!options.length && <p className="pop-note">{unavailable}</p>}
      </div>
    </>}
  </div>;
}
