import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, type AgentInfo, type Api, type ChangedFile, type Coordination, type OutputFile, type ThreadOutputs } from '../api';
import { deliveredPreview, progressState } from '../timeline';
import { relativePath } from '../paths';
import { t } from '../i18n';
import { memberStatus } from './AgentPanel';
import { PlanList, PlanRing, planProgress, type PlanItem } from './PlanPanel';
import { Lightbox } from './Lightbox';
import { compactTokens, speedLabel, useThreadStats } from './SessionStats';
import { AgentMark, IconAgents, IconChevron, IconChevronRight, IconEdit, IconFile, IconImage, IconPreview } from './icons';

/** The parts of the overview, in the order they are shown. */
export type Section = 'agents' | 'plan' | 'changes' | 'images' | 'files';

/** Which sections the user folded (true) or unfolded (false) by hand, kept on this device. */
export type Choices = Partial<Record<Section, boolean>>;

/** Rows a list shows first, and pictures, before "show more". */
export const ROWS = 3;
export const PICTURES = 4;
/** The fold choices a device remembers: today's map, and the plain list older pages wrote. */
export function choicesFrom(raw: string | null): Choices {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (Array.isArray(value)) return Object.fromEntries(value.filter((v): v is Section => typeof v === 'string').map((v) => [v, true])) as Choices;
    if (value && typeof value === 'object') {
      const out: Choices = {};
      for (const [key, folded] of Object.entries(value)) if (typeof folded === 'boolean') out[key as Section] = folded;
      return out;
    }
  } catch { /* a page that cannot read it starts with everything open */ }
  return {};
}

/** One group as the height budget sees it: the lines it takes open, and whether folding may never touch it. */
export interface FoldLine { id: Section; openLines: number; keep?: boolean }

/**
 * The groups that stay open in the room the panel has, folding from the last group up. What the user
 * folded or unfolded by hand is left alone, and so is a group whose "show more" they pressed; the
 * agents are never folded by the budget, because what needs the person is the point of the panel.
 */
export function autoFold(groups: FoldLine[], budget: number, choices: Choices = {}, expanded: ReadonlySet<Section> = new Set()): Record<Section, boolean> {
  const open = {} as Record<Section, boolean>;
  let total = 0;
  for (const group of groups) {
    open[group.id] = choices[group.id] !== true;
    total += open[group.id] ? group.openLines : 1;
  }
  for (const group of [...groups].reverse()) {
    if (total <= budget || group.keep || !open[group.id] || choices[group.id] !== undefined || expanded.has(group.id)) continue;
    total -= group.openLines - 1;
    open[group.id] = false;
  }
  return open;
}

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

/** The members worth showing first: what needs the user, what failed, what is running. When none
 *  of those, the first three of the sorted list; the rest wait behind "show more". */
export const attentionMembers = (members: Coordination['members']) =>
  members.filter((m) => { const p = memberProgress(m); return p === 'need' || p === 'failed' || m.thread?.status === 'running'; });
export const initialMemberRows = (members: Coordination['members']): number => {
  const attention = attentionMembers(members).length;
  return attention || Math.min(ROWS, members.length);
};

/** Missing pictures are not drawn; the grid says beside itself how many there are. */
export const shownImages = (images: OutputFile[]) => images.filter((image) => !image.missing);
export const missingImages = (images: OutputFile[]) => images.filter((image) => image.missing);

/** A page or a drawing can be shown in the preview, as long as it is still on disk. */
export const previewable = (file: { path: string; missing?: true }): boolean => !file.missing && /\.(html?|svg)$/i.test(file.path);

/** What a thread with nothing to report answers: a daemon that cannot list outputs is read the same
 *  way, so the panel says the thread is empty rather than waiting forever. */
const EMPTY_OUTPUTS: ThreadOutputs = {
  changes: { files: [], added: 0, removed: 0, total: 0 },
  images: [],
  files: [],
  seq: 0,
};

