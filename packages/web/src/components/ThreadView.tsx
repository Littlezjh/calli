import { Children, isValidElement, memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyText } from '../clipboard';
import { diffLines, numberLines } from '../diff';
import { nameAttachments, relativePath, shortenPaths } from '../paths';
import {
  durationLabel,
  groupByTurn,
  imagePathsIn,
  splitThinking,
  stepTitle,
  stepStatusLabel,
  type ApprovalOption,
  type FileChange,
  type FileDiff,
  type ImageRef,
  type Item,
  type Step,
} from '../timeline';
import { IconCheck, IconChevron, IconClose, IconCopy, IconFile, IconSearch, IconTerminal } from './icons';

interface Props {
  items: Item[];
  running: boolean;
  /** Every spelling of the thread's directory (as stored, and resolved), so paths can be shown relative to it. */
  roots: string[];
  /** Fetches an attached image. Must keep the same identity while the thread stays the same. */
  loadImage: (id: string) => Promise<Blob>;
  /** Fetches an image file from the thread's directory by path; rejects when there is no such image. Same identity rule. */
  loadFile: (path: string) => Promise<Blob>;
  onDecide: (approvalId: string, optionId: string | null) => void;
}

/** Lines of one diff shown before the rest is folded away. */
const MAX_DIFF_LINES = 400;

/** How many turns stay rendered before the rest folds into "上 N 条消息". */
const RECENT_TURNS = 30;

