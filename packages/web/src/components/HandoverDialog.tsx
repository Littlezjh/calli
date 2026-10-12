import { useEffect, useRef, useState } from 'react';
import { copyText } from '../clipboard';
import type { Api, Thread } from '../api';
import { IconCheck, IconCopy } from './icons';

interface Props {
  api: Api;
  thread: Thread;
  onClose: () => void;
}

/** Assemble the source session and progress as soon as the dialog opens; no agent turn is needed. */
export function HandoverDialog({ api, thread, onClose }: Props) {
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setSummary(null);
    setError('');
    setCopied(false);
    void api.handoverSummary(thread.id).then((result) => {
      if (!active) return;
      if ('summary' in result) {
        const machine = api.host ? `远端机器（ID：${api.host}）` : '本机（当前 hub）';
        setSummary(`来源机器：${machine}\n\n${result.summary}`);
      } else setError('交接信息尚未就绪，请重试。');
    }).catch((e: unknown) => {
      if (active) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { active = false; };
  }, [api, thread.id, revision]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
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

  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="dialog handover" role="dialog" aria-modal="true" aria-labelledby="handover-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="handover-title" className="dialog-title">交接</h2>
        <p className="dialog-message">已自动整理当前 agent 实例、工作目录、会话位置和进度。复制后发给接手的 agent 即可。</p>
        {summary ? <pre className="handover-summary" tabIndex={0}>{summary}</pre> : !error && <p className="handover-note" role="status">正在整理交接信息…</p>}
        {error && <p className="panel-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {error && !summary && <button className="ghost" onClick={() => setRevision((v) => v + 1)}>重试</button>}
          <button className="ghost" onClick={onClose}>关闭</button>
          <button className="primary" onClick={() => void copy()} disabled={!summary}>
            {copied ? <IconCheck size={15} /> : <IconCopy size={15} />} {copied ? '已复制' : '复制交接信息'}
          </button>
        </div>
      </div>
    </div>
  );
}
