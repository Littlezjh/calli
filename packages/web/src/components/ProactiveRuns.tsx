import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Api, ProactiveAction, ProactiveFile, ProactiveRun, Todo } from '../api';
import { t } from '../i18n';
import { diffTotals, fileName, proactiveMatters, replaceRun, runControls } from '../proactive';
import { Dialog, DialogSurface } from './Dialog';
import { IconFile, IconSparkle } from './icons';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface ProactiveState {
  /** null until asked for and answered. */
  runs: ProactiveRun[] | null;
  error: string;
  load: () => void;
  /** The action in flight, per run. */
  pending: Record<string, ProactiveAction>;
  /** Why the last action on a run failed; the buttons stay, so it can be tried again. */
  failures: Record<string, string>;
  act: (run: ProactiveRun, action: ProactiveAction) => void;
}

/** Her runs, read only for what is on screen: one matter's (`scope` its id), all of them (''), or none (null). */
export function useProactive(api: Api, scope: string | null, refreshKey: number): ProactiveState {
  const [runs, setRuns] = useState<ProactiveRun[] | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Record<string, ProactiveAction>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const asked = useRef(0);
  const load = useCallback(() => {
    const ticket = ++asked.current;
    setError('');
    void api.proactive(scope || undefined).then(value => { if (ticket === asked.current) setRuns(value.runs); }).catch(e => { if (ticket === asked.current) setError(message(e)); });
  }, [api, scope]);
  useEffect(() => { asked.current++; setRuns(null); setError(''); }, [scope]);
  useEffect(() => { if (scope !== null) load(); }, [scope, refreshKey, load]);
  const act = (run: ProactiveRun, action: ProactiveAction) => {
    if (pending[run.id]) return;
    setPending(now => ({ ...now, [run.id]: action }));
    setFailures(({ [run.id]: _gone, ...rest }) => rest);
    void api.proactiveAct(run.id, action)
      // An answer to a read begun before the action is out of date.
      .then(next => { asked.current++; setRuns(now => now && replaceRun(now, next)); })
      .catch(e => { setFailures(now => ({ ...now, [run.id]: message(e) })); load(); })
      .finally(() => setPending(({ [run.id]: _done, ...rest }) => rest));
  };
  return { runs, error, load, pending, failures, act };
}

/** The changed files with their line counts. The list is only read once this opens. */
function DiffDialog({ api, run, onClose }: { api: Api; run: ProactiveRun; onClose: () => void }) {
  const [files, setFiles] = useState<ProactiveFile[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    void api.proactiveDiff(run.id).then(value => { if (live) setFiles(value.files); }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [api, run.id, retry]);
  const totals = files && diffTotals(files);
  return createPortal(<DialogSurface className="proactive-diff" labelledBy="proactive-diff-title" onClose={onClose}>
    <h2 id="proactive-diff-title" className="dialog-title">{t('proactive.changes')}</h2>
    {files === null && !error && <p role="status">{t('common.loading')}</p>}
    {error && <p className="panel-error" role="alert">{error} <button className="ghost" onClick={() => setRetry(n => n + 1)}>{t('common.retry')}</button></p>}
    {files?.length === 0 && <p className="desk-empty">{t('proactive.noChanges')}</p>}
    {files && files.length > 0 && <>
      <p className="proactive-diff-total">{t('proactive.fileCount', files.length)}<DiffCount additions={totals!.additions} deletions={totals!.deletions} /></p>
      <ul className="proactive-diff-files">{files.map(file => <li key={file.path}><span className="proactive-diff-path">{file.path}</span><DiffCount additions={file.additions} deletions={file.deletions} /></li>)}</ul>
    </>}
    <div className="dialog-actions"><button className="ghost" onClick={onClose}>{t('common.close')}</button></div>
  </DialogSurface>, document.body);
}

function DiffCount({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="diff-stats"><span className="diff-added">+{additions}</span><span className="diff-removed">-{deletions}</span></span>;
}

/** What can be done about a run, wherever it shows. Discarding is the one thing that cannot be undone, so it asks. */
export function RunControls({ api, run, state }: { api: Api; run: ProactiveRun; state: ProactiveState }) {
  const [viewing, setViewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pending = state.pending[run.id];
  const controls = runControls(run);
  if (!controls.length) return null;
  return <>
    <div className="desk-card-actions">{controls.map(control => control === 'diff'
      ? <button key={control} className="ghost" onClick={() => setViewing(true)}>{t('proactive.viewChanges')}</button>
      : <button key={control} className={control === 'merge' ? 'primary' : 'ghost'} disabled={Boolean(pending)} onClick={() => { if (control === 'discard') setConfirming(true); else state.act(run, control); }}>{t(pending === control ? `proactive.${control}ing` : `proactive.${control}`)}</button>)}
    </div>
    {viewing && <DiffDialog api={api} run={run} onClose={() => setViewing(false)} />}
    {confirming && createPortal(<Dialog title={t('proactive.discardTitle')} message={t('proactive.discardHint')} confirmLabel={t('proactive.discard')} danger onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); state.act(run, 'discard'); }} />, document.body)}
  </>;
}

