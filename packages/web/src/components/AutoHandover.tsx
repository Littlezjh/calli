import { useEffect, useState } from 'react';
import type { AgentInfo, Api, AutoHandoverView, HandoverSettings, HandoverTarget, ModelOption, Thread } from '../api';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { Popover } from './Popover';
import { AgentPicker } from './Pickers';
import { AgentMark, IconChevron, IconGrip, IconMore } from './icons';

export function AutoHandoverChoice({ api, thread }: { api: Api; thread: Thread }) {
  const [value, setValue] = useState<AutoHandoverView | undefined>(thread.autoHandover);
  const [error, setError] = useState('');
  useEffect(() => { setValue(thread.autoHandover); }, [thread.autoHandover]);
  if (api.demo) return null;
  return <div className="auto-choice">
    <span>{t('auto.title')}</span>
    <Popover triggerClassName="context-btn" label={t('auto.title')} trigger={<>{value ? t(value.enabled ? 'auto.on' : 'auto.off') : t('common.loading')} · {value && t(`auto.source.${value.source}`)}</>}>
      {close => <div role="menu">{([null, true, false] as const).map(enabled => <button type="button" className="pop-item compact" role="menuitemradio" aria-checked={value?.override === enabled} key={String(enabled)} onClick={() => {
        void api.setAutoHandover(thread.id, enabled).then(v => { setValue(v); setError(''); close(); }).catch(e => setError(String(e)));
      }}>{t(enabled === null ? 'auto.inherit' : enabled ? 'auto.on' : 'auto.off')}</button>)}</div>}
    </Popover>
    {error && <span role="alert" className="panel-error">{error}</span>}
  </div>;
}

