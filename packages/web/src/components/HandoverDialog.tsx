import { useEffect, useRef, useState } from 'react';
import { copyText } from '../clipboard';
import type { AgentInfo, Api, Thread } from '../api';
import { IconCheck, IconCopy } from './icons';

/**
 * Handing a thread's task to another agent, without the hub doing the switch itself: pick the
 * successor, get a summary — written by the current agent while it still can, or synthesized by
 * the hub from the event log when it cannot — and copy it into a new thread as its first message.
 */

interface Props {
  api: Api;
  thread: Thread;
  agents: AgentInfo[];
  onClose: () => void;
  onError: (e: unknown) => void;
}

type Result = { summary: string; source: 'agent' | 'log' };

export function HandoverDialog({ api, thread, agents, onClose, onError }: Props) {
  const others = agents.filter((a) => a.id !== thread.agent && a.available);
  const [target, setTarget] = useState(others[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A handover turn runs like any other: ask, then watch for it to settle.
  const awaitAgentSummary = (turnId: string) =>
    new Promise<Result>((resolve, reject) => {
      const began = Date.now();
      const tick = async () => {
        try {
          const r = await api.handoverSummary(thread.id, turnId, target);
          if (r && 'summary' in r) resolve(r);
          else if (Date.now() - began > 240_000) reject(new Error('等 agent 写完交接摘要超时'));
          else timer.current = window.setTimeout(tick, 1500);
        } catch (e) {
          reject(e);
        }
      };
      void tick();
    });

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const withAgent = () =>
    void run(async () => {
      const { turnId } = await api.startHandover(thread.id, target);
      setResult(await awaitAgentSummary(turnId));
    });

  const fromLog = () =>
    void run(async () => {
      const r = await api.handoverSummary(thread.id, '', target);
      if (r && 'summary' in r) setResult(r);
    });

  const copy = () =>
    void run(async () => {
      if (!result) return;
      if (await copyText(result.summary)) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
    });

  const successor = others.find((a) => a.id === target)?.label ?? '另一个 agent';
  const running = thread.status === 'running';

  return (
    <div className="dialog-scrim" onClick={busy ? undefined : onClose}>
      <div className="dialog handover" role="dialog" aria-modal="true" aria-labelledby="handover-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="handover-title" className="dialog-title">
          交接给别的 agent
        </h2>
        {result ? (
          <>
            <p className="dialog-message">
              {result.source === 'agent' ? '这份摘要由当前 agent 写。' : '这份由 hub 从过程记录合成。'}
              复制后新建线程、选中 {successor}，把摘要粘贴成第一条消息。
            </p>
            <pre className="handover-summary">{result.summary}</pre>
            <div className="dialog-actions">
              <button className="ghost" onClick={fromLog} disabled={busy}>
                用记录重新合成
              </button>
              <button className="ghost" onClick={onClose} disabled={busy}>
                关闭
              </button>
              <button className="primary" onClick={copy} disabled={busy}>
                {copied ? '已复制' : '复制摘要'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="dialog-message">
              选接手的 agent，然后生成交接摘要。「让 agent 写」最完整，但要花一轮对话；「用记录合成」不花额度，hub 从过程记录里拼。
            </p>
            <div className="handover-targets" role="radiogroup" aria-label="接手的 agent">
              {others.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={a.id === target}
                  className={`handover-target${a.id === target ? ' on' : ''}`}
                  onClick={() => setTarget(a.id)}
                >
                  <span>{a.label}</span>
                  {a.id === target && <IconCheck size={15} />}
                </button>
              ))}
              {others.length === 0 && <p className="handover-note">没有其他可用的 agent。</p>}
            </div>
            <div className="dialog-actions">
              <button className="ghost" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button className="ghost" onClick={fromLog} disabled={busy || others.length === 0}>
                用记录合成
              </button>
              <button className="primary" onClick={withAgent} disabled={busy || others.length === 0 || running}>
                {busy ? '正在写…' : '让 agent 写'}
              </button>
            </div>
            {running && (
              <p className="handover-note">这一轮还在跑，等它结束才能让 agent 写；要快的话先用记录合成。</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
