import { useEffect, useState, type ReactNode } from 'react';
import type { AgentInfo, Coordination, ThreadOutputs } from '../api';
import { deliveredPreview, progressState } from '../timeline';
import { relativePath } from '../paths';
import { t } from '../i18n';
import { memberStatus } from './AgentPanel';
import { PlanList, PlanRing, planProgress, type PlanItem } from './PlanPanel';
import { Lightbox } from './Lightbox';
import { AgentMark, IconAgents, IconChevron, IconEdit, IconExternal, IconFile, IconHandover, IconImage } from './icons';

type Section = 'agents' | 'plan' | 'changes' | 'images' | 'files';

/** Which sections the user folded, kept on this device for every thread. */
const FOLDED_KEY = 'calli.overview.folded';
/** The folded sections a device remembers; anything it did not say unfolds everything. */
export const foldedFrom = (storage: { getItem(key: string): string | null }): Set<Section> => {
  try { return new Set(JSON.parse(storage.getItem(FOLDED_KEY) ?? '[]') as Section[]); } catch { return new Set(); }
};
const rememberFolded = (folded: Set<Section>) => {
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded])); } catch { /* this page keeps it anyway */ }
};

/** Rows a list shows before "All N"; pictures a grid shows before "+N". */
const ROWS = 5;
const PICTURES = 6;

/**
 * What a member's last report ended asking for, read the way the conversation's own lines read it:
 * the `[进度]` word at the end of what they said — or, when the delivery itself failed, that.
 */
export const memberProgress = (m: Coordination['members'][number]): 'need' | 'failed' | 'review' | 'progress' | null =>
  m.latest?.state === 'failed' ? 'failed' : progressState(m.latest?.result ?? '');

/** Who needs the user first, then what went wrong, then who is busy; the rest keep their order. */
const memberRank = (m: Coordination['members'][number]) => {
  const p = memberProgress(m);
  if (p === 'need') return 0;
  if (p === 'failed') return 1;
  if (m.thread?.status === 'running') return 2;
  if (m.latest?.state === 'queued') return 3;
  if (p === 'review') return 4;
  return 5;
};

export function sortMembers(members: Coordination['members']): Coordination['members'] {
  return members.map((m, i) => ({ m, i })).sort((a, b) => memberRank(a.m) - memberRank(b.m) || a.i - b.i).map(({ m }) => m);
}

const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;
const dirName = (path: string) => { const at = path.lastIndexOf('/'); return at > 0 ? path.slice(0, at) : ''; };

/**
 * Everything about a thread at a glance, in the margin a wide screen leaves beside the conversation,
 * grouped by kind: the team, the plan, what changed, the pictures and the files. Each group folds,
 * long ones show their first few; pictures load only while their group is open.
 */