const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;
const dirName = (path: string) => { const at = path.lastIndexOf('/'); return at > 0 ? path.slice(0, at) : ''; };

/** How many 30px lines the list under a title takes: the rows, and "show more" when some are left. */
const listLines = (shown: number, total: number) => 1 + shown + (shown < total ? 1 : 0);
/** A grid row is about two lines tall at this width. */
const pictureLines = (shown: number, total: number) => 1 + Math.ceil(shown / 4) * 2 + (shown < total ? 1 : 0);

/**
 * Everything about a thread at a glance, above the conversation in a panel from the top bar: the
 * team, the plan, what changed, the pictures and the files. The outputs and the readings are read
 * only while the panel is open. Each group folds; long ones show their first few. When the panel is
 * taller than the room it has, groups give way from the bottom — the agents never do.
 *
 * A persistent panel is the one standing beside the conversation: its own rows open other panels
 * without putting it away, and only its button or its close mark does. The popover version still
 * closes behind every row it sends the person to.
 */
export function ThreadOverview({ api, threadId, updatedAt, active, team, agents, plan, roots, turnOrder, loadFile, onOpenMember, onOpenDiff, onOpenFile, onPreview, onOpenTrace, onClose, persistent = false }: {
  api: Api; threadId: string; updatedAt: string; active: boolean;
  team: Coordination | null; agents: AgentInfo[]; plan: PlanItem | null; roots: string[]; turnOrder: string[];
  loadFile: (path: string) => Promise<Blob>;
  onOpenMember: (memberId?: string) => void;
  onOpenDiff: (file: ChangedFile) => void;
  onOpenFile: (path: string) => Promise<void>;
  onPreview: (path: string) => void;
  onOpenTrace: () => void;
  onClose: () => void;
  /** Standing beside the conversation rather than opening over it: rows do not put it away. */
  persistent?: boolean;
}) {
  const [outputs, setOutputs] = useState<ThreadOutputs | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [choices, setChoices] = useState<Choices>(() => choicesFrom(typeof localStorage === 'undefined' ? null : localStorage.getItem('calli.overview.folded')));
  const [expanded, setExpanded] = useState<Set<Section>>(new Set());
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));

  // A standing panel outlives the thread it describes: the last thread's outputs must not stand in
  // for the new thread's while that one is being read.
  useEffect(() => {
    setOutputs(null);
    setFailed(false);
  }, [threadId]);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api.outputs(threadId).then(
        (value) => { if (live) { setOutputs(value); setFailed(false); } },
        // A daemon from before the endpoint has no overview to read: that is empty, not a failure.
        (error: unknown) => {
          if (!live) return;
          if (error instanceof ApiError && error.status === 404) setOutputs(EMPTY_OUTPUTS);
          else setFailed(true);
        },
      );
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [api, threadId, updatedAt, attempt]);

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const stats = useThreadStats(api, threadId, active);
  const rel = (path: string) => relativePath(path, roots);

  const members = useMemo(() => (team ? sortMembers(team.members) : []), [team]);
  const needs = members.filter((m) => memberProgress(m) === 'need').length;
  const failedMembers = members.filter((m) => memberProgress(m) === 'failed').length;
  const running = members.filter((m) => m.thread?.status === 'running').length;
  const memberFirst = initialMemberRows(members);
  const changes = outputs?.changes;
  const pictures = outputs ? shownImages(outputs.images) : [];
  const gonePictures = outputs ? missingImages(outputs.images) : [];
  const progress = plan ? planProgress(plan) : null;
  const files = outputs?.files ?? [];

  const first = (section: Section, total: number): number => {
    if (section === 'agents') return Math.min(memberFirst, total);
    if (section === 'images') return Math.min(PICTURES, total);
    return Math.min(ROWS, total);
  };
  const more = (section: Section, total: number) => total > first(section, total) && (
    <button type="button" className="overview-more" onClick={() => showMore(section)}>
      {expanded.has(section) ? t('overview.showLess') : t('overview.showMore', total - first(section, total))}
    </button>
  );
  const showMore = (section: Section) => {
    const collapsing = expanded.has(section);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(section)) next.add(section);
      return next;
    });
    // The person asked for these rows: the height budget must not fold them away again. Folded
    // back by hand, the section is an explicit one-line title, the budget leaves it alone too.
    setChoices((prev) => { const next = { ...prev, [section]: collapsing }; rememberChoices(next); return next; });
  };
  const shownCount = (section: Section, total: number) => (expanded.has(section) ? total : first(section, total));

  // How many 30px lines the panel can take before it scrolls; the footer and padding are kept out.
  const room = viewport.w <= 640 ? viewport.h * 0.78 : Math.min(viewport.h * 0.7, viewport.h - 60 - 24);
  const budget = Math.max(4, Math.floor((room - 12 - 32) / 30));
  const lines: FoldLine[] = [];
  if (team && members.length) lines.push({ id: 'agents', openLines: listLines(shownCount('agents', members.length), members.length), keep: true });
  if (plan && progress) lines.push({ id: 'plan', openLines: 1 + plan.entries.length });
  if (changes && changes.total > 0) lines.push({ id: 'changes', openLines: listLines(shownCount('changes', changes.files.length), changes.files.length) });
  if (pictures.length) lines.push({ id: 'images', openLines: pictureLines(shownCount('images', pictures.length), pictures.length) });
  if (files.length) lines.push({ id: 'files', openLines: listLines(shownCount('files', files.length), files.length) });
  const open = autoFold(lines, budget, choices, expanded);

  const toggle = (section: Section) => setChoices((prev) => {
    const next = { ...prev, [section]: open[section] };
    rememberChoices(next);
    return next;
  });

  const footer = readings(stats);
  const openAndClose = (run: () => void) => persistent ? run : () => { onClose(); run(); };

  // Before the first answer, and when the answer is nothing, the panel says which of the two it is
  // in one faint line instead of looking like a card that failed to draw.
  const hasGroups = lines.length > 0;
  const loading = outputs === null && !failed;
  const empty = !loading && !failed && !hasGroups && !footer;
  const placeholder = loading && !hasGroups && !footer ? t('overview.loading') : empty ? t('overview.empty') : null;

  return <div className="thread-overview">
    {team && members.length > 0 && <Group id="agents" open={open.agents} onToggle={toggle} icon={<IconAgents size={14} />} label={t('overview.agents')}
      summary={team.paused ? t('team.paused') : needs ? <span className="overview-attention">{t('overview.needsYou', needs)}</span>
        : failedMembers ? <span className="overview-danger">{t('overview.failedCount', failedMembers)}</span>
        : running ? t('team.running', running) : t('team.count', members.length)}>
      {members.slice(0, shownCount('agents', members.length)).map((m) => <MemberRow key={m.id} member={m} agents={agents} onOpen={openAndClose(() => onOpenMember(m.id))} />)}
      {more('agents', members.length)}
    </Group>}

    {plan && progress && <Group id="plan" open={open.plan} onToggle={toggle} icon={<PlanRing done={progress.total ? progress.completed / progress.total : 0} size={14} />} label={t('overview.plan')}
      summary={`${progress.completed}/${progress.total}`}>
      <div className="overview-plan"><PlanList item={plan} /></div>
    </Group>}

    {changes && changes.total > 0 && <Group id="changes" open={open.changes} onToggle={toggle} icon={<IconEdit size={14} />} label={t('overview.changes')}
      summary={<><span>{changes.total}</span><span className="overview-dot" aria-hidden="true">·</span><Nums added={changes.added} removed={changes.removed} /></>}>
      {changes.files.slice(0, shownCount('changes', changes.files.length)).map((file) => (
        <FileLine key={file.path} path={rel(file.path)} full={file.path} missing={file.missing} tag={file.created && !file.missing ? t('overview.created') : undefined}
          trailing={<Nums added={file.added} removed={file.removed} />} onOpen={openAndClose(() => onOpenDiff(file))}
          preview={previewable(file) ? openAndClose(() => onPreview(file.path)) : undefined} />
      ))}
      {more('changes', changes.files.length)}
    </Group>}

    {pictures.length > 0 && <Group id="images" open={open.images} onToggle={toggle} icon={<IconImage size={14} />} label={t('overview.images')}
      summary={String(pictures.length)}>
      <div className="overview-pictures">
        {pictures.slice(0, shownCount('images', pictures.length)).map((image) => <Picture key={image.path} path={image.path} name={rel(image.path)} load={loadFile} />)}
      </div>
      {more('images', pictures.length)}
      {gonePictures.length > 0 && <div className="overview-missing-line" title={gonePictures.map((image) => rel(image.path)).join('\n')}>{t('overview.missingImages', gonePictures.length)}</div>}
    </Group>}

    {files.length > 0 && <Group id="files" open={open.files} onToggle={toggle} icon={<IconFile size={14} />} label={t('overview.files')}
      summary={String(files.length)}>
      {files.slice(0, shownCount('files', files.length)).map((file) => (
        <FileLine key={file.path} path={rel(file.path)} full={file.path} missing={file.missing} locked={file.missing} onOpen={openAndClose(() => { void onOpenFile(file.path); })}
          preview={previewable(file) ? openAndClose(() => onPreview(file.path)) : undefined} />
      ))}
      {more('files', files.length)}
    </Group>}

    {failed && <div className="overview-failed" role="status"><span>{t('overview.failed')}</span><button type="button" className="text-btn" onClick={() => setAttempt((n) => n + 1)}>{t('common.retry')}</button></div>}

    {placeholder && <div className="overview-empty" role="status">{placeholder}</div>}

    {!placeholder && <div className="overview-foot">
      <span className="overview-readings">{footer}</span>
      <button type="button" className="overview-trace" onClick={openAndClose(onOpenTrace)}>
        {t('overview.trace')}
        <IconChevronRight size={12} />
      </button>
    </div>}
  </div>;
}