export function ThreadView({ items, running, roots, loadImage, loadFile, onDecide }: Props) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  const groups = useMemo(() => groupByTurn(items), [items]);
  // "Show everything" is remembered per thread; switching threads starts folded again.
  const threadKey = items[0]?.key ?? '';
  const [expandedFor, setExpandedFor] = useState<{ key: string; value: boolean }>({ key: '', value: false });
  const expanded = expandedFor.key === threadKey && expandedFor.value;
  const folded = !expanded && groups.length > RECENT_TURNS;
  const shown = folded ? groups.slice(groups.length - RECENT_TURNS) : groups;
  const hiddenCount = folded ? groups.length - shown.length : 0;
  const hiddenMessages = folded ? groups.slice(0, -RECENT_TURNS).reduce((n, g) => n + g.items.length, 0) : 0;

  const renderItems = (list: Item[]) =>
    list.map((item) => {
      switch (item.kind) {
        case 'user':
          return (
            <div key={item.key} className="row user" data-turn={item.turnId}>
              {item.images.length > 0 && (
                <div className="sent-images">
                  {item.images.map((img) => (
                    <SentImage key={img.id} image={img} load={loadImage} onOpen={setLightbox} />
                  ))}
                </div>
              )}
              {item.text && (
                <div className="bubble">
                  {item.fromTerminal && <span className="term-chip" title="这轮是在终端里发的">终端</span>}
                  {item.text}
                </div>
              )}
              {!item.text && item.fromTerminal && (
                <div className="bubble">
                  <span className="term-chip" title="这轮是在终端里发的">终端</span>
                </div>
              )}
            </div>
          );
        case 'assistant':
          if (!item.text) return null;
          return <AssistantMessage key={item.key} text={item.text} done={item.done} roots={roots} loadFile={loadFile} onOpen={setLightbox} />;
        case 'plan':
          return <PlanCard key={item.key} item={item} />;
        case 'work':
          return <WorkGroup key={item.key} item={item} roots={roots} />;
        case 'approval':
          return <ApprovalCard key={item.key} item={item} roots={roots} onDecide={onDecide} />;
        case 'changes':
          return <ChangesCard key={item.key} item={item} roots={roots} />;
        case 'actions':
          return (
            <div key={item.key} className="row message-actions">
              <CopyButton text={item.text} label="复制回答" />
            </div>
          );
        case 'error':
          return (
            <div key={item.key} className="row">
              <div className="error-box">{item.message}</div>
            </div>
          );
      }
    });

  return (
    <div className="thread">
      {folded && (
        <div className="row">
          <button className="older-messages" onClick={() => setExpandedFor({ key: threadKey, value: true })}>
            上 {hiddenMessages} 条消息
          </button>
        </div>
      )}
      {shown.map((g) => renderItems(g.items))}
      {running && (
        <div className="row">
          <div className="working">工作中…</div>
        </div>
      )}
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/** Copies on click and shows a tick for a moment, or says so when the browser refuses. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="quiet-btn"
      aria-label={label}
      title={state === 'failed' ? '复制失败，请手动选中文字' : state === 'done' ? '已复制' : label}
      onClick={async () => setState((await copyText(text)) ? 'done' : 'failed')}
    >
      {state === 'done' ? <IconCheck size={15} /> : <IconCopy size={15} />}
    </button>
  );
}

function plainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children);
  return '';
}

/** A fenced code block: a small header with the language and a copy button, then the code. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find((c) => isValidElement(c));
  const className = isValidElement<{ className?: string }>(code) ? (code.props.className ?? '') : '';
  const language = /language-([\w+#.-]+)/.exec(className)?.[1] ?? '';
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language}</span>
        <CopyButton text={plainText(children).replace(/\n$/, '')} label="复制代码" />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/**
 * An image in Markdown. One from the web is shown as it is. A local path cannot be loaded by the
 * browser (it is a file on the agent's host), so it is left out here and shown under the message.
 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  if (!src || !/^(https?:|data:image\/)/i.test(src)) return null;
  return <img src={src} alt={alt ?? ''} loading="lazy" />;
}

const MARKDOWN_COMPONENTS = { pre: CodeBlock, img: MarkdownImage };
const MARKDOWN_PLUGINS = [remarkGfm];

interface AssistantProps {
  text: string;
  done: boolean;
  roots: string[];
  loadFile: (path: string) => Promise<Blob>;
  onOpen: (url: string) => void;
}

/**
 * Parsing Markdown is the costly part of rendering a thread, and every streamed event re-renders
 * the list. Memoising on the props means only the message being written is parsed again.
 */
const AssistantMessage = memo(function AssistantMessage({ text, done, roots, loadFile, onOpen }: AssistantProps) {
  // Looked for once the message is complete: a path that is still being typed would not be found.
  const images = useMemo(() => (done ? imagePathsIn(text) : []), [done, text]);
  return (
    <div className="row assistant">
      <div className="markdown">
        <Markdown remarkPlugins={MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {text}
        </Markdown>
      </div>
      {images.length > 0 && (
        <div className="file-images">
          {images.map((path) => (
            <FileImage key={path} path={path} roots={roots} load={loadFile} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
});

/** An image file the answer points at. Shown only if the daemon confirms it is one; otherwise nothing. */
function FileImage({ path, roots, load, onOpen }: { path: string; roots: string[]; load: (path: string) => Promise<Blob>; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    load(path)
      .then((blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => undefined); // not an image, not in this thread's directory, or gone
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path, load]);

  if (!url) return null;
  return (
    <figure className="file-image">
      <button type="button" onClick={() => onOpen(url)} aria-label={`查看大图：${path}`}>
        <img src={url} alt={path} />
      </button>
      <figcaption title={path}>{relativePath(path, roots)}</figcaption>
    </figure>
  );
}

/** The agent's own task list for the turn: what is done, what it is on, what is left. */
function PlanCard({ item }: { item: Extract<Item, { kind: 'plan' }> }) {
  const completed = item.entries.filter((e) => e.status === 'completed').length;
  return (
    <div className="row">
      <div className="plan">
        <div className="plan-head">
          <span>计划</span>
          <span className="muted">
            {completed}/{item.entries.length}
          </span>
        </div>
        <ol className="plan-list">
          {item.entries.map((entry, i) => {
            // Once the turn is over nothing is "in progress" any more; what was not finished is simply not done.
            const state = entry.status === 'completed' ? 'completed' : entry.status === 'in_progress' && !item.done ? 'active' : 'pending';
            return (
              <li key={i} className={`plan-entry ${state}`}>
                <span className="plan-mark" aria-hidden="true">
                  {state === 'completed' && <IconCheck size={12} />}
                </span>
                <span className="plan-text">{entry.content}</span>
                <span className="sr-only">{state === 'completed' ? '（已完成）' : state === 'active' ? '（进行中）' : '（未开始）'}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function SentImage({ image, load, onOpen }: { image: ImageRef; load: (id: string) => Promise<Blob>; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    load(image.id)
      .then((blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [image.id, load]);

  if (failed) return <div className="sent-image missing">图片无法加载</div>;
  if (!url) return <div className="sent-image loading" aria-label="正在加载图片" />;
  return (
    <button type="button" className="sent-image" onClick={() => onOpen(url)} aria-label="查看大图">
      <img src={url} alt="发送的图片" />
    </button>
  );
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="图片" onClick={onClose}>
      <img src={url} alt="放大的图片" />
      <button type="button" className="lightbox-close" aria-label="关闭" onClick={onClose}>
        <IconClose size={18} />
      </button>
    </div>
  );
}

function WorkGroup({ item, roots }: { item: Extract<Item, { kind: 'work' }>; roots: string[] }) {
  // Open while the turn is running so progress is visible; collapsed once it finishes.
  const [open, setOpen] = useState(!item.done);
  // Collapse once the turn finishes; the user can still expand it afterwards.
  useEffect(() => {
    if (item.done) setOpen(false);
  }, [item.done]);
  const label = !item.done ? '工作中' : item.timed ? `用时 ${durationLabel(item.startedAt, item.endedAt)}` : '已处理';
  const count = item.steps.length;
  return (
    <div className="row work">
      <button className="work-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{label}</span>
        {count > 0 && <span className="muted">· {count} 步</span>}
        <IconChevron size={14} open={open} />
      </button>
      {open && (
        <div className="work-body">
          <ThinkingBlock item={item} />
          {item.steps.map((s) => (
            <StepRow key={s.id} step={s} roots={roots} />
          ))}
        </div>
      )}
    </div>
  );
}

/** While running: how many thinking paragraphs stay visible before the rest folds away. */
const THINKING_VISIBLE = 4;

/**
 * The agent's thinking for one work group, as its own collapsible section: expanded with the last
 * few paragraphs while the turn runs, folded to one "思考 · X 秒" line afterwards. That way a long
 * stream never pushes the step list off screen.
 */
function ThinkingBlock({ item }: { item: Extract<Item, { kind: 'work' }> }) {
  const paragraphs = useMemo(() => splitThinking(item.reasoning), [item.reasoning]);
  const [open, setOpen] = useState(!item.done);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (item.done) setOpen(false);
    else setShowAll(false);
  }, [item.done]);
  if (paragraphs.length === 0) return null;

  const hidden = showAll ? 0 : Math.max(0, paragraphs.length - THINKING_VISIBLE);
  const visible = paragraphs.slice(hidden);
  const secs = item.thinkStart && item.thinkEnd ? durationLabel(item.thinkStart, item.thinkEnd) : '';

  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{item.done ? `思考${secs ? ` · ${secs}` : ''}` : '思考中'}</span>
        <IconChevron size={13} open={open} />
      </button>
      {open && (
        <>
          {hidden > 0 && (
            <button className="thinking-more" onClick={() => setShowAll(true)}>
              更早的 {hidden} 段
            </button>
          )}
          {visible.map((p, i) => (
            <p key={i} className="thinking-para">
              {p}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

const STEP_ICONS: Record<string, (p: { size?: number }) => JSX.Element> = {
  execute: IconTerminal,
  search: IconSearch,
};

function StepRow({ step, roots }: { step: Step; roots: string[] }) {
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICONS[step.kind] ?? IconFile;
  // An edit is best shown as its diff; the raw arguments would repeat the same text as JSON.
  const showInput = step.input !== undefined && step.diffs.length === 0 && JSON.stringify(step.input) !== '{}';
  const hasDetail = showInput || step.diffs.length > 0 || Boolean(step.output);
  return (
    <div className={`step ${step.status}`}>
      <button className="step-head" onClick={() => hasDetail && setOpen((v) => !v)} disabled={!hasDetail} aria-expanded={open}>
        <Icon size={15} />
        <span className="step-title">{nameAttachments(shortenPaths(stepTitle(step), roots)) || step.kind}</span>
        <span className="step-status">{stepStatusLabel(step)}</span>
      </button>
      {open && (
        <div className="step-detail">
          {showInput && <pre>{JSON.stringify(step.input, null, 2)}</pre>}
          {step.diffs.length > 0 && <DiffView diffs={step.diffs} />}
          {step.output && <pre>{step.output}</pre>}
        </div>
      )}
    </div>
  );
}

function Stats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="diff-stats">
      <span className="diff-added">+{added}</span>
      <span className="diff-removed">−{removed}</span>
    </span>
  );
}

/** One or more edited regions of a file, as numbered lines with added and removed lines tinted. */
function DiffView({ diffs }: { diffs: FileDiff[] }) {
  const regions = useMemo(() => diffs.map((d) => numberLines(diffLines(d.oldText, d.newText))), [diffs]);
  let budget = MAX_DIFF_LINES;
  return (
    <div className="diff">
      {regions.map((lines, i) => {
        const shown = lines.slice(0, Math.max(0, budget));
        budget -= shown.length;
        const hidden = lines.length - shown.length;
        return (
          <div key={i} className="diff-region">
            {shown.map((line, n) => (
              <div key={n} className={`diff-line ${line.type}`}>
                <span className="diff-no">{line.oldNo ?? ''}</span>
                <span className="diff-no">{line.newNo ?? ''}</span>
                <span className="diff-sign">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}</span>
                <span className="diff-text">{line.text || ' '}</span>
              </div>
            ))}
            {hidden > 0 && <div className="diff-more">还有 {hidden} 行没有显示</div>}
          </div>
        );
      })}
    </div>
  );
}

/** What a finished turn changed: a list of files, each opening to its diff. */
function ChangesCard({ item, roots }: { item: Extract<Item, { kind: 'changes' }>; roots: string[] }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  return (
    <div className="row">
      <div className="changes">
        <div className="changes-head">
          <span>已更改 {item.files.length} 个文件</span>
          <Stats added={item.added} removed={item.removed} />
        </div>
        {item.files.map((file: FileChange) => {
          const open = openPath === file.path;
          return (
            <div key={file.path} className="changes-file">
              <button className="changes-row" onClick={() => setOpenPath(open ? null : file.path)} aria-expanded={open}>
                <span className="changes-chevron">
                  <IconChevron size={13} open={open} />
                </span>
                <IconFile size={15} />
                <span className="changes-path" title={file.path}>
                  {relativePath(file.path, roots)}
                </span>
                <Stats added={file.added} removed={file.removed} />
              </button>
              {open && <DiffView diffs={file.diffs} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The button text for an approval option. The agent's own wording is kept where it carries the scope. */
function optionLabel(option: ApprovalOption): string {
  switch (option.kind) {
    case 'allow_once':
      return '允许这一次';
    case 'allow_always':
      return '始终允许';
    case 'reject_once':
      return '拒绝';
    case 'reject_always':
      return '始终拒绝';
    default:
      return option.name;
  }
}

function ApprovalCard({
  item,
  roots,
  onDecide,
}: {
  item: Extract<Item, { kind: 'approval' }>;
  roots: string[];
  onDecide: (approvalId: string, optionId: string | null) => void;
}) {
  const pending = item.decision === null;
  const canReject = item.options.some((o) => o.kind.startsWith('reject'));
  // "Always allow" means different things each time (this file, this folder, this command), so say which.
  const always = item.options.find((o) => o.kind === 'allow_always');
  let primaryUsed = false;
  return (
    <div className="row">
      <div className={`approval${pending ? ' pending' : ''}`}>
        <div className="approval-title">
          {pending && <span className="dot waiting" aria-hidden="true" />}
          <span>{shortenPaths(item.title, roots)}</span>
        </div>
        {item.command && <pre className="approval-command">{item.command}</pre>}
        {item.diffs.length > 0 && (
          <div className="approval-preview">
            <DiffView diffs={item.diffs} />
          </div>
        )}
        {pending ? (
          <>
            <div className="approval-actions">
              {item.options.map((o) => {
                const primary = o.kind === 'allow_once' && !primaryUsed;
                if (primary) primaryUsed = true;
                return (
                  <button key={o.optionId} className={primary ? 'primary' : 'ghost'} title={o.name} onClick={() => onDecide(item.approvalId, o.optionId)}>
                    {optionLabel(o)}
                  </button>
                );
              })}
              {!canReject && (
                <button className="ghost" onClick={() => onDecide(item.approvalId, null)}>
                  取消
                </button>
              )}
            </div>
            {always && <div className="approval-note">始终允许：{always.name}</div>}
          </>
        ) : (
          <div className="approval-result">{decisionLabel(item)}</div>
        )}
      </div>
    </div>
  );
}

/** What the user chose, in words. Falls back to the option's own name for kinds we do not know. */
function decisionLabel(item: Extract<Item, { kind: 'approval' }>): string {
  const d = item.decision;
  if (!d) return '';
  if ('cancelled' in d) return '已取消';
  const option = item.options.find((o) => o.optionId === d.optionId);
  switch (option?.kind) {
    case 'allow_once':
      return '已允许这一次';
    case 'allow_always':
      return '已允许，之后不再询问';
    case 'reject_once':
      return '已拒绝';
    case 'reject_always':
      return '已拒绝，之后不再询问';
    default:
      return `已选择：${option?.name ?? d.optionId}`;
  }
}