export function ThreadOverview({ team, agents, plan, outputs, failed, roots, onOpenMember, onRetry, onJumpTurn, onOpenFile, loadFile }: {
  team: Coordination | null; agents: AgentInfo[]; plan: PlanItem | null;
  outputs: ThreadOutputs | null; failed: boolean; roots: string[];
  onOpenMember: (memberId?: string) => void; onRetry: () => void;
  onJumpTurn: (turnId: string) => void;
  onOpenFile: (path: string) => Promise<void>;
  loadFile: (path: string) => Promise<Blob>;
}) {
  const [folded, setFolded] = useState<Set<Section>>(() => foldedFrom(localStorage));
  const [all, setAll] = useState<Set<Section>>(new Set());
  const toggle = (s: Section) => setFolded(prev => {
    const next = new Set(prev);
    if (!next.delete(s)) next.add(s);
    rememberFolded(next);
    return next;
  });
  const showAll = (s: Section) => setAll(prev => { const next = new Set(prev); if (!next.delete(s)) next.add(s); return next; });
  const shown = <T,>(s: Section, list: T[], n = ROWS) => (all.has(s) ? list : list.slice(0, n));
  const more = (s: Section, total: number, n = ROWS) => total > n && (
    <button type="button" className="overview-more" onClick={() => showAll(s)}>{all.has(s) ? t('overview.showLess') : t('overview.showAll', total)}</button>
  );
  const rel = (path: string) => relativePath(path, roots);

  const changes = outputs?.changes;
  const members = team ? sortMembers(team.members) : [];
  const running = members.filter(m => m.thread?.status === 'running').length;
  const waiting = members.filter(m => m.thread?.waiting).length;
  const needs = members.filter(m => memberProgress(m) === 'need').length;
  const progress = plan ? planProgress(plan) : null;

  return <aside className="team-card thread-overview" aria-label={t('overview.label')}>
    {team && <Group id="agents" folded={folded} onToggle={toggle} icon={<IconAgents size={14} />} label={t('team.agents')}
      summary={team.paused ? t('team.paused') : needs ? <span className="overview-attention">{t('overview.needsYou', needs)}</span> : waiting ? <span className="overview-attention">{t('overview.waiting', waiting)}</span> : running ? t('team.running', running) : t('team.count', members.length)}
      extra={<button type="button" className="overview-icon" aria-label={t('overview.openPanel')} title={t('overview.openPanel')} onClick={() => onOpenMember()}><IconExternal size={13} /></button>}>
      {members.map(m => {
        const icon = agents.find(a => a.id === m.thread?.agent)?.icon;
        const state = m.thread?.waiting ? 'waiting' : m.thread?.status === 'running' ? 'running' : m.latest?.state === 'failed' ? 'failed' : 'idle';
        // The status word answers first to what the member's last report ended asking for, the same
        // words and colors the conversation line uses; only a report that says nothing falls back.
        const prog = memberProgress(m);
        const word = prog === 'need' ? t('view.deliveredNeed') : prog === 'failed' ? t('team.failed')
          : prog === 'review' ? t('view.deliveredReview') : prog === 'progress' ? t('view.deliveredProgress')
          : memberStatus(m);
        // What it was last asked, or what it last answered once it has.
        const doing = deliveredPreview(state === 'running' || state === 'waiting' ? m.latest?.text ?? '' : m.latest?.result || m.latest?.text || '');
        return <button type="button" className="team-card-row" key={m.id} title={doing} onClick={() => onOpenMember(m.id)}>
          <span className="team-card-mark">{icon ? <AgentMark path={icon} size={14} /> : <IconAgents size={14} />}</span>
          <span className="team-card-text">
            <span className="team-card-line"><strong>{m.name}{m.thread?.handover && <span className="auto-member-mark" role="img" aria-label={t('auto.transferred')} title={t('auto.transferred')}><IconHandover size={13} /></span>}</strong><span className={`team-card-state ${prog ?? state}`}>{word}</span></span>
            {doing && <span className="team-card-doing">{doing}</span>}
          </span>
        </button>;
      })}
    </Group>}

    {plan && progress && <Group id="plan" folded={folded} onToggle={toggle} icon={<PlanRing done={progress.total ? progress.completed / progress.total : 0} size={14} />} label={t('overview.plan')}
      summary={`${progress.completed}/${progress.total}`}>
      <div className="overview-plan"><PlanList item={plan} /></div>
    </Group>}

    {changes && changes.total > 0 && <Group id="changes" folded={folded} onToggle={toggle} icon={<IconEdit size={14} />} label={t('overview.changes')}
      summary={<><span>{changes.total}</span><span className="overview-dot" aria-hidden="true">·</span><Nums added={changes.added} removed={changes.removed} /></>}>
      {shown('changes', changes.files).map(f => (
        <button type="button" key={f.path} className="overview-row" title={t('overview.toTurn', rel(f.path), f.turns)} onClick={() => onJumpTurn(f.turnId)}>
          <PathName path={rel(f.path)} />
          {f.created && <span className="overview-tag">{t('overview.created')}</span>}
          <Nums added={f.added} removed={f.removed} />
        </button>
      ))}
      {more('changes', changes.files.length)}
    </Group>}

    {outputs && outputs.images.length > 0 && <Group id="images" folded={folded} onToggle={toggle} icon={<IconImage size={14} />} label={t('overview.images')}
      summary={String(outputs.images.length)}>
      <div className="overview-pictures">
        {shown('images', outputs.images, PICTURES).map(img => <Picture key={img.path} path={img.path} name={rel(img.path)} load={loadFile} />)}
      </div>
      {more('images', outputs.images.length, PICTURES)}
    </Group>}

    {outputs && outputs.files.length > 0 && <Group id="files" folded={folded} onToggle={toggle} icon={<IconFile size={14} />} label={t('overview.files')}
      summary={String(outputs.files.length)}>
      {shown('files', outputs.files).map(f => <FileRow key={f.path} path={f.path} name={rel(f.path)} onOpen={onOpenFile} />)}
      {more('files', outputs.files.length)}
    </Group>}

    {failed && <div className="overview-failed" role="status"><span>{t('overview.failed')}</span><button type="button" className="text-btn" onClick={onRetry}>{t('common.retry')}</button></div>}
  </aside>;
}