function rememberChoices(choices: Choices) {
  try { localStorage.setItem('calli.overview.folded', JSON.stringify(choices)); } catch { /* this page keeps it anyway */ }
}

/** The readings line, in the order a session is read: turns, speed, tokens, cache. Nothing is
 *  drawn before it has been measured, and a zero is left out so the line never reads as a fact
 *  that has not happened yet. */
function readings(stats: ReturnType<typeof useThreadStats>): string {
  if (!stats) return '';
  const parts: string[] = [];
  if (stats.turns > 0) parts.push(t('stats.turnsShort', stats.turns));
  if (stats.tokPerSec != null && stats.tokPerSec > 0) parts.push(speedLabel(stats.tokPerSec, stats.tokPerSecApprox));
  const total = stats.tokens?.input != null ? stats.tokens.input + (stats.tokens.output ?? 0) : null;
  if (total != null && total > 0) parts.push(t('overview.tokens', compactTokens(total)));
  if (stats.tokens?.input) {
    const hit = stats.tokens.cacheRead != null ? stats.tokens.cacheRead / stats.tokens.input : null;
    if (hit != null && hit > 0) parts.push(t('overview.cache', `${Math.round(hit * 100)}%`));
  }
  // No spaces around the dot: the four readings are one faint line inside a 300px panel, and the
  // dot alone separates them without pushing the cache share under the ellipsis.
  return parts.join('·');
}

