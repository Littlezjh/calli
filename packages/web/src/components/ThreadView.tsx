import { Children, createContext, isValidElement, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyText } from '../clipboard';
import { diffLines, numberLines } from '../diff';
import { pictureUrl } from '../images';
import { IMAGE_FILE, linkTarget, nameAttachments, relativePath, shortenPaths } from '../paths';
import {
  clockLabel,
  durationLabel,
  groupByTurn,
  imagePathsIn,
  runSummary,
  splitThinking,
  splitNotes,
  splitUserQuote,
  thinkingPreview,
  stepActive,
  stepTitle,
  stepStatusLabel,
  workSections,
  type ApprovalOption,
  type FileChange,
  type FileDiff,
  type ImageRef,
  type Item,
  type Note,
  type Step,
  type Thought,
  type WorkSection,
} from '../timeline';
import { Lightbox } from './Lightbox';
import { IconCheck, IconChevron, IconClose, IconCopy, IconEdit, IconFile, IconFork, IconGlobe, IconQuote, IconSearch, IconTerminal, IconWorktree } from './icons';

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
  /** The thread's log continues below what is in memory: one more history page can be fetched. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** Copies the thread as it stands and opens the copy. Missing when the agent cannot fork, or there is no session yet. */
  onFork?: (turnId: string) => void;
  /** The agent can end a copy at any finished turn, so every answer gets the button, not only the last. */
  forkAnyTurn?: boolean;
}

/** Lines of one diff shown before the rest is folded away. */
const MAX_DIFF_LINES = 400;

/** How many turns stay rendered before the rest folds into "上 N 条消息". */
const RECENT_TURNS = 30;
/** Scrolling up to within this distance of the top unfolds or fetches the earlier turns. */
const NEAR_TOP_PX = 600;

