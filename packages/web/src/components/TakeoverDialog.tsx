import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, Api, HandoverTarget, ReturnTarget, Thread } from '../api';
import { ReturnSwitch } from './AutoHandover';
import { AgentPicker } from './Pickers';
import { IconHand } from './icons';
import { t } from '../i18n';

interface Props {
  api: Api;
  thread: Thread;
  agents: AgentInfo[];
  /** Hands the thread over; resolves once the successor is open. */
  onTakeOver: (target: HandoverTarget, summary: 'source' | HandoverTarget, returnTo?: string) => Promise<void>;
  onClose: () => void;
}

type Writer = 'source' | 'other';

/**
 * The person starts the handover now: who takes over, and who writes the summary it carries — the
 * thread's own agent when it can still answer, or another agent reading the record when it cannot.
 */
export function TakeoverDialog({ api, thread, agents, onTakeOver, onClose }: Props) {
  const usable = (id: string) => agents.some(a => a.id === id && a.available && !a.hidden);
  const [target, setTarget] = useState<HandoverTarget>(() => ({ agent: agents.find(a => a.id !== thread.agent && a.available && !a.hidden)?.id ?? '' }));
  // A thread that stopped on an error most likely ran out of plan: its own agent cannot write.
  const [writer, setWriter] = useState<Writer>(thread.status === 'error' ? 'other' : 'source');
  const [compressor, setCompressor] = useState<HandoverTarget | null>(null);
  // An earlier conversation of the chain that could take the work back, offered beside a new one.
  const [returns, setReturns] = useState<ReturnTarget[]>([]);
  // A person is here to choose: a new conversation unless they say the older one.
  const [backToOld, setBackToOld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  useEffect(() => {
    if (api.demo) return;
    let active = true;
    void api.autoHandover(thread.id).then(v => { if (!active) return; if (v.targets[0]) setTarget(v.targets[0]); setReturns(v.returns ?? []); }).catch(() => undefined);
    void api.autoCompactSettings().then(v => { if (active && v.settings.agents[0]) setCompressor(c => c ?? v.settings.agents[0]); }).catch(() => undefined);
    return () => { active = false; };
  }, [api, thread.id]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busyRef.current && !document.querySelector('.pop-panel')) onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  // Without a compression agent set up, the successor writes the summary of its own takeover.
  const other = compressor ?? (target.agent ? { agent: target.agent } : null);
  const label = (id: string) => agents.find(a => a.id === id)?.label ?? id;
  const toOld = backToOld && returns.length > 0;
  const ready = (toOld ? true : usable(target.agent) && (target.agent !== thread.agent || !!target.model))
    && (writer === 'source' || !!other && usable(other.agent));

  const start = async () => {
    if (!ready || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await onTakeOver(toOld ? { agent: returns[0].agent } : target, writer === 'source' ? 'source' : other!, toOld ? returns[0].threadId : undefined);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="dialog-scrim" onClick={() => { if (!busyRef.current) onClose(); }}>
      <div className="dialog handover" role="dialog" aria-modal="true" aria-labelledby="takeover-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="takeover-title" className="dialog-title">{t('takeover.title')}</h2>
        <p className="dialog-message">{t('takeover.message')}</p>
        <fieldset className="takeover-fields" disabled={busy}>
          {!toOld && <div className="handover-successor">
            <span>{t('handover.successor')}</span>
            <AgentPicker api={api} agents={agents} value={target.agent} onChange={id => setTarget({ agent: id })} />
          </div>}
          {returns.length > 0 && <ReturnSwitch old={returns[0]} agentLabel={label(returns[0].agent)} toOld={toOld} onChange={setBackToOld} disabled={busy} />}
          <div className="handover-successor">
            <span id="takeover-writer">{t('takeover.writer')}</span>
            <div className="chip-row" role="radiogroup" aria-labelledby="takeover-writer">
              {(['source', 'other'] as const).map(w => <button key={w} type="button" className={`chip${writer === w ? ' on' : ''}`} role="radio" aria-checked={writer === w}
                onClick={() => setWriter(w)}>{t(w === 'source' ? 'takeover.writerSource' : 'takeover.writerOther')}</button>)}
            </div>
          </div>
          {writer === 'other' && <div className="handover-successor">
            <span>{t('takeover.compressor')}</span>
            <AgentPicker api={api} agents={agents} value={other?.agent ?? ''} onChange={id => setCompressor({ agent: id })} />
          </div>}
        </fieldset>
        <p className="handover-note" role="status">
          {busy ? (writer === 'source' ? t('takeover.writingSource', label(thread.agent)) : t('takeover.writingOther', label(other?.agent ?? '')))
            : target.agent === thread.agent && !target.model ? t('takeover.sameAgent')
            : writer === 'source' ? t('takeover.sourceHint') : t('takeover.otherHint')}
        </p>
        {error && <p className="panel-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>{t('common.close')}</button>
          <button className="primary" onClick={() => void start()} disabled={!ready || busy}>
            <IconHand size={15} /> {busy ? t('view.handingOver') : t('takeover.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