function Group({ id, open, onToggle, icon, label, summary, children }: {
  id: Section; open: boolean; onToggle: (s: Section) => void;
  icon: ReactNode; label: string; summary: ReactNode; children: ReactNode;
}) {
  return <section className={`overview-group${open ? ' open' : ''}`}>
    <div className="overview-head">
      {/* The chevron leads, so the numbers on the right line up with the rows below them. */}
      <button type="button" className="overview-toggle" aria-expanded={open} onClick={() => onToggle(id)}>
        <span className="overview-chevron"><IconChevron size={12} open={false} /></span>
        <span className="overview-head-icon">{icon}</span>
        <strong>{label}</strong>
        <span className="overview-summary">{summary}</span>
      </button>
    </div>
    {open && <div className="overview-body">{children}</div>}
  </section>;
}

/** One member on one line: its mark, its name, and the word its last report ended with. What it
 *  was last asked or answered is one hover away. */
function MemberRow({ member, agents, onOpen }: { member: Coordination['members'][number]; agents: AgentInfo[]; onOpen: () => void }) {
  const icon = agents.find((a) => a.id === member.thread?.agent)?.icon;
  const state = member.thread?.waiting ? 'waiting' : member.thread?.status === 'running' ? 'running' : member.latest?.state === 'failed' ? 'failed' : 'idle';
  const prog = memberProgress(member);
  const word = prog === 'need' ? t('view.deliveredNeed') : prog === 'failed' ? t('team.failed')
    : prog === 'review' ? t('view.deliveredReview') : prog === 'progress' ? t('view.deliveredProgress')
    : memberStatus(member);
  const doing = deliveredPreview(state === 'running' || state === 'waiting' ? member.latest?.text ?? '' : member.latest?.result || member.latest?.text || '');
  return <button type="button" role="menuitem" className="overview-member" title={doing || member.name} onClick={onOpen}>
    <span className="overview-member-mark">{icon ? <AgentMark path={icon} size={14} /> : <IconAgents size={14} />}</span>
    <span className="overview-member-name">{member.name}</span>
    <span className={`overview-state ${prog ?? state}`}>{word}</span>
  </button>;
}