export function ThreadView({ items, running, roots, loadImage, loadFile, onDecide, hasOlder, loadingOlder, onLoadOlder, onFork, forkAnyTurn }: Props) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  // A picture opened from a link in an answer is fetched for the occasion, and let go of when it is closed.
  const fetched = useRef<string | null>(null);
  const release = () => {
    if (fetched.current) URL.revokeObjectURL(fetched.current);
    fetched.current = null;
  };
  const closeLightbox = useCallback(() => {
    setLightbox(null);
    release();
  }, []);
  const openPicture = useCallback(
    async (path: string) => {
      const url = await pictureUrl(await loadFile(path));
      release();
      fetched.current = url;
      setLightbox(url);
    },
    [loadFile],
  );
  useEffect(() => release, []);
  const groups = useMemo(() => groupByTurn(items), [items]);
  // "Show everything" is remembered per thread; switching threads starts folded again.
  const threadKey = items[0]?.key ?? '';
  const [expandedFor, setExpandedFor] = useState<{ key: string; value: boolean }>({ key: '', value: false });
  const expanded = expandedFor.key === threadKey && expandedFor.value;
  const folded = !expanded && groups.length > RECENT_TURNS;
  const shown = folded ? groups.slice(groups.length - RECENT_TURNS) : groups;
  const hiddenCount = folded ? groups.length - shown.length : 0;
  const hiddenMessages = folded ? groups.slice(0, -RECENT_TURNS).reduce((n, g) => n + g.items.length, 0) : 0;

  // Scrolling up near the top brings in what is above, like Codex: first the folded turns, then
  // the pages the daemon has not sent yet. Only upward movement counts, so opening a thread (which
  // starts at the top and is pinned down) and the scroll restore after a load trigger nothing.
  const threadRef = useRef<HTMLDivElement | null>(null);
  const restoreFromBottom = useRef<number | null>(null);
  const expand = () => {
    const scroller = threadRef.current?.closest<HTMLElement>('.scroller');
    if (scroller) restoreFromBottom.current = scroller.scrollHeight - scroller.scrollTop;
    setExpandedFor({ key: threadKey, value: true });
  };
  const reachTop = useRef(() => {});
  reachTop.current = () => {
    if (folded) expand();
    else if (hasOlder && !loadingOlder) onLoadOlder?.();
  };
  // Unfolded turns land above the viewport; keep the same content in view.
  useLayoutEffect(() => {
    const scroller = threadRef.current?.closest<HTMLElement>('.scroller');
    if (scroller && restoreFromBottom.current !== null) scroller.scrollTop = scroller.scrollHeight - restoreFromBottom.current;
    restoreFromBottom.current = null;
  }, [expanded]);
  useEffect(() => {
    const scroller = threadRef.current?.closest<HTMLElement>('.scroller');
    if (!scroller) return;
    let lastTop = scroller.scrollTop;
    let touchY = 0;
    const onScroll = () => {
      const top = scroller.scrollTop;
      if (top < lastTop && top < NEAR_TOP_PX) reachTop.current();
      lastTop = top;
    };
    // Already at the top (or too short to scroll) there is no scroll event; the gesture itself says "up".
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && scroller.scrollTop < NEAR_TOP_PX) reachTop.current();
    };
    const onTouchStart = (e: TouchEvent) => void (touchY = e.touches[0]?.clientY ?? 0);
    const onTouchMove = (e: TouchEvent) => {
      if ((e.touches[0]?.clientY ?? 0) > touchY + 10 && scroller.scrollTop < NEAR_TOP_PX) reachTop.current();
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
    };
  }, []);
  // A fork from the last answer copies the whole thread; it is offered while that answer is the
  // last thing in it. Where the agent can end a copy at an earlier turn, every answer offers one.
  // The mark a fork starts with is not part of the conversation: the answer above it is still the last.
  const tail = [...items].reverse().find((it) => it.kind !== 'fork');
  const lastKey = tail?.kind === 'actions' ? tail.key : null;

  const renderItems = (list: Item[]) =>
    list.map((item) => {
      switch (item.kind) {
        case 'user': {
          // Notes (and the older single quote) ride in the message text; drawn apart here.
          const noted = splitNotes(item.text);
          const { quote, body } = noted.notes.length ? { quote: null, body: noted.body } : splitUserQuote(item.text);
          return (
            <div key={item.key} className="row user" data-turn={item.turnId}>
              {item.images.length > 0 && (
                <div className="sent-images">
                  {item.images.map((img) => (
                    <SentImage key={img.id} image={img} load={loadImage} onOpen={setLightbox} />
                  ))}
                </div>
              )}
              {noted.notes.length > 0 && <SentNotes notes={noted.notes} />}
              {quote !== null && (
                <div className="bubble-quote" title={quote}>
                  {quote}
                </div>
              )}
              {body && (
                <div className="bubble">
                  {item.fromTerminal && <span className="term-chip" title="这轮是在终端里发的">终端</span>}
                  {body}
                </div>
              )}
              {!body && item.fromTerminal && (
                <div className="bubble">
                  <span className="term-chip" title="这轮是在终端里发的">终端</span>
                </div>
              )}
            </div>
          );
        }
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
        case 'stopped': {
          const time = item.timed ? durationLabel(item.startedAt, item.endedAt) : '';
          return (
            <div key={item.key} className="row work">
              <div className="work-toggle stopped">{stoppedLabel(time)}</div>
            </div>
          );
        }
        case 'actions':
          return (
            <div key={item.key} className="row message-actions">
              <CopyButton text={item.text} label="复制回答" />
              {onFork && (forkAnyTurn || item.key === lastKey) && (
                <button
                  type="button"
                  className="quiet-btn"
                  aria-label="分叉"
                  title={item.key === lastKey ? '分叉：复制这个线程，从这里另走一条路' : '分叉：从这一轮之后另走一条路，后面的不带过去'}
                  onClick={() => onFork(item.turnId)}
                >
                  <IconFork size={15} />
                </button>
              )}
              {item.at && (
                <time className="message-time" dateTime={item.at} title={new Date(item.at).toLocaleString('zh-CN')}>
                  {clockLabel(item.at)}
                </time>
              )}
            </div>
          );
        case 'error':
          return (
            <div key={item.key} className="row">
              <div className="error-box">{item.message}</div>
            </div>
          );
        case 'fork':
          return (
            <div key={item.key} className="row fork-mark" role="separator" aria-label={item.branch ? `从这里分叉，在工作树 ${item.branch}` : '从这里分叉'}>
              <span className="fork-mark-label">
                {item.branch ? <IconWorktree size={15} /> : <IconFork size={15} />}
                从这里分叉
                {item.branch && <span className="fork-mark-branch">{item.branch}</span>}
              </span>
            </div>
          );
      }
    });

  return (
    <div className="thread" ref={threadRef}>
      <FilePictures.Provider value={openPicture}>
        {/* Scrolling up loads these on its own; the buttons stay for keyboards and screen readers. */}
        {folded && (
          <div className="row">
            <button className="older-messages" onClick={expand}>
              上 {hiddenMessages} 条消息
            </button>
          </div>
        )}
        {!folded && hasOlder && (
          <div className="row older-row">
            {loadingOlder ? (
              <span className="spinner" role="status" aria-label="正在加载更早的消息" />
            ) : (
              <button className="older-messages" onClick={onLoadOlder}>
                加载更早的消息
              </button>
            )}
          </div>
        )}
        {shown.map((g) => renderItems(g.items))}
        {running && (
          <div className="row">
            <div className="working">工作中…</div>
          </div>
        )}
      </FilePictures.Provider>
      {lightbox && <Lightbox url={lightbox} onClose={closeLightbox} />}
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

/**
 * Opens a picture on the agent's host at full size; rejects when the daemon has no such picture.
 * Reaches the links through context: the components Markdown is given stay the same objects, so a
 * message is not parsed again for it.
 */
const FilePictures = createContext<((path: string) => Promise<void>) | null>(null);

/**
 * A link in an answer. One to the web opens in a tab of its own, so the hub stays where it is.
 * One to a file is on the agent's host, where the browser cannot follow: a picture opens at full
 * size, anything else gives its path to the clipboard, for a terminal or an editor.
 */
function MarkdownLink({ href, title, children }: { href?: string; title?: string; children?: ReactNode }) {
  const openPicture = useContext(FilePictures);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 1600);
    return () => clearTimeout(timer);
  }, [note]);

  const target = linkTarget(href ?? '');
  if (target.kind === 'web') {
    return (
      <a href={target.url} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  if (target.kind === 'anchor') return <a href={href}>{children}</a>;
  if (target.kind === 'none') return <>{children}</>;

  const { path } = target;
  const picture = openPicture && IMAGE_FILE.test(path);
  const copy = async () => setNote((await copyText(path)) ? '已复制路径' : '复制失败，请手动选中');
  const act = () => {
    // The path is copied in the click itself where it can be: a browser may refuse once a fetch has come between.
    if (picture) openPicture(path).catch(copy);
    else void copy();
  };
  return (
    <a
      className="file-link"
      role="button"
      tabIndex={0}
      title={title ?? (picture ? `查看图片：${path}` : `复制路径：${path}`)}
      onClick={act}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        act();
      }}
    >
      {children}
      {note && (
        <span className="file-link-note" role="status">
          {note}
        </span>
      )}
    </a>
  );
}

