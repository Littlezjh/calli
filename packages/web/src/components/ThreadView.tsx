import { Children, createContext, Fragment, isValidElement, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { renderMermaidDiagram } from '../mermaid';
import { copyText } from '../clipboard';
import { diffLines, numberLines } from '../diff';
import { pictureUrl, svgPicture } from '../images';
import { SentVideo } from './VideoPreview';
import { IMAGE_FILE, linkTarget, nameAttachments, relativePath, shortenPaths } from '../paths';
import {
  clockLabel,
  compactionLabel,
  deliveredPreview,
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
  type CoordinationNote,
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
import { PlanCopyButton, PlanDownloadButton, PlanReader } from './PlanReader';
import { ActivityIcon, IconAgents, IconCheck, IconChevron, IconClose, IconCompact, IconCopy, IconFile, IconFork, IconHand, IconList, IconQuote, IconWorktree } from './icons';
import { t } from '../i18n';

interface Props {
  items: Item[];
  /** Every spelling of the thread's directory (as stored, and resolved), so paths can be shown relative to it. */
  roots: string[];
  /** Fetches an attached image. Must keep the same identity while the thread stays the same. */
  loadImage: (id: string) => Promise<Blob>;
  /** Fetches an image file from the thread's directory by path; rejects when there is no such image. Same identity rule. */
  loadFile: (path: string) => Promise<Blob>;
  /** Opens a file an answer links to in the file viewer. Rejects when the thread cannot show it. */
  onOpenFile?: (path: string) => Promise<void>;
  /** Renders a page the agent wrote, from the thread's directory. HTML and SVG files. */
  onPreview?: (path: string) => void;
  /** The thread's log continues below what is in memory: one more history page can be fetched. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** Copies the thread as it stands and opens the copy. Missing when the agent cannot fork, or there is no session yet. */
  onFork?: (turnId: string) => void;
  /**
   * When the last turn failed because the agent's plan ran out: hand the thread to another agent.
   * `label` names the agent one click goes to; `choose` opens the handover to pick another.
   */
  takeover?: { label: string; go: () => void; choose: () => void; busy?: boolean } | null;
  /** The agent can end a copy at any finished turn, so every answer gets the button, not only the last. */
  forkAnyTurn?: boolean;
}

/** Lines of one diff shown before the rest is folded away. */
const MAX_DIFF_LINES = 400;

/** How many turns stay rendered before the rest folds into "N earlier messages". */
const RECENT_TURNS = 30;
/** Scrolling up to within this distance of the top unfolds or fetches the earlier turns. */
const NEAR_TOP_PX = 600;

export function ThreadView({ items, roots, loadImage, loadFile, onOpenFile, onPreview, hasOlder, loadingOlder, onLoadOlder, onFork, forkAnyTurn, takeover }: Props) {
  const [lightbox, setLightbox] = useState<{ url: string; name?: string } | null>(null);
  const show = useCallback((url: string, name?: string) => setLightbox({ url, name }), []);
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
      setLightbox({ url, name: path });
    },
    [loadFile],
  );
  useEffect(() => release, []);
  const pictures = useMemo(() => ({ openFile: openPicture, show, openText: onOpenFile }), [openPicture, show, onOpenFile]);
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
          if (item.coordination) return <DeliveredNote key={item.key} turnId={item.turnId} note={item.coordination} text={item.text} />;
          // Notes (and the older single quote) ride in the message text; drawn apart here.
          const noted = splitNotes(item.text);
          const { quote, body } = noted.notes.length ? { quote: null, body: noted.body } : splitUserQuote(item.text);
          return (
            <div key={item.key} className="row user" data-turn={item.turnId}>
              {item.images.length > 0 && (
                <div className="sent-images">
                  {item.images.map((img) => (
                    <SentImage key={img.id} image={img} load={loadImage} onOpen={show} />
                  ))}
                </div>
              )}
              {noted.notes.length > 0 && <SentNotes notes={noted.notes} />}
              {item.videos?.map(video => <SentVideo key={video.id} video={video} load={loadImage} />)}
              {quote !== null && (
                <div className="bubble-quote" title={quote}>
                  {quote}
                </div>
              )}
              {body && (
                <div className="bubble">
                  {item.fromTerminal && <span className="term-chip" title={t('view.fromTerminal')}>{t('term.title')}</span>}
                  {item.scheduled && <span className="term-chip" title={t('view.fromSchedule')}>{t('view.scheduled')}</span>}
                  {item.workMode === 'plan' && <span className="term-chip">{t('view.plan')}</span>}
                  {body}
                </div>
              )}
              {!body && (item.fromTerminal || item.scheduled) && (
                <div className="bubble">
                  {item.fromTerminal && <span className="term-chip" title={t('view.fromTerminal')}>{t('term.title')}</span>}
                  {item.scheduled && <span className="term-chip" title={t('view.fromSchedule')}>{t('view.scheduled')}</span>}
                </div>
              )}
            </div>
          );
        }
        case 'input':
          // A native plan approval shows its plan as the card; the decision itself is asked in the
          // sheet, and answered or not, the card stays where it stood.
          if (item.inputKind === 'plan' && item.plan) {
            return (
              <Fragment key={item.key}>
                <ProposalCard text={item.plan} />
                <TraceLine mark={planTrace(item)} />
              </Fragment>
            );
          }
          // An ordinary question leaves just a trace once it has been answered; while it waits,
          // the sheet at the bottom is where it is asked.
          return <TraceLine key={item.key} mark={questionTrace(item)} />;
        case 'proposal':
          return <ProposalCard key={item.key} text={item.text} streaming={!item.done} />;
        case 'assistant':
          if (!item.text) return null;
          return <AssistantMessage key={item.key} text={item.text} done={item.done} roots={roots} loadFile={loadFile} onOpen={show} />;
        case 'plan':
          return <PlanCard key={item.key} item={item} />;
        case 'work':
          return <WorkGroup key={item.key} item={item} roots={roots} />;
        case 'approval':
          return <TraceLine key={item.key} mark={approvalTrace(item, roots)} />;
        case 'changes':
          return <ChangesCard key={item.key} item={item} roots={roots} onPreview={onPreview} />;
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
              <CopyButton text={item.text} label={t('view.copyAnswer')} />
              {onFork && (forkAnyTurn || item.key === lastKey) && (
                <button
                  type="button"
                  className="quiet-btn"
                  aria-label={t('sidebar.fork')}
                  title={item.key === lastKey ? t('view.forkLast') : t('view.forkHere')}
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
              <div className="error-box">
                {item.message}
                {item.planExhausted && takeover && item === items[items.length - 1] && (
                  <div className="error-actions">
                    <button className="primary" onClick={takeover.go} disabled={takeover.busy}>
                      <IconHand size={15} /> {takeover.busy ? t('view.handingOver') : t('view.handTo', takeover.label)}
                    </button>
                    <button className="ghost" onClick={takeover.choose} disabled={takeover.busy}>{t('view.chooseOther')}</button>
                  </div>
                )}
              </div>
            </div>
          );
        case 'fork':
          return (
            <div key={item.key} className="row fork-mark" role="separator" aria-label={item.branch ? t('view.forkedInWorktree', item.branch) : t('view.forkedHere')}>
              <span className="fork-mark-label">
                {item.branch ? <IconWorktree size={15} /> : <IconFork size={15} />}
                {t('view.forkedHere')}
                {item.branch && <span className="fork-mark-branch">{item.branch}</span>}
              </span>
            </div>
          );
      }
    });

  return (
    <div className="thread" ref={threadRef}>
      <Pictures.Provider value={pictures}>
        {/* Scrolling up loads these on its own; the buttons stay for keyboards and screen readers. */}
        {folded && (
          <div className="row">
            <button className="older-messages" onClick={expand}>
              {t('view.older', hiddenMessages)}
            </button>
          </div>
        )}
        {!folded && hasOlder && (
          <div className="row older-row">
            {loadingOlder ? (
              <span className="spinner" role="status" aria-label={t('view.loadingOlder')} />
            ) : (
              <button className="older-messages" onClick={onLoadOlder}>
                {t('view.loadOlder')}
              </button>
            )}
          </div>
        )}
        {shown.map((g) => renderItems(g.items))}
      </Pictures.Provider>
      {lightbox && <Lightbox url={lightbox.url} name={lightbox.name} onClose={closeLightbox} />}
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
      title={state === 'failed' ? t('view.copyFailed') : state === 'done' ? t('common.copied') : label}
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

/**
 * A fenced code block: a small header with the language and a copy button, then the code.
 * When the code is a whole SVG document it is shown as the picture it draws, with the source one
 * click away, as Claude and Open WebUI do. In an <img>, so that nothing in it runs or is fetched.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find((c) => isValidElement(c));
  const className = isValidElement<{ className?: string }>(code) ? (code.props.className ?? '') : '';
  const language = /language-([\w+#.-]+)/.exec(className)?.[1] ?? '';
  const text = plainText(children).replace(/\n$/, '');
  const picture = useMemo(() => svgPicture(text), [text]);
  // A source the browser cannot draw (not well formed) stays code.
  const [failed, setFailed] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  // A mermaid block draws itself, once the library is in; until then and forever if it cannot
  // parse, the code stands in.
  const [diagram, setDiagram] = useState<string | null>(null);
  useEffect(() => {
    if (language !== 'mermaid') return;
    let cancelled = false;
    void renderMermaidDiagram(text)
      .then((svg) => !cancelled && setDiagram(svg))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [language, text]);
  // The look can flip while the answer stays on screen: redraw with it.
  useEffect(() => {
    if (language !== 'mermaid' || diagram === null) return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      void renderMermaidDiagram(text)
        .then((svg) => setDiagram(svg))
        .catch(() => undefined);
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
    return () => observer.disconnect();
  }, [language, text, diagram]);
  const pictures = useContext(Pictures);
  const drawn = (picture !== null && picture !== failed) || diagram !== null;
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language}</span>
        <span className="code-actions">
          {drawn && (
            <span className="code-views" role="group" aria-label={t('view.display')}>
              <button type="button" aria-pressed={!showCode} onClick={() => setShowCode(false)}>
                {t('files.preview')}
              </button>
              <button type="button" aria-pressed={showCode} onClick={() => setShowCode(true)}>
                {t('view.code')}
              </button>
            </span>
          )}
          <CopyButton text={text} label={t('view.copyCode')} />
        </span>
      </div>
      {drawn && !showCode ? (
        diagram !== null ? (
          <div className="code-diagram" role="img" aria-label={t('view.mermaid')} dangerouslySetInnerHTML={{ __html: diagram }} />
        ) : (
          <button type="button" className="code-picture" aria-label={t('view.enlarge')} onClick={() => picture && pictures?.show(picture, 'drawing.svg')}>
            <img src={picture ?? undefined} alt={t('view.svg')} onError={() => picture && setFailed(picture)} />
          </button>
        )
      ) : (
        <pre>{children}</pre>
      )}
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
 * How something inside an answer puts a picture up at full size. `openFile` fetches one on the
 * agent's host, and rejects when the daemon has no such picture; `show` takes one already at hand.
 * Reaches the links and code blocks through context: the components Markdown is given stay the
 * same objects, so a message is not parsed again for it.
 */
const Pictures = createContext<{
  openFile: (path: string) => Promise<void>;
  show: (url: string, name?: string) => void;
  /** Opens any other file in the file viewer; rejects when the thread cannot show it. */
  openText?: (path: string) => Promise<void>;
} | null>(null);

/**
 * A link in an answer. One to the web opens in a tab of its own, so the hub stays where it is.
 * One to a file is on the agent's host, where the browser cannot follow: a picture opens at full
 * size, anything else in the file viewer. A file the thread cannot show gives its path to the
 * clipboard instead, for a terminal or an editor.
 */
function MarkdownLink({ href, title, children }: { href?: string; title?: string; children?: ReactNode }) {
  const pictures = useContext(Pictures);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 3200);
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
  const picture = pictures !== null && IMAGE_FILE.test(path);
  const copy = async () => setNote((await copyText(path)) ? t('view.pathCopied') : t('view.copyFailedSelect'));
  const failed = async () => setNote((await copyText(path)) ? t('view.noPreviewCopied') : t('view.noPreview'));
  const act = () => {
    // The path is copied in the click itself where it can be: a browser may refuse once a fetch has come between.
    if (picture) pictures.openFile(path).catch(failed);
    else if (pictures?.openText) pictures.openText(path).catch(failed);
    else void copy();
  };
  return (
    <a
      className="file-link"
      role="button"
      tabIndex={0}
      title={title ?? (picture ? t('view.viewImage', path) : pictures?.openText ? t('view.openFile', path) : t('view.copyPath', path))}
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
  onOpen: (url: string, name?: string) => void;
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

/** Text an agent wrote, read as Markdown, for places outside a thread's own timeline. */
export function Prose({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`markdown ${className}`.trim()}>
      <Markdown remarkPlugins={MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS} urlTransform={keepUrl}>
        {text}
      </Markdown>
    </div>
  );
}

/**
 * What another agent of the team sent into this thread. It is not the user's words, so it is not
 * a bubble: a card folded to who sent it and how it opens, and read as Markdown once opened.
 */
const DeliveredNote = memo(function DeliveredNote({ turnId, note, text }: { turnId: string; note: CoordinationNote; text: string }) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => deliveredPreview(text), [text]);
  return (
    <div className={`row delivered${open ? ' open' : ''}`} data-turn={turnId}>
      <button type="button" className="delivered-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="delivered-title">
          <IconAgents size={15} />
          <span className="delivered-from">{note.from || t('team.member')}</span>
          <span className="muted">{note.kind === 'result' ? t('view.deliveredResult') : t('view.deliveredTask')}</span>
          {note.failed && <span className="delivered-failed">{t('team.failed')}</span>}
          <IconChevron size={14} open={open} />
        </span>
        {!open && preview && <span className="delivered-preview">{preview}</span>}
      </button>
      {open && <Prose className="delivered-body" text={text || t('team.noText')} />}
    </div>
  );
});