function Group({ id, folded, onToggle, icon, label, summary, extra, children }: {
  id: Section; folded: Set<Section>; onToggle: (s: Section) => void;
  icon: ReactNode; label: string; summary: ReactNode; extra?: ReactNode; children: ReactNode;
}) {
  const open = !folded.has(id);
  return <section className={`overview-group${open ? ' open' : ''}`}>
    <div className="overview-head">
      {/* The chevron leads, so the numbers on the right line up with the rows below them. */}
      <button type="button" className="overview-toggle" aria-expanded={open} onClick={() => onToggle(id)}>
        <span className="overview-chevron"><IconChevron size={12} open={open} /></span>
        <span className="overview-head-icon">{icon}</span>
        <strong>{label}</strong>
        <span className="overview-summary">{summary}</span>
      </button>
      {extra}
    </div>
    {open && <div className="overview-body">{children}</div>}
  </section>;
}

/**
 * What a file (or a whole change set) added and removed, as one pair on the right: a side that is
 * zero stays out of the way, unless both are — then the pair says so rather than going missing.
 */
function Nums({ added, removed }: { added: number; removed: number }) {
  const both = (added > 0 && removed > 0) || (added === 0 && removed === 0);
  return <span className="overview-nums">
    {(added > 0 || both) && <span className="overview-add">+{added}</span>}
    {(removed > 0 || both) && <span className="overview-del">−{removed}</span>}
  </span>;
}

/** A path as a name with the folder it is in after it, faint. The row does the cutting itself,
 *  against its own width: the stem of the name folds first, the extension never folds, and the
 *  folder gives way before the name does — down to its last few characters, never further. */
function PathName({ path }: { path: string }) {
  const dir = dirName(path);
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : '';
  return <span className="overview-path">
    <span className="overview-name"><span className="overview-stem">{ext ? base.slice(0, dot) : base}</span>{ext && <span className="overview-ext">{ext}</span>}</span>
    {dir && <span className="overview-dir">{dir}</span>}
  </span>;
}

function FileRow({ path, name, onOpen }: { path: string; name: string; onOpen: (path: string) => Promise<void> }) {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(null), 2400); return () => clearTimeout(id); }, [note]);
  return <button type="button" className="overview-row" title={path} onClick={() => onOpen(path).catch(() => setNote(t('view.noPreview')))}>
    <PathName path={name} />
    {note && <span className="overview-note" role="status">{note}</span>}
  </button>;
}

/** A thumbnail, fetched while it is on screen; the full picture opens over everything. */
function Picture({ path, name, load }: { path: string; name: string; load: (path: string) => Promise<Blob> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [large, setLarge] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    load(path).then(blob => { if (!live) return; made = URL.createObjectURL(blob); setUrl(made); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path, load]);
  // A drawing has no background of its own and would be cropped by the square cell; it sits whole
  // on the picture background instead, with room around it.
  const vector = /\.svgz?$/i.test(path);
  return <>
    <button type="button" className={`overview-picture${vector ? ' vector' : ''}${failed ? ' failed' : ''}`} title={failed ? `${name}\n${t('view.noPreview')}` : name} disabled={!url} onClick={() => setLarge(true)}>
      {url ? <img src={url} alt={name} /> : <IconImage size={16} />}
    </button>
    {large && url && <Lightbox url={url} name={name} onClose={() => setLarge(false)} />}
  </>;
}