export function AutoHandoverNotice({ api, thread, agents }: { api: Api; thread: Thread; agents: AgentInfo[] }) {
  const state = thread.autoHandover;
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  useEffect(() => {
    if (state?.state !== 'countdown') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [state?.state, state?.deadline]);
  if (!state?.state || state.state === 'checking') return null;
  const target = state.target;
  const label = target ? [agents.find(a => a.id === target.agent)?.label ?? target.agent, target.model].filter(Boolean).join(' · ') : '';
  return <div className="auto-notice" role={state.state === 'failed' || state.state === 'stopped' ? 'alert' : 'status'}>
    <span>{state.state === 'countdown' ? t('auto.countdown', label, Math.max(0, Math.ceil((Date.parse(state.deadline!) - now) / 1000)))
      : state.state === 'preparing' ? t('auto.preparing') : state.state === 'stopped' ? t('auto.stopped') : t('auto.failed')}
      {state.error && <small>{state.error}</small>}{error && <small role="alert">{error}</small>}</span>
    {(state.state === 'preparing' || state.state === 'countdown') && <button className="ghost" onClick={() => { void api.cancelAutoHandover(thread.id).catch(e => setError(String(e))); }}>{t('auto.cancel')}</button>}
  </div>;
}

function AddTarget({ api, agents, add }: { api: Api; agents: AgentInfo[]; add: (target: HandoverTarget) => void }) {
  const [agent, setAgent] = useState(agents[0]?.id ?? '');
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; setModels(null); setModel(''); setError('');
    void api.models(agent).then(m => { if (alive) setModels(m); }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [api, agent]);
  return <div className="auto-add">
    <AgentPicker agents={agents} value={agent} onChange={setAgent} />
    <Popover triggerClassName="context-btn" label={t('auto.modelDefault')} trigger={models?.find(m => m.id === model)?.label ?? t('auto.modelDefault')}>
      {close => <div role="menu">
        <button className="pop-item compact" role="menuitemradio" aria-checked={!model} onClick={() => { setModel(''); close(); }}>{t('auto.modelDefault')}</button>
        {models?.map(m => <button className="pop-item compact" role="menuitemradio" aria-checked={model === m.id} key={m.id} onClick={() => { setModel(m.id); close(); }}>{m.label}</button>)}
        {!models && !error && <p>{t('common.loading')}</p>}{error && <p role="alert">{error}</p>}
      </div>}
    </Popover>
    <button className="ghost" onClick={() => add({ agent, ...(model ? { model } : {}) })}>{t('auto.add')}</button>
  </div>;
}

export function HandoverSettingsDialog({ api, agents, onClose }: { api: Api; agents: AgentInfo[]; onClose: () => void }) {
  const [value, setValue] = useState<HandoverSettings | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [opened, setOpened] = useState('');
  const [dragged, setDragged] = useState<number | null>(null);
  const load = () => { setError(''); void api.handoverSettings().then(setValue).catch(e => setError(String(e))); };
  useEffect(load, [api]);
  const setOrder = (id: string, list: HandoverTarget[]) => setValue(v => v && ({ ...v, orders: { ...v.orders, [id]: list } }));
  const label = (target: HandoverTarget) => [agents.find(a => a.id === target.agent)?.label ?? target.agent, target.model].filter(Boolean).join(' · ');
  const move = (id: string, from: number, to: number) => {
    const order = [...(value?.orders[id] ?? [])];
    if (to < 0 || to >= order.length) return;
    order.splice(to, 0, order.splice(from, 1)[0]); setOrder(id, order);
  };
  return <Dialog title={t('auto.title')} confirmLabel={t('auto.save')} className="auto-settings" onCancel={() => { if (!saving) onClose(); }} confirmDisabled={!value || saving || value.threshold < 1 || value.threshold > 99} onConfirm={() => {
    if (!value) return; setSaving(true); void api.saveHandoverSettings(value).then(onClose).catch(e => setError(String(e))).finally(() => setSaving(false));
  }}>
    {error && <p className="panel-error" role="alert">{error} {!value && <button onClick={load}>{t('common.retry')}</button>}</p>}
    {!value && !error && <p>{t('common.loading')}</p>}
    {value && <>
      <div className="auto-setting-line"><span>{t('auto.global')}</span><button aria-label={t('auto.global')} className="auto-toggle" role="switch" aria-checked={value.enabled} onClick={() => setValue({ ...value, enabled: !value.enabled })}>{t(value.enabled ? 'auto.on' : 'auto.off')}</button></div>
      <label className="auto-setting-line">{t('auto.threshold')}<input inputMode="numeric" value={value.threshold} onChange={e => setValue({ ...value, threshold: Number(e.target.value) })} /></label>
      <div className="auto-orders">{agents.map(agent => {
        const order = value.orders[agent.id];
        return <section key={agent.id}>
          <button className="auto-order-head" aria-expanded={opened === agent.id} onClick={() => setOpened(opened === agent.id ? '' : agent.id)}>
            <strong>{agent.label}</strong><span>{order ? order.map(label).join(' → ') || t('auto.noTargets') : t('auto.defaultOrder')}</span><IconChevron size={14} open={opened === agent.id} />
          </button>
          {opened === agent.id && <div className="auto-order-edit">
            <ol aria-label={t('auto.order')}>{order?.map((target, i) => <li key={`${target.agent}:${target.model}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (dragged !== null) move(agent.id, dragged, i); setDragged(null); }}>
              <span className="auto-order-grip" draggable onDragStart={() => setDragged(i)} onDragEnd={() => setDragged(null)} title={t('auto.drag')}><IconGrip size={16} /></span>
              {agents.find(a => a.id === target.agent)?.icon && <AgentMark path={agents.find(a => a.id === target.agent)!.icon!} size={16} />}
              <span className="auto-order-name">{label(target)}</span>
              <Popover triggerClassName="icon-btn auto-order-more" panelClassName="auto-order-menu" label={t('auto.targetActions', label(target))} triggerLabel={t('auto.targetActions', label(target))} trigger={<IconMore size={16} />} align="end" placement="below">
                {close => <div role="menu">
                  <button className="pop-item compact" role="menuitem" disabled={!i} onClick={() => { move(agent.id, i, i - 1); close(); }}>{t('auto.up')}</button>
                  <button className="pop-item compact" role="menuitem" disabled={i === order.length - 1} onClick={() => { move(agent.id, i, i + 1); close(); }}>{t('auto.down')}</button>
                  <button className="pop-item compact" role="menuitem" onClick={() => { setOrder(agent.id, order.filter((_, n) => n !== i)); close(); }}>{t('auto.remove')}</button>
                </div>}
              </Popover>
            </li>)}</ol>
            <AddTarget api={api} agents={agents} add={target => { if (!order?.some(t => t.agent === target.agent && t.model === target.model)) setOrder(agent.id, [...(order ?? []), target]); }} />
            {order && <button className="text-btn" onClick={() => { const orders = { ...value.orders }; delete orders[agent.id]; setValue({ ...value, orders }); }}>{t('auto.reset')}</button>}
          </div>}
        </section>;
      })}</div>
    </>}
  </Dialog>;
}
