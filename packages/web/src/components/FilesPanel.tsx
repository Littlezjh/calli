import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Api, FolderEntry, FolderListing, TextFile } from '../api';
import { copyText } from '../clipboard';
import { crumbsOf, escapeHtml, foldersTo, languageOf, parentDir, resolveRelative, sizeLabel, splitHighlighted } from '../files';
import { pictureUrl } from '../images';
import { IMAGE_FILE } from '../paths';
import { IconChevron, IconClose, IconCopy, IconFile, IconFolder, IconSearch, IconSidebar, IconWrap } from './icons';

/** What the panel is asked to show: a file (at a line), or with no path, the thread's folder. */
export interface FilesTarget {
  path: string | null;
  line?: number;
  /** Already fetched by whoever opened the panel, so it is not asked for twice. */
  file?: TextFile;
  /** A new number each time something is opened, so opening the same file again scrolls to it again. */
  seq: number;
}

interface Props {
  api: Api;
  threadId: string;
  target: FilesTarget;
  /** A phone: one full-screen page that switches between the file and its folder. */
  phone: boolean;
  onClose: () => void;
}

type Shown =
  | { state: 'loading'; path: string }
  | { state: 'text'; file: TextFile }
  | { state: 'picture'; file: TextFile; url: string }
  | { state: 'error'; path: string; message: string };

const WIDTH_KEY = 'rah.files.width';
const WRAP_KEY = 'rah.files.wrap';
const TREE_KEY = 'rah.files.tree';
/** The panel never squeezes the conversation narrower than this. */
const MIN_MAIN = 380;
const MIN_WIDTH = 360;

function savedWidth(): number {
  const saved = Number(localStorage.getItem(WIDTH_KEY));
  return saved > 0 ? saved : Math.round(window.innerWidth * 0.45);
}
const clampWidth = (w: number) => Math.max(MIN_WIDTH, Math.min(w, window.innerWidth - MIN_MAIN));

// The highlighter is a few dozen KB; it is fetched the first time a file is shown, then kept.
let highlighter: Promise<typeof import('../highlight')> | null = null;
const loadHighlighter = () => (highlighter ??= import('../highlight'));

/**
 * Looking through the thread's folder, read only, like Codex's file panel: a file with line numbers
 * and highlighting, and the folder tree beside it. On a computer it sits to the right of the
 * conversation; on a phone it is a page of its own, with the tree one step back from the file.
 */
