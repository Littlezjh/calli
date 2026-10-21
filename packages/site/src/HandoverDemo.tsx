import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AutoHandoverNotice } from '../../web/src/components/AutoHandover';
import { ThreadView } from '../../web/src/components/ThreadView';
import { AgentMark, IconArrowRight, IconChevron, IconHandover, IconRestore, IconSidebar } from '../../web/src/components/icons';
import { CLAUDE_ICON } from '../../daemon/src/adapters/icons';
import { buildTimeline } from '../../web/src/timeline';
import type { AgentInfo } from '../../web/src/api';
import type { Theme } from '../../web/src/appearance';
import { zh as copy } from '../../web/src/i18n/locales/site/zh';
import { HandoverShowcaseApi, type HandoverBranch } from './ShowcaseApi';

const agents = [
  { id: 'claude', label: 'Claude Code', icon: CLAUDE_ICON },
  { id: 'sample-claude-2', label: 'Claude Code 2', icon: CLAUDE_ICON },
] as AgentInfo[];
const unavailable = async (): Promise<Blob> => { throw new Error(copy.demoNote); };

/** Uses the product's timeline and countdown, with a small, task-specific demo shell. */
export function HandoverDemo({ theme, onInstall }: { theme: Theme; onInstall: () => void }) {
  const [api] = useState(() => new HandoverShowcaseApi());
  const state = useSyncExternalStore(api.subscribe, api.snapshot);
  const [chainOpen, setChainOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [iteration, setIteration] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const source = useMemo(() => buildTimeline(state.sourceEvents), [state.sourceEvents]);
  const next = useMemo(() => buildTimeline(state.nextEvents), [state.nextEvents]);
  const transferred = state.phase === 'completed' && state.branch === 'account';
  const finished = ['completed', 'cancelled'].includes(state.phase);
  const currentLabel = agents.find(a => a.id === state.current.agent)!.label;
  useEffect(() => () => api.dispose(), [api]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (state.phase === 'completed') scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [state.phase, chainOpen]);
  const reset = (branch?: HandoverBranch) => { api.reset(branch); setSummaryOpen(false); setChainOpen(false); setIteration(n => n + 1); };
  return <div className="showcase-handover">
    <div className="showcase-notice demo-bar" role="note"><span>{copy.handoverDemoNote}</span><button className="showcase-text-button" onClick={onInstall}>{copy.install}<IconArrowRight size={14} /></button></div>
    <div className="showcase-handover-body">
      <aside className="showcase-handover-sidebar" aria-label={copy.handoverSidebar}>
        <div className={`handover-group${chainOpen ? ' open' : ''}`}>
          <button className="showcase-handover-chain" aria-expanded={chainOpen} onClick={() => setChainOpen(!chainOpen)}>
            <span className="showcase-handover-marks"><AgentMark path={CLAUDE_ICON} size={20} />{transferred && <AgentMark path={CLAUDE_ICON} size={20} />}</span>
            <span><strong>{copy.handoverThread}</strong><small>{currentLabel}</small></span>
            {transferred ? <IconHandover size={16} /> : <IconSidebar size={16} />}<IconChevron size={12} open={chainOpen} />
          </button>
          {chainOpen && <div className="handover-members handover-chain">
            <button className="handover-member" onClick={() => scroll.current?.scrollTo({ top: 0 })}><span className="dot idle" /><AgentMark path={CLAUDE_ICON} size={16} /><span className="handover-member-name">Claude Code</span><span className="handover-member-role">{copy.handoverSource}</span></button>
            {transferred && <button className="handover-member active" onClick={() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight })}><span className="dot idle" /><AgentMark path={CLAUDE_ICON} size={16} /><span className="handover-member-name">Claude Code 2</span><span className="handover-member-role">{copy.handoverSuccessor}</span></button>}
          </div>}
        </div>
        <p>{copy.handoverModelNote}</p>
      </aside>
      <main className="showcase-handover-main">
        <header className="showcase-handover-head"><span>{currentLabel}<small>{state.current.model}</small></span><span className="showcase-quota" title={copy.handoverQuota} data-low={state.phase !== 'completed'}><span>{state.phase === 'completed' ? copy.handoverQuota : copy.handoverNear}</span><span className="showcase-quota-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.phase === 'completed' ? 12 : 94} aria-label={copy.handoverQuota}><span style={{ width: state.phase === 'completed' ? '12%' : '94%' }} /></span>{state.phase === 'completed' ? '12%' : '94%'}</span></header>
        <div className="scroller" ref={scroll}>
          {state.phase === 'ready' && <div className="showcase-intro"><div className="showcase-intro-icon"><IconHandover size={28} /></div><h2>{copy.handoverTitle}</h2><p>{copy.handoverHint}</p></div>}
          <ThreadView key={`source-${iteration}`} historyApi={api} historyThreadId={state.source.id} items={source.items} roots={[]} loadImage={unavailable} loadFile={unavailable} />
          <AutoHandoverNotice api={api} thread={state.current} agents={agents} />
          {transferred && <div className="row handover-boundary">
            <button className="context-compaction handover-divider" aria-expanded={summaryOpen} onClick={() => setSummaryOpen(!summaryOpen)}><IconHandover size={16} /><span>{copy.handoverFrom} · {copy.handoverNear}</span><IconChevron size={12} open={summaryOpen} /></button>
            {summaryOpen && <div className="handover-summary">{copy.handoverSummaryText}</div>}
          </div>}
          <ThreadView key={`next-${iteration}`} historyApi={api} historyThreadId={state.current.id} items={next.items} roots={[]} loadImage={unavailable} loadFile={unavailable} />
          {state.phase === 'cancelled' && <p className="showcase-handover-status" role="status">{copy.handoverCancelled}</p>}
        </div>
        <div className="showcase-handover-controls">
          <div className="showcase-handover-branches" role="group" aria-label={copy.chooseTask}>
            <button aria-pressed={state.branch === 'account'} onClick={() => reset('account')}>{copy.handoverAccountBranch}</button>
            <button aria-pressed={state.branch === 'model'} onClick={() => reset('model')}>{copy.handoverModelBranch}</button>
          </div>
          <div className="showcase-handover-action"><span>{finished ? state.phase === 'cancelled' ? copy.handoverCancelled : copy.handoverDone : copy.handoverHint}</span>
            {state.phase === 'ready' ? <button className="primary" onClick={() => api.start()}>{copy.handoverStart}<IconArrowRight size={15} /></button> : <button className="ghost" onClick={() => reset()}><IconRestore size={15} />{copy.restart}</button>}
          </div>
        </div>
      </main>
    </div>
  </div>;
}
