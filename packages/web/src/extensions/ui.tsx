import { WorkSummary } from './work';
/**
 * The host components extension views draw with. They are the hub's own (icons.tsx, Popover, the
 * styles.css variables), so an extension looks like the rest of the interface without shipping
 * any styling of its own.
 */
import { useEffect, useState, type ComponentProps } from 'react';
import type { PopoverOptionProps, PopoverProps, WebHostUi } from '@rah/extension-api/web';
import type { AgentInfo } from '../api';
import { Popover } from '../components/Popover';
import {
  AgentMark as Mark,
  IconActivity,
  IconAgents,
  IconBoard,
  IconBolt,
  IconCheck,
  IconChevron,
  IconClock,
  IconClose,
  IconCube,
  IconFork,
  IconGauge,
  IconGlobe,
  IconList,
  IconPin,
  IconServer,
  IconSparkle,
  IconTarget,
  IconTray,
  IconWorktree,
} from '../components/icons';
import { formatDateTime } from '../i18n';
import { timeAgo } from '../sessions';

/** Everything `WebHostUi.Icon` may be asked for: the manifest's names plus the few a card needs. */
export type HostIconKey = ComponentProps<WebHostUi['Icon']>['name'];

const ICONS: Record<HostIconKey, (p: { size?: number }) => JSX.Element> = {
  board: IconBoard,
  list: IconList,
  activity: IconActivity,
  clock: IconClock,
  target: IconTarget,
  gauge: IconGauge,
  sparkle: IconSparkle,
  cube: IconCube,
  globe: IconGlobe,
  server: IconServer,
  bolt: IconBolt,
  pin: IconPin,
  worktree: IconWorktree,
  fork: IconFork,
  // The core's collaboration mark, as on the team button and in the agent panel.
  team: IconAgents,
  check: IconCheck,
  chevron: (props) => <IconChevron {...props} open />,
  close: IconClose,
};

/** An icon an extension names. One the host does not know is drawn as a plain cube. */
export function HostIcon({ name, size }: { name: HostIconKey; size?: number }) {
  const Icon = ICONS[name] ?? IconCube;
  return <Icon size={size} />;
}

/** The time now, moving on every `ms`: one timer per component that shows relative times. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function RelativeTime({ iso }: { iso: string }) {
  const now = useNow(30_000);
  return (
    <time className="ext-time" dateTime={iso} title={formatDateTime(iso)}>
      {timeAgo(iso, now)}
    </time>
  );
}

function HostPopover({ label, trigger, triggerClassName, triggerTitle, align, children }: PopoverProps) {
  return (
    <Popover label={label} trigger={trigger} triggerClassName={triggerClassName} triggerTitle={triggerTitle} align={align}>
      {children}
    </Popover>
  );
}

function PopoverOption({ selected, onSelect, children }: PopoverOptionProps) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} className="pop-item compact" onClick={onSelect}>
      <span className="pop-item-text">
        <span className="pop-item-label">{children}</span>
      </span>
      {selected && (
        <span className="pop-item-check">
          <IconCheck size={16} />
        </span>
      )}
    </button>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="ext-empty">
      <span className="ext-empty-art" aria-hidden="true">
        <IconTray size={26} />
      </span>
      <p>{text}</p>
    </div>
  );
}

/** The components handed to extension views. `agents` is read at render, so it is always current. */
export function hostUi(agents: () => AgentInfo[]): WebHostUi {
  function AgentMark({ agentId, size = 14, label = false }: { agentId: string; size?: number; label?: boolean }) {
    const agent = agents().find((a) => a.id === agentId);
    const name = agent?.label ?? agentId;
    return (
      <span className="ext-agent" title={name}>
        {agent?.icon ? (
          <span className="agent-mark" role={label ? undefined : 'img'} aria-label={label ? undefined : name}>
            <Mark path={agent.icon} size={size} />
          </span>
        ) : null}
        {/* Without a mark the name is all there is to tell the agent by. */}
        {(label || !agent?.icon) && <span className="ext-agent-name">{name}</span>}
      </span>
    );
  }
  return { WorkSummary, Icon: HostIcon, AgentMark, RelativeTime, Popover: HostPopover, PopoverOption, EmptyState };
}
