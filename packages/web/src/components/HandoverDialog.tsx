import { useEffect, useRef, useState } from 'react';
import { copyText } from '../clipboard';
import type { AgentInfo, Api, Thread } from '../api';
import { AgentPicker } from './Pickers';
import { IconCheck, IconCopy, IconEdit } from './icons';

interface Props {
  api: Api;
  thread: Thread;
  agents: AgentInfo[];
  onOpen: (thread: Thread, draft: string) => void;
  onClose: () => void;
}

/** The handover as it is sent: which machine it came from, then what the hub assembled. */
export function handoverMessage(api: Api, summary: string): string {
  const machine = api.host ? `远端机器（ID：${api.host}）` : '本机（当前 hub）';
  return `来源机器：${machine}\n\n${summary}`;
}

/** Assemble the source session and progress as soon as the dialog opens; no agent turn is needed. */
export function HandoverDialog({ api, thread, agents, onOpen, onClose }: Props) {
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const [target, setTarget] = useState(() => agents.find((a) => a.id === thread.agent && a.available)?.id ?? agents.find((a) => a.available)?.id ?? '');
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  useEffect(() => {
    let active = true;
    setSummary(null);
    setError('');
    setCopied(false);
    void api.handoverSummary(thread.id).then((result) => {
      if (!active) return;
      if ('summary' in result) {
        setSummary(handoverMessage(api, result.summary));
      } else setError('交接信息尚未就绪，请重试。');
    }).catch((e: unknown) => {
      if (active) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { active = false; };
  }, [api, thread.id, revision]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !creatingRef.current && !document.querySelector('.pop-panel')) onClose(); };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      window.clearTimeout(timer.current);
    };
  }, [onClose]);

  const copy = async () => {
    if (!summary) return;
    if (await copyText(summary)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } else setError('复制失败，请选择下方内容手动复制。');
  };

  const create = async () => {
    if (!summary || !target || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError('');
    try {
      const successor = await api.createHandoverThread(thread.id, target);
      onOpen(successor, summary);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <div className="dialog-scrim" onClick={() => { if (!creatingRef.current) onClose(); }}>
      <div className="dialog handover" role="dialog" aria-modal="true" aria-labelledby="handover-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="handover-title" className="dialog-title">交接</h2>
        <p className="dialog-message">在原目录和 worktree 中新建对话，交接内容会放进输入框，编辑后再发送。也可以直接复制。</p>
        <div className="handover-successor">
          <span>接手 agent</span>
          <fieldset disabled={creating}>
            <AgentPicker agents={agents} value={target} onChange={setTarget} />
          </fieldset>
        </div>
        <p className="handover-cwd" title={thread.cwd}>{thread.cwd}</p>
        {summary ? <pre className="handover-summary" tabIndex={0}>{summary}</pre> : !error && <p className="handover-note" role="status">正在整理交接信息…</p>}
        {error && <p className="panel-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {error && !summary && <button className="ghost" onClick={() => setRevision((v) => v + 1)}>重试</button>}
          <button className="ghost" onClick={onClose} disabled={creating}>关闭</button>
          <button className="ghost" onClick={() => void copy()} disabled={!summary}>
            {copied ? <IconCheck size={15} /> : <IconCopy size={15} />} {copied ? '已复制' : '复制交接信息'}
          </button>
          <button className="primary" onClick={() => void create()} disabled={!summary || !agents.some((a) => a.id === target && a.available) || creating}>
            <IconEdit size={15} /> {creating ? '正在创建…' : '新建接手对话'}
          </button>
        </div>
      </div>
    </div>
  );
}