export function FilesPanel({ api, threadId, target, phone, onClose }: Props) {
  const [root, setRoot] = useState<string | null>(target.file?.root ?? null);
  const [dirs, setDirs] = useState<Map<string, FolderListing | 'loading' | 'error'>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Shown | null>(null);
  const [line, setLine] = useState<number | undefined>(target.line);
  const [wrap, setWrap] = useState(() => (localStorage.getItem(WRAP_KEY) ?? (phone ? '1' : '0')) === '1');
  const [treeOpen, setTreeOpen] = useState(() => localStorage.getItem(TREE_KEY) !== '0');
  const [source, setSource] = useState(false);
  const [width, setWidth] = useState(() => clampWidth(savedWidth()));
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; paths: string[]; truncated: boolean } | null>(null);
  // On a phone: the file, or the folder being looked through.
  const [phoneFolder, setPhoneFolder] = useState<string | null>(target.path ? null : '');
  const [copied, setCopied] = useState(false);
  const picture = useRef<string | null>(null);

  // On a phone the page is a step in the browser's history: the back gesture closes it, not the hub.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const pushed = useRef(false);
  useEffect(() => {
    if (!phone) return;
    window.history.pushState({ ...window.history.state, rahFiles: true }, '');
    pushed.current = true;
    const onPop = () => {
      if (!pushed.current) return;
      pushed.current = false;
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (pushed.current) {
        pushed.current = false;
        window.history.back();
      }
    };
  }, [phone]);
  const close = () => (pushed.current ? window.history.back() : onClose());

  const loadDir = useCallback(
    async (path: string | null) => {
      const key = path ?? '';
      setDirs((m) => (m.get(key) && m.get(key) !== 'error' ? m : new Map(m).set(key, 'loading')));
      try {
        const listing = await api.threadTree(threadId, path ?? undefined);
        if (!path) setRoot(listing.root);
        setDirs((m) => {
          const next = new Map(m).set(listing.path, listing);
          if (!path) next.delete('');
          return next;
        });
        return listing;
      } catch {
        setDirs((m) => new Map(m).set(key, 'error'));
        return null;
      }
    },
    [api, threadId],
  );

  // The thread's folder first: the tree starts there, and it is where paths are counted from.
  useEffect(() => {
    void loadDir(null);
  }, [loadDir]);

  const releasePicture = () => {
    if (picture.current?.startsWith('blob:')) URL.revokeObjectURL(picture.current);
    picture.current = null;
  };
  useEffect(() => releasePicture, []);

  const openFile = useCallback(
    async (path: string, at?: number, preloaded?: TextFile) => {
      setLine(at);
      setSource(false);
      setPhoneFolder(null);
      setShown({ state: 'loading', path });
      try {
        const file = preloaded ?? (await api.threadText(threadId, path));
        setRoot((r) => r ?? file.root);
        releasePicture();
        if (IMAGE_FILE.test(file.path)) {
          try {
            const url = await pictureUrl(await api.threadFile(threadId, file.path));
            picture.current = url;
            setShown({ state: 'picture', file, url });
            return;
          } catch {
            // Named like a picture but not one: shown as whatever it is.
          }
        }
        setShown({ state: 'text', file });
      } catch {
        setShown({ state: 'error', path, message: '找不到这个文件，或者它不在这个线程的目录里' });
      }
    },
    [api, threadId],
  );

  // Each time something is opened from outside: a file, or the folder alone.
  useEffect(() => {
    if (target.path) void openFile(target.path, target.line, target.file);
    else setPhoneFolder('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.seq]);

  // The tree opens down to the file on show.
  const filePath = shown && shown.state !== 'loading' && shown.state !== 'error' ? shown.file.path : null;
  useEffect(() => {
    if (!root || !filePath) return;
    const folders = foldersTo(root, filePath);
    if (folders.length === 0 || folders[0] !== root) return;
    setExpanded((s) => new Set([...s, ...folders]));
    for (const folder of folders) if (!dirs.has(folder)) void loadDir(folder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, filePath]);

  // The filter looks through the whole folder, not just what the tree has opened.
  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound(null);
    let alive = true;
    const timer = setTimeout(() => {
      api
        .findFiles(threadId, q)
        .then((r) => alive && setFound({ query: q, paths: r.paths, truncated: r.truncated }))
        .catch(() => alive && setFound({ query: q, paths: [], truncated: false }));
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, threadId, query]);

  const toggleFolder = (path: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!dirs.has(path) || dirs.get(path) === 'error') void loadDir(path);
      }
      return next;
    });
  };

  const showFolder = (path: string) => {
    if (phone) {
      setPhoneFolder(path);
      if (!dirs.has(path)) void loadDir(path);
      return;
    }
    setTreeOpen(true);
    if (root) for (const folder of [...foldersTo(root, path), path]) if (!dirs.has(folder)) void loadDir(folder);
    setExpanded((s) => new Set([...s, ...(root ? foldersTo(root, path) : []), path]));
  };

  const copyPath = async () => {
    if (!filePath) return;
    setCopied(await copyText(filePath));
    setTimeout(() => setCopied(false), 1400);
  };

  const remember = (key: string, value: boolean) => localStorage.setItem(key, value ? '1' : '0');

  // Dragging the left edge sets the width; it is kept on this device.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => setWidth(clampWidth(startW + startX - ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      localStorage.setItem(WIDTH_KEY, String(clampWidth(startW + startX - ev.clientX)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const crumbs = root ? crumbsOf(root, phone && phoneFolder !== null ? phoneFolder || root : (filePath ?? root)) : [];
  const markdown = shown?.state === 'text' && shown.file.text !== null && languageOf(shown.file.path) === 'markdown';
  const svg = shown?.state === 'picture' && /\.svg$/i.test(shown.file.path);

  const filter = (
    <label className="files-filter">
      <IconSearch size={14} />
      <input value={query} placeholder="筛选文件…" aria-label="筛选文件" spellCheck={false} autoCapitalize="off" onChange={(e) => setQuery(e.target.value)} />
      {query && (
        <button type="button" className="files-filter-clear" aria-label="清除筛选" onClick={() => setQuery('')}>
          <IconClose size={12} />
        </button>
      )}
    </label>
  );

  const results = found && root && (
    <div className="files-results" role="list">
      {found.paths.map((rel) => {
        const path = `${root}/${rel}`;
        const slash = rel.lastIndexOf('/');
        return (
          <button
            key={rel}
            type="button"
            role="listitem"
            className={`files-row${path === filePath ? ' current' : ''}`}
            title={rel}
            onClick={() => {
              setQuery('');
              void openFile(path);
            }}
          >
            <IconFile size={14} />
            <span className="files-name">{rel.slice(slash + 1)}</span>
            {slash > 0 && <span className="files-hint">{rel.slice(0, slash)}</span>}
          </button>
        );
      })}
      {found.paths.length === 0 && <div className="files-note">没有匹配“{found.query}”的文件</div>}
      {found.truncated && <div className="files-note">只列出前 {found.paths.length} 个，可以再多打几个字</div>}
    </div>
  );

  const treeRows = (path: string, depth: number): ReactNode => {
    const listing = dirs.get(path);
    if (!listing || listing === 'loading') return <div className="files-note" style={{ paddingLeft: 12 + depth * 14 }}>加载中…</div>;
    if (listing === 'error') return <div className="files-note" style={{ paddingLeft: 12 + depth * 14 }}>打不开这个文件夹</div>;
    return (
      <>
        {listing.entries.map((entry) => {
          const full = `${listing.path}/${entry.name}`;
          // On a phone a folder is a page of its own: tapping one goes into it.
          const open = !phone && expanded.has(full);
          return (
            <div key={entry.name} role="treeitem" aria-expanded={entry.type === 'dir' ? open : undefined}>
              <EntryRow
                entry={entry}
                depth={depth}
                open={open}
                current={full === filePath}
                onClick={() => (entry.type === 'dir' ? (phone ? showFolder(full) : toggleFolder(full)) : void openFile(full))}
              />
              {entry.type === 'dir' && open && treeRows(full, depth + 1)}
            </div>
          );
        })}
        {listing.entries.length === 0 && <div className="files-note" style={{ paddingLeft: 12 + depth * 14 }}>空文件夹</div>}
        {listing.truncated && <div className="files-note" style={{ paddingLeft: 12 + depth * 14 }}>文件太多，只列出了一部分</div>}
      </>
    );
  };

  const viewer = (
    <div className="files-viewer">
      {!shown && (
        <div className="files-empty">
          <IconFile size={30} />
          <span>{phone ? '' : '在右侧选一个文件查看'}</span>
        </div>
      )}
      {shown?.state === 'loading' && <div className="files-empty">加载中…</div>}
      {shown?.state === 'error' && <div className="files-empty">{shown.message}</div>}
      {shown?.state === 'picture' && (svg && source ? <SvgSource file={shown.file} wrap={wrap} /> : <div className="files-picture"><img src={shown.url} alt={shown.file.path} /></div>)}
      {shown?.state === 'text' && shown.file.text === null && (
        <div className="files-empty">
          <IconFile size={30} />
          <span>二进制文件（{sizeLabel(shown.file.size)}），不能在这里查看</span>
        </div>
      )}
      {shown?.state === 'text' && shown.file.text !== null && markdown && !source && (
        <div className="files-markdown markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => {
                if (href && /^https?:\/\//i.test(href))
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  );
                const to = href ? resolveRelative(parentDir(shown.file.path), href) : null;
                if (!to) return <>{children}</>;
                return (
                  <a className="file-link" role="button" tabIndex={0} onClick={() => void openFile(to)}>
                    {children}
                  </a>
                );
              },
              img: ({ src, alt }) => (src && /^https?:/i.test(src) ? <img src={src} alt={alt ?? ''} loading="lazy" /> : null),
            }}
          >
            {shown.file.text}
          </Markdown>
        </div>
      )}
      {shown?.state === 'text' && shown.file.text !== null && (!markdown || source) && <Code key={`${shown.file.path}:${target.seq}`} file={shown.file} line={line} wrap={wrap} />}
      {shown?.state === 'text' && shown.file.truncated && <div className="files-truncated">文件太长，只显示了前 {sizeLabel((shown.file.text ?? '').length)}</div>}
    </div>
  );

  const fileActions = filePath && (
    <>
      {(markdown || svg) && (
        <button type="button" className={`icon-btn files-toggle${source ? ' on' : ''}`} aria-pressed={source} title={source ? '显示渲染结果' : '显示源码'} onClick={() => setSource((v) => !v)}>
          <span className="files-toggle-text">{source ? '预览' : '源码'}</span>
        </button>
      )}
      {(shown?.state === 'text' || source) && (
        <button
          type="button"
          className={`icon-btn${wrap ? ' on' : ''}`}
          aria-pressed={wrap}
          aria-label="自动换行"
          title="自动换行"
          onClick={() => {
            setWrap(!wrap);
            remember(WRAP_KEY, !wrap);
          }}
        >
          <IconWrap size={16} />
        </button>
      )}
      <button type="button" className="icon-btn" aria-label="复制路径" title={copied ? '已复制' : '复制路径'} onClick={() => void copyPath()}>
        <IconCopy size={16} />
      </button>
    </>
  );

  if (phone) {
    const inFolder = phoneFolder !== null;
    const folder = inFolder ? phoneFolder || root : null;
    const name = inFolder ? crumbs[crumbs.length - 1]?.name ?? '文件' : (filePath ?? (shown && 'path' in shown ? shown.path : '')).split('/').pop();
    return (
      <div className="files-panel phone" role="dialog" aria-label="文件">
        <div className="files-head">
          <button
            type="button"
            className="icon-btn"
            aria-label={inFolder && shown ? '回到文件' : '关闭'}
            onClick={() => (inFolder && shown ? setPhoneFolder(null) : close())}
          >
            <span className="files-back">
              <IconChevron size={18} />
            </span>
          </button>
          <div className="files-title">
            <div className="files-title-name">{name}</div>
            {crumbs.length > 1 && (
              <div className="files-title-sub">
                {crumbs.slice(0, -1).map((c, i) => (
                  <button key={c.path} type="button" onClick={() => showFolder(c.path)}>
                    {i > 0 && <span className="files-sep">/</span>}
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {!inFolder && fileActions}
          {!inFolder && (
            <button type="button" className="icon-btn" aria-label="浏览文件夹" title="浏览文件夹" onClick={() => showFolder(filePath ? parentDir(filePath) : (root ?? ''))}>
              <IconFolder size={17} />
            </button>
          )}
        </div>
        {inFolder ? (
          <div className="files-list">
            {filter}
            {results ?? (folder ? <div role="tree">{treeRows(folder, 0)}</div> : <div className="files-note">加载中…</div>)}
          </div>
        ) : (
          viewer
        )}
      </div>
    );
  }

  return (
    <aside className="files-panel" style={{ width }} aria-label="文件">
      <div className="files-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="调整宽度" />
      <div className="files-head">
        <nav className="files-crumbs" aria-label="路径">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={c.path} className="files-crumb">
                {i > 0 && <IconChevron size={12} />}
                {last && filePath ? (
                  <span className="files-crumb-current" title={c.path}>
                    {c.name}
                  </span>
                ) : (
                  <button type="button" title={c.path} onClick={() => showFolder(c.path)}>
                    {c.name}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
        <div className="files-actions">
          {fileActions}
          <button
            type="button"
            className={`icon-btn${treeOpen ? ' on' : ''}`}
            aria-pressed={treeOpen}
            aria-label="文件树"
            title="文件树"
            onClick={() => {
              setTreeOpen(!treeOpen);
              remember(TREE_KEY, !treeOpen);
            }}
          >
            <IconSidebar size={16} />
          </button>
          <button type="button" className="icon-btn" aria-label="关闭文件" title="关闭" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
      </div>
      <div className="files-body">
        {viewer}
        {treeOpen && (
          <div className="files-tree">
            {filter}
            <div className="files-tree-scroll">{results ?? (root ? <div role="tree">{treeRows(root, 0)}</div> : <div className="files-note">加载中…</div>)}</div>
          </div>
        )}
      </div>
    </aside>
  );
}

function EntryRow({ entry, depth, open, current, onClick }: { entry: FolderEntry; depth: number; open: boolean; current: boolean; onClick: () => void }) {
  const dir = entry.type === 'dir';
  return (
    <button
      type="button"
      className={`files-row${current ? ' current' : ''}${entry.ignored ? ' ignored' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={dir ? undefined : entry.size !== undefined ? `${entry.name} · ${sizeLabel(entry.size)}` : entry.name}
      onClick={onClick}
    >
      <span className="files-caret">{dir && <IconChevron size={12} open={open} />}</span>
      {dir ? <IconFolder size={14} /> : <IconFile size={14} />}
      <span className="files-name">{entry.name}</span>
    </button>
  );
}

/** Rows of code with their numbers; the line a link pointed at is marked and scrolled to. */
function Code({ file, line, wrap }: { file: TextFile; line?: number; wrap: boolean }) {
  const text = file.text ?? '';
  const language = languageOf(file.path);
  const [html, setHtml] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!language) return;
    let alive = true;
    void loadHighlighter().then((m) => alive && setHtml(m.highlight(text, language)));
    return () => {
      alive = false;
    };
  }, [text, language]);

  const lines = useMemo(() => {
    const out = html !== null ? splitHighlighted(html) : text.split('\n').map(escapeHtml);
    // A file that ends with a newline has no empty last line to show.
    if (out.length > 1 && out[out.length - 1] === '') out.pop();
    return out;
  }, [html, text]);

  useLayoutEffect(() => {
    if (!line) return;
    const row = ref.current?.querySelector(`[data-line="${line}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [line, lines.length]);

  // The numbers' column is as wide as the largest number.
  const digits = String(lines.length).length;
  return (
    <div ref={ref} className={`files-code${wrap ? ' wrap' : ''}`} style={{ ['--digits' as string]: `${digits}ch` }}>
      {chunks(lines).map((chunk, c) => (
        <div key={c} className="files-chunk">
          {chunk.map((code, i) => {
            const n = c * CHUNK + i + 1;
            return (
              <div key={n} data-line={n} className={`files-line${n === line ? ' hit' : ''}`}>
                <span className="files-num">{n}</span>
                <span className="files-src" dangerouslySetInnerHTML={{ __html: code || ' ' }} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Lines are drawn in blocks the browser can skip while they are off screen: a long file stays quick. */
const CHUNK = 200;
function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/** An SVG's own text, for when the drawing is not what is wanted. */
function SvgSource({ file, wrap }: { file: TextFile; wrap: boolean }) {
  return file.text === null ? <div className="files-empty">无法显示源码</div> : <Code file={file} wrap={wrap} />;
}