/** An image file the answer points at. Shown only if the daemon confirms it is one; otherwise nothing. */
function FileImage({ path, roots, load, onOpen }: { path: string; roots: string[]; load: (path: string) => Promise<Blob>; onOpen: (url: string, name?: string) => void }) {
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
      <button type="button" onClick={() => onOpen(url, path)} aria-label={t('view.enlargePath', path)}>
        <img src={url} alt={path} />
      </button>
      <figcaption title={path}>{relativePath(path, roots)}</figcaption>
    </figure>
  );
}

/** How deep a plan card goes before the rest fades away, and over what distance it fades. */
const PLAN_FADE_PX = 64;

/**
 * A plan in the thread: a small card holding the opening of the plan, fading out where it is cut,
 * and opening to the whole of it. While it is still being written it follows along, pinned to the
 * newest lines with the top fading instead.
 */
function ProposalCard({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (streaming) el.scrollTop = el.scrollHeight;
    setOverflow(el.scrollHeight - el.clientHeight > PLAN_FADE_PX / 2);
  }, [text, streaming]);
  return (
    <div className="row">
      <section className={`proposal${streaming ? ' streaming' : ''}${overflow ? ' overflow' : ''}`}>
        <div className="proposal-head">
          <span className="proposal-title">
            <IconList size={16} />
            {streaming ? t('plan.cardStreaming') : t('plan.cardTitle')}
          </span>
          <span className="proposal-tools">
            <PlanDownloadButton text={text} />
            <PlanCopyButton text={text} />
          </span>
        </div>
        <button type="button" className="proposal-body" aria-label={t('plan.openFull')} title={t('plan.openFull')} onClick={() => setOpen(true)}>
          <div className="proposal-scroll" ref={scrollRef}>
            <Prose text={text} />
          </div>
        </button>
      </section>
      {open && <PlanReader text={text} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** What a resolved question, plan decision or approval says, and which mark leads it. */
type Trace = { icon: 'check' | 'hand'; text: string } | null;

/** An answered question: what was asked, in short, and what was picked. */
function questionTrace(item: Extract<Item, { kind: 'input' }>): Trace {
  const answer = item.answer;
  if (!answer) return null;
  if ('cancelled' in answer) {
    const asked = item.questions[0]?.question ?? item.title ?? '';
    return { icon: 'hand', text: 'ended' in answer ? t('trace.ended', asked) : t('trace.skipped', asked) };
  }
  const parts = item.questions.map((q) => {
    const said = (answer.answers[q.id] ?? []).map((value) => q.options.find((o) => o.value === value)?.label ?? value).join(' · ');
    return `${q.header || q.question}：${said}`;
  });
  return { icon: 'check', text: t('trace.answered', parts) };
}

/** A plan approval the agent asked for: carried out, sent back with changes, or left behind. */
function planTrace(item: Extract<Item, { kind: 'input' }>): Trace {
  const answer = item.answer;
  if (!answer) return null;
  if ('cancelled' in answer) return { icon: 'hand', text: t('trace.planSkipped') };
  const q = item.questions[0];
  const said = q ? (answer.answers[q.id] ?? [])[0] ?? '' : '';
  if (q && said === q.options[0]?.value) return { icon: 'check', text: t('trace.planConfirmed') };
  return { icon: 'hand', text: t('trace.planReturned', said) };
}

/** A tool approval: allowed, or refused (which a cancellation amounts to here). */
function approvalTrace(item: Extract<Item, { kind: 'approval' }>, roots: string[]): Trace {
  const decision = item.decision;
  if (!decision) return null;
  const title = shortenPaths(item.title, roots);
  const allowed = 'optionId' in decision && item.options.find((o) => o.optionId === decision.optionId)?.kind.startsWith('allow');
  return { icon: allowed ? 'check' : 'hand', text: allowed ? t('trace.allowed', title) : t('trace.rejected', title) };
}

/** What an answered question or approval leaves behind: one quiet line, there but not in the way. */
function TraceLine({ mark }: { mark: Trace }) {
  if (!mark) return null;
  return (
    <div className="trace-line">
      {mark.icon === 'check' ? <IconCheck size={13} /> : <IconHand size={13} />}
      <span className="trace-line-text">{mark.text}</span>
    </div>
  );
}

/** The agent's own task list for the turn: what is done, what it is on, what is left. */
function PlanCard({ item }: { item: Extract<Item, { kind: 'plan' }> }) {
  const completed = item.entries.filter((e) => e.status === 'completed').length;
  return (
    <div className="row">
      <div className="plan">
        <div className="plan-head">
          <span>{t('view.plan')}</span>
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
                <span className="sr-only">{state === 'completed' ? t('view.entryDone') : state === 'active' ? t('view.entryActive') : t('view.entryPending')}</span>
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

  if (failed) return <div className="sent-image missing">{t('view.imageFailed')}</div>;
  if (!url) return <div className="sent-image loading" aria-label={t('view.imageLoading')} />;
  return (
    <button type="button" className="sent-image" onClick={() => onOpen(url)} aria-label={t('view.enlarge')}>
      <img src={url} alt={t('view.sentImage')} />
    </button>
  );
}

/** Only this small label ticks; the Markdown and tool output do not rerender every second. */
function WorkLabel({ item }: { item: Extract<Item, { kind: 'work' }> }) {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    if (item.done || !item.timed) return;
    const tick = () => setNow(new Date().toISOString());
    tick();
    const timer = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [item.done, item.timed, item.startedAt]);
  const time = item.timed ? durationLabel(item.startedAt, item.done ? item.endedAt : now) : '';
  const label = !item.done ? time ? `${t('view.working')} · ${time}` : t('view.working') : item.stopped ? stoppedLabel(time) : time ? t('view.workedFor', time) : t('view.processed');
  return <span className="work-label">{label}</span>;
}

function WorkGroup({ item, roots }: { item: Extract<Item, { kind: 'work' }>; roots: string[] }) {
  // Open while the turn runs so progress is visible; collapsed once it finishes.
  const [open, setOpen] = useState(!item.done);
  // Collapse once the turn finishes; the user can still expand it afterwards.
  useEffect(() => {
    if (item.done) setOpen(false);
  }, [item.done]);
  const count = item.steps.length;
  const sections = workSections(item.entries);
  return (
    <div className="row work">
      <button className="work-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <WorkLabel item={item} />
        {count > 0 && <span className="muted">· {t('view.steps', count)}</span>}
        <IconChevron size={14} open={open} />
      </button>
      {open && (
        <div className="work-body">
          {sections.map((section, i) =>
            section.kind === 'note' ? (
              <WorkNote key={section.key} text={section.text} />
            ) : section.kind === 'compaction' ? (
              <div className="context-compaction" key={section.key} role="status">
                <IconCompact size={18} />
                <span>{compactionLabel(section)}</span>
              </div>
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

/**
 * One stretch of the agent's thinking, kept small: while it is being thought, a line or two of
 * where it has got to; afterwards a single "Thought · Xs" line. Either opens up to the whole text.
 * A model can think for minutes before it acts, and that must not fill the screen.
 */
const ThinkingBlock = memo(function ThinkingBlock({ thought, live }: { thought: Thought; live: boolean }) {
  const paragraphs = useMemo(() => splitThinking(thought.text), [thought.text]);
  const [open, setOpen] = useState(false);
  if (paragraphs.length === 0) return null;

  const secs = durationLabel(thought.startedAt, thought.endedAt);

  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{live ? t('view.thinking') : t('view.thought', secs)}</span>
        <IconChevron size={13} open={open} />
      </button>
      {open ? (
        <div className="thinking-body">
          {paragraphs.map((p, i) => (
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

/** From this many finished calls on, a run is one line that counts them. Fewer are shown as they are. */
const RUN_FOLD_MIN = 2;

/**
 * A stretch of thinking and tool calls between two things the agent said. Several calls fold into
 * one line that counts them by kind ("explored 2 files, searched 1 time"), the way Codex does, and open to
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
  return (
    <>
      <div className="step-run">
        <button className="step-head run-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <ActivityIcon kind={summary.kind} />
          <span className="run-title">{summary.text}</span>
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
  // An edit is best shown as its diff; the raw arguments would repeat the same text as JSON.
  const showInput = step.input !== undefined && step.diffs.length === 0 && JSON.stringify(step.input) !== '{}';
  const result = step.status === 'completed' ? t('view.succeeded') : step.status === 'failed' ? t('team.failed') : null;
  const hasContent = showInput || step.diffs.length > 0 || Boolean(step.output);
  const hasDetail = hasContent || result !== null;
  return (
    <div className={`step ${step.status}`}>
      <button className="step-head" onClick={() => hasDetail && setOpen((v) => !v)} disabled={!hasDetail} aria-expanded={open}>
        <ActivityIcon kind={step.kind} />
        <span className="step-title">{nameAttachments(shortenPaths(stepTitle(step), roots)) || step.kind}</span>
        <span className="step-status">{stepStatusLabel(step)}</span>
      </button>
      {open && (
        <div className="step-detail">
          <div className="step-detail-content">
            {showInput && <pre>{JSON.stringify(step.input, null, 2)}</pre>}
            {step.diffs.length > 0 && <DiffView diffs={step.diffs} />}
            {step.output && <pre>{step.output}</pre>}
            {!hasContent && <div className="step-detail-empty">{t('view.noDetail')}</div>}
          </div>
          {result && <div className="step-result">{result}</div>}
        </div>
      )}
    </div>
  );
}

export function Stats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="diff-stats">
      <span className="diff-added">+{added}</span>
      <span className="diff-removed">−{removed}</span>
    </span>
  );
}

/** One or more edited regions of a file, as numbered lines with added and removed lines tinted. */
export function DiffView({ diffs }: { diffs: FileDiff[] }) {
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
            {hidden > 0 && <div className="diff-more">{t('view.moreLines', hidden)}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Files an answer can render: pages and drawings. */
const PREVIEW_FILE = /\.(html?|svg)$/i;

/** What a finished turn changed: a list of files, each opening to its diff. */
function ChangesCard({ item, roots, onPreview }: { item: Extract<Item, { kind: 'changes' }>; roots: string[]; onPreview?: (path: string) => void }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  return (
    <div className="row">
      <div className="changes">
        <div className="changes-head">
          <span>{t('markdown.changed', item.files.length)}</span>
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
              {onPreview && PREVIEW_FILE.test(file.path) && (
                <button className="changes-preview" title={t('view.previewPage')} onClick={() => onPreview(file.path)}>
                  {t('files.preview')}
                </button>
              )}
              {open && <DiffView diffs={file.diffs} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The button text for an approval option. The agent's own wording is kept where it carries the scope. */
export function optionLabel(option: ApprovalOption): string {
  switch (option.kind) {
    case 'allow_once':
      return t('view.allowOnce');
    case 'allow_always':
      return t('view.allowAlways');
    case 'reject_once':
      return t('view.reject');
    case 'reject_always':
      return t('view.rejectAlways');
    default:
      return option.name;
  }
}

/** The notes a message went out with: one quiet chip, opened to read them, like Codex. */
function SentNotes({ notes }: { notes: Note[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="notes-chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconQuote size={12} />
        {t('composer.notes', notes.length)}
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
  return time ? t('view.stoppedAfter', time) : t('team.stopped');
}