/**
 * A file the thread touched or named: one line, the name first, the folder faint after it, what
 * changed at the end. A page or a drawing carries a preview button of its own, apart from the row;
 * a file no longer on disk is quiet and cannot be opened.
 */
function FileLine({ path, full, missing, locked, tag, trailing, preview, onOpen }: {
  path: string; full: string; missing?: true; locked?: boolean; tag?: string; trailing?: ReactNode;
  preview?: () => void; onOpen: () => void;
}) {
  return <div className={`overview-rowwrap${missing ? ' missing' : ''}`}>
    <button type="button" role="menuitem" className="overview-row" title={missing ? `${full}\n${t('overview.missing')}` : full} disabled={locked} onClick={onOpen}>
      <PathName path={path} />
      {tag && <span className="overview-tag">{tag}</span>}
      {missing && <span className="overview-gone">{t('overview.missing')}</span>}
      {trailing}
    </button>
    {preview && <button type="button" className="overview-preview" aria-label={t('overview.preview')} title={t('overview.preview')} onClick={preview}>
      <IconPreview size={14} />
    </button>}
  </div>;
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

/** A thumbnail, fetched while it is on screen; the full picture opens over everything. A file that
 *  exists but cannot be read keeps its square, grey, with the reason on hover. */
function Picture({ path, name, load }: { path: string; name: string; load: (path: string) => Promise<Blob> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [large, setLarge] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    load(path).then(
      (blob) => { if (!live) return; made = URL.createObjectURL(blob); setUrl(made); },
      (reason: unknown) => { if (live) setError(reason instanceof Error && reason.message ? reason.message : t('view.noPreview')); },
    );
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path, load]);
  // A drawing has no background of its own and would be cropped by the square cell; it sits whole
  // on the picture background instead, with room around it.
  const vector = /\.svgz?$/i.test(path);
  return <>
    <button type="button" className={`overview-picture${vector ? ' vector' : ''}${error ? ' failed' : ''}`} title={error ? `${name}\n${error}` : name} disabled={!url} onClick={() => setLarge(true)}>
      {url ? <img src={url} alt={name} /> : <IconImage size={15} />}
    </button>
    {large && url && <Lightbox url={url} name={name} onClose={() => setLarge(false)} />}
  </>;
}
