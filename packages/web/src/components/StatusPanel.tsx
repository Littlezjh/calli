import { useEffect, useState, type ReactNode } from 'react';
import type { Thread } from '../api';
import { copyText } from '../clipboard';
import { PERMISSION_LABELS } from '../permissions';
import { usageSummary, type Usage } from '../timeline';
import { IconCheck, IconClose, IconCopy, IconInfo } from './icons';

interface Props {
  /** The open thread, or null for a thread that has not been started yet. */
  thread: Thread | null;
  agentLabel: string;
  model: string;
  /** Empty when the agent has no permission levels. */
  permission: string;
  directory: string;
  usage: Usage | null;
  /** The agent's own command for plan usage, if it has one (such as "usage" or "cost"). */
  usageCommand: string | null;
  /** Opens the quota panel when the agent can read its plan outside a session. */
  onOpenQuota?: () => void;
  onRunCommand: (text: string) => void;
  onClose: () => void;
}

function CopyValue({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button type="button" className="quiet-btn" aria-label="复制" title={done ? '已复制' : '复制'} onClick={async () => setDone(await copyText(value))}>
      {done ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  );
}

const STATUS_LABELS: Record<string, string> = { idle: '空闲', running: '运行中', error: '上一轮出错' };

/**
 * What `/status` shows in a terminal, for any agent: who is answering, with which settings, in
 * which session, and how full the context is. Agents do not offer this outside their terminal UI.
 */
export function StatusPanel({ thread, agentLabel, model, permission, directory, usage, usageCommand, onOpenQuota, onRunCommand, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const summary = usage ? usageSummary(usage) : null;
  const rows: Array<[string, ReactNode, string?]> = [
    ['Agent', agentLabel],
    ['模型', model],
    ...(permission ? ([['权限', PERMISSION_LABELS[permission]?.label ?? permission]] as Array<[string, ReactNode]>) : []),
    ['目录', <code key="dir">{directory}</code>, directory],
  ];
  if (thread) {
    rows.push(['状态', thread.waiting ? '等待批准' : (STATUS_LABELS[thread.status] ?? thread.status)]);
    rows.push(
      thread.agentSessionId
        ? ['会话 ID', <code key="id">{thread.agentSessionId}</code>, thread.agentSessionId]
        : ['会话 ID', <span key="id" className="muted">发出第一条消息后才有</span>],
    );
    if (thread.resumeCommand) rows.push(['终端里继续', <code key="resume">{thread.resumeCommand}</code>, thread.resumeCommand]);
    rows.push([
      '上下文',
      summary ? (
        <span key="usage" className={summary.high ? 'warn-text' : undefined}>
          {summary.percent}% · {summary.detail}
        </span>
      ) : (
        <span key="usage" className="muted">agent 还没有报告</span>
      ),
    ]);
  }

  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="panel status-panel" role="dialog" aria-modal="true" aria-labelledby="status-title" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 id="status-title" className="panel-title">
            <IconInfo size={20} /> 状态
          </h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>
        <dl className="status-list">
          {rows.map(([label, value, copy]) => (
            <div key={label} className="status-row">
              <dt>{label}</dt>
              <dd>
                <span className="status-value">{value}</span>
                {copy && <CopyValue value={copy} />}
              </dd>
            </div>
          ))}
        </dl>
        {(onOpenQuota || (thread && usageCommand)) && (
          <div className="status-actions">
            {onOpenQuota ? (
              <button
                type="button"
                className="text-btn strong"
                onClick={() => {
                  onOpenQuota();
                  onClose();
                }}
              >
                查看 {agentLabel} 的套餐额度
              </button>
            ) : (
              <button
                type="button"
                className="text-btn strong"
                onClick={() => {
                  onRunCommand(`/${usageCommand}`);
                  onClose();
                }}
              >
                查看 {agentLabel} 的套餐用量（/{usageCommand}）
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
