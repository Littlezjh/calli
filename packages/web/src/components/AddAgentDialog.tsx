import { useEffect, useState } from 'react';
import type { DiscoveredAgent } from './Pickers';
import { IconClose, IconPlus, IconSparkle } from './icons';

/**
 * CLIs on this host that look like another copy of a known agent. Adding one is rare, so it lives
 * here behind the settings menu instead of the agent picker the principle keeps lean: what is not
 * used often must not be in the way of what is.
 */

interface Props {
  found: DiscoveredAgent[];
  onAdd: (found: DiscoveredAgent) => Promise<void>;
  onClose: () => void;
}

export function AddAgentDialog({ found, onAdd, onClose }: Props) {
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = found.filter((d) => !added.includes(d.id));

  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="dialog add-agent" role="dialog" aria-modal="true" aria-labelledby="add-agent-title" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title-row">
          <h2 id="add-agent-title" className="dialog-title">
            添加 agent
          </h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </div>
        <p className="dialog-message">在这台主机上发现的其他 agent 命令。添加后作为新 agent 使用，会出现在 agent 选择器里。</p>
        <div className="handover-targets">
          {rows.length === 0 && <p className="handover-note">没有新的可添加项。</p>}
          {rows.map((d) => (
            <button
              key={d.id}
              type="button"
              className="handover-target"
              disabled={adding !== null}
              onClick={async () => {
                setAdding(d.id);
                try {
                  await onAdd(d);
                  setAdded((ids) => [...ids, d.id]);
                } finally {
                  setAdding(null);
                }
              }}
            >
              <span>{d.id}</span>
              {adding === d.id ? <IconSparkle size={14} /> : <IconPlus size={14} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