const statusLabel = (run: ProactiveRun): string => {
  if (run.status === 'ready') return t(run.kind === 'sandbox' ? 'proactive.status.sandboxReady' : 'proactive.status.prepared');
  if (run.status === 'running') return t(run.kind === 'sandbox' ? 'proactive.status.sandboxRunning' : 'proactive.status.preparing');
  return t(`proactive.status.${run.status}`);
};

/** One card in a matter's spread: quiet for materials, a decision for finished sandbox work, the reason for a failure. */
export function ProactiveCard({ api, run, state, style }: { api: Api; run: ProactiveRun; state: ProactiveState; style?: React.CSSProperties }) {
  const failure = state.failures[run.id];
  const failed = run.status === 'failed';
  const prepared = run.kind === 'prepare' && run.status === 'ready';
  return <article className={`desk-card proactive-card ${run.status}${prepared ? ' prepared' : ''}`} data-run={run.id} style={style}>
    <span className={`desk-card-kind${failed ? ' personal-warning' : ''}`}>{prepared ? <IconFile size={14} /> : <IconSparkle size={14} />}{statusLabel(run)}</span>
    {prepared && (run.files?.length ?? 0) > 0 && <ul className="proactive-files">{run.files!.map(file => <li key={file.path} title={file.path}>{fileName(file.path)}</li>)}</ul>}
    {failed ? <p>{run.summary || t('proactive.failedHint')}</p> : run.summary && <p className={prepared ? 'proactive-summary' : undefined}>{run.summary}</p>}
    {run.kind === 'sandbox' && run.status === 'ready' && run.testReport && <p className="proactive-tests">{run.testReport}</p>}
    {run.kind === 'sandbox' && run.status === 'ready' && run.files && <small className="desk-card-foot">{t('proactive.fileCount', run.files.length)}</small>}
    <RunControls api={api} run={run} state={state} />
    {failure && <p className="desk-action-error proactive-failure" role="alert">{failure}</p>}
  </article>;
}

/** The filter's answer: one line per matter she acted on, with what is left to decide right on it. */
export function ProactiveList({ api, todos, state, canOpen, onOpen }: { api: Api; todos: Todo[]; state: ProactiveState; canOpen: (id: string) => boolean; onOpen: (id: string, source: HTMLElement) => void }) {
  if (state.error) return <p className="desk-state" role="alert">{state.error} <button className="ghost" onClick={state.load}>{t('common.retry')}</button></p>;
  if (!state.runs) return <p className="desk-state" role="status">{t('common.loading')}</p>;
  const matters = proactiveMatters(state.runs, todos);
  if (!matters.length) return <p className="desk-empty">{t('proactive.none')}</p>;
  return <ul className="proactive-list desk-paper">{matters.map(({ matterId, todo, run }) => <li key={matterId} data-matter={matterId}>
    <div className="proactive-row-main">
      {todo && canOpen(matterId) ? <button className="proactive-row-title" onClick={e => onOpen(matterId, e.currentTarget)}>{todo.text}</button> : <span className="proactive-row-title">{todo?.text ?? run.summary ?? t('proactive.goneMatter')}</span>}
      <span className={`proactive-row-status${run.status === 'failed' ? ' personal-warning' : ''}`}>{statusLabel(run)}</span>
    </div>
    <RunControls api={api} run={run} state={state} />
    {state.failures[run.id] && <p className="desk-action-error proactive-failure" role="alert">{state.failures[run.id]}</p>}
  </li>)}</ul>;
}