const MARKDOWN_COMPONENTS = { pre: CodeBlock, img: MarkdownImage, a: MarkdownLink };
const MARKDOWN_PLUGINS = [remarkGfm];
/**
 * Markdown drops addresses it does not know, `file://` among them, leaving a link that reloads
 * the page. Every address is kept instead: links and images are drawn by the components above,
 * which decide what each may do.
 */
const keepUrl = (url: string) => url;

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
        <Markdown remarkPlugins={MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS} urlTransform={keepUrl}>
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
      .then(pictureUrl)
      .then((address) => {
        if (!alive) return void URL.revokeObjectURL(address);
        made = address;
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

function WorkGroup({ item, roots }: { item: Extract<Item, { kind: 'work' }>; roots: string[] }) {
  // Open while the turn runs so progress is visible; collapsed once it finishes.
  const [open, setOpen] = useState(!item.done);
  // Collapse once the turn finishes; the user can still expand it afterwards.
  useEffect(() => {
    if (item.done) setOpen(false);
  }, [item.done]);
  const time = item.done && item.timed ? durationLabel(item.startedAt, item.endedAt) : '';
  const label = !item.done ? '工作中' : item.stopped ? stoppedLabel(time) : time ? `用时 ${time}` : '已处理';
  const count = item.steps.length;
  const sections = workSections(item.entries);
  return (
    <div className="row work">
      <button className="work-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{label}</span>
        {count > 0 && <span className="muted">· {count} 步</span>}
        <IconChevron size={14} open={open} />
      </button>
      {open && (
        <div className="work-body">
          {sections.map((section, i) =>
            section.kind === 'note' ? (
              <WorkNote key={section.key} text={section.text} />
            ) : (
              // Only the stretch at the end of a running turn is still going on.
              <StepRun key={section.key} run={section} live={!item.done && i === sections.length - 1} roots={roots} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Something the agent said between two things it did. Memoised like an answer: Markdown is costly to parse. */
const WorkNote = memo(function WorkNote({ text }: { text: string }) {
  return (
    <div className="work-note markdown">
      <Markdown remarkPlugins={MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS} urlTransform={keepUrl}>
        {text}
      </Markdown>
    </div>
  );
});

/** Once thinking is over and opened up: how many of its paragraphs show before the rest folds away. */
const THINKING_VISIBLE = 4;

/**
 * One stretch of the agent's thinking, kept small: while it is being thought, a line or two of
 * where it has got to; afterwards a single "思考 · X 秒" line. Either opens up to the whole text.
 * A model can think for minutes before it acts, and that must not fill the screen.
 */
const ThinkingBlock = memo(function ThinkingBlock({ thought, live }: { thought: Thought; live: boolean }) {
  const paragraphs = useMemo(() => splitThinking(thought.text), [thought.text]);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (paragraphs.length === 0) return null;

  const hidden = showAll ? 0 : Math.max(0, paragraphs.length - THINKING_VISIBLE);
  const secs = durationLabel(thought.startedAt, thought.endedAt);

  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{live ? '思考中' : `思考 · ${secs}`}</span>
        <IconChevron size={13} open={open} />
      </button>
      {open ? (
        <div className="thinking-body">
          {hidden > 0 && (
            <button className="thinking-more" onClick={() => setShowAll(true)}>
              更早的 {hidden} 段
            </button>
          )}
          {paragraphs.slice(hidden).map((p, i) => (
            <p key={i} className="thinking-para">
              {p}
            </p>
          ))}
        </div>
      ) : (
        live && (
          <div className="thinking-body">
            <p className="thinking-para thinking-live">{thinkingPreview(paragraphs)}</p>
          </div>
        )
      )}
    </div>
  );
});

const STEP_ICONS: Record<string, (p: { size?: number }) => JSX.Element> = {
  execute: IconTerminal,
  search: IconSearch,
};

/** The icon of a folded run: what there was most of in it. Looking around, by file or by search, is one thing. */
const RUN_ICONS: Record<string, (p: { size?: number }) => JSX.Element> = {
  execute: IconTerminal,
  search: IconSearch,
  read: IconSearch,
  fetch: IconGlobe,
  edit: IconEdit,
};

/** From this many finished calls on, a run is one line that counts them. Fewer are shown as they are. */
const RUN_FOLD_MIN = 2;

/**
 * A stretch of thinking and tool calls between two things the agent said. Several calls fold into
 * one line that counts them by kind ("已浏览 2 个文件，搜索 1 次"), the way Codex does, and open to
 * the calls themselves. In a run that is still going on, what is in flight stays on screen as
 * itself; only what is over is folded.
 */
function StepRun({ run, live, roots }: { run: Extract<WorkSection, { kind: 'run' }>; live: boolean; roots: string[] }) {
  const [open, setOpen] = useState(false);
  const last = run.entries.length - 1;
  const inFlight = (i: number) => {
    const entry = run.entries[i];
    return live && (entry.kind === 'step' ? stepActive(entry.step) : i === last);
  };
  const row = (i: number) => {
    const entry = run.entries[i];
    return entry.kind === 'thought' ? (
      <ThinkingBlock key={entry.thought.key} thought={entry.thought} live={live && i === last} />
    ) : (
      <StepRow key={entry.step.id} step={entry.step} roots={roots} />
    );
  };
  const indexes = run.entries.map((_, i) => i);
  const over = indexes.filter((i) => !inFlight(i));
  const overSteps = over.map((i) => run.entries[i]).flatMap((e) => (e.kind === 'step' ? [e.step] : []));
  if (overSteps.length < RUN_FOLD_MIN) return <>{indexes.map(row)}</>;

  const summary = runSummary(overSteps);
  const Icon = RUN_ICONS[summary.kind] ?? IconFile;
  return (
    <>
      <div className="step-run">
        <button className="step-head run-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Icon size={15} />
          <span className="run-title">{summary.text}</span>
          {summary.failed > 0 && <span className="run-failed">{summary.failed} 次失败</span>}
          <IconChevron size={13} open={open} />
        </button>
        {open && <div className="run-body">{over.map(row)}</div>}
      </div>
      {indexes.filter(inFlight).map(row)}
    </>
  );
}

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

/** The notes a message went out with: one quiet chip, opened to read them, like Codex. */
function SentNotes({ notes }: { notes: Note[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="notes-chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconQuote size={12} />
        {notes.length} 条注释
        <IconChevron size={12} open={open} />
      </button>
      {open && (
        <ol className="sent-notes">
          {notes.map((n, i) => (
            <li key={i} className="note-strip">
              <span className="note-num">{i + 1}</span>
              <span className="note-body">
                <span className="note-quote">{n.quote}</span>
                {n.comment && <span className="note-comment">{n.comment}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** A turn the user stopped, said the way Codex says it. */
function stoppedLabel(time: string): string {
  return time ? `你在 ${time} 后停止了` : '已停止';
}
