import { useEffect, useMemo, useRef, useState } from 'react';
import { Api, type AgentMention, type Thread } from '../api';
import type { PreparedImage } from '../images';
import { restoreVideos, type PreparedVideo } from '../videos';
import { folderName } from '../paths';
import { buildTimeline, splitNotes, withNotes, type StoredEvent } from '../timeline';
import { Composer } from './Composer';
import { ThreadView } from './ThreadView';
import { IconClose } from './icons';

/** Events are collected briefly before the view updates, as in the main conversation. */
const FLUSH_MS = 40;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

interface Props {
  api: Api;
  /** Where the question goes: the same setup as the thread the quoted text came from. */
  agent: string;
  agentLabel: string;
  cwd: string;
  permissionMode: string;
  model: string | null;
  effort: string | null;
  /** The passage the questions are about; sent along with the first message. */
  quoteText: string;
  /** The thread the passage was selected in, so the new agent knows where it came from. */
  sourceTitle: string | null;
  /**
   * Set while that thread can be forked: the side chat is then an ephemeral fork of it, the way
   * Codex's side conversation works — the questions land with the whole conversation as context,
   * while the panel itself starts empty. Null (agent cannot fork, no session yet, or a turn is
   * running) falls back to a fresh thread carrying the quoted passage alone.
   */
  forkSourceId: string | null;
  /** Why pictures cannot be attached, or null when they can. */
  attachBlocked: string | null;
  onClose: () => void;
  onError: (e: unknown) => void;
  /** The side chat became a thread of its own: keep the sidebar list in step. */
  onThreadCreated: (thread: Thread) => void;
}

/**
 * Asking about a selected passage without disturbing the conversation it came from: a panel over
 * the thread with its own composer. Nothing exists on the server until the first question is sent,
 * which opens a new thread carrying the quoted text; it then lives in the sidebar like any other.
 */
export function SideChat({
  api,
  agent,
  agentLabel,
  cwd,
  permissionMode,
  model,
  effort,
  quoteText,
  sourceTitle,
  forkSourceId,
  attachBlocked,
  onClose,
  onError,
  onThreadCreated,
}: Props) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Where a fork's inherited history ends: the panel shows only what is asked here. Written before
  // the first question is sent, so no event of ours can land below it and be hidden as inherited.
  const baseSeq = useRef(0);
  const threadId = thread?.id ?? null;
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const running = timeline.running || thread?.status === 'running';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The new thread's log, live. It starts empty, so there is nothing older to page in.
  useEffect(() => {
    setEvents([]);
    if (!threadId) return;
    const ctrl = new AbortController();
    const id = threadId;
    let buffer: StoredEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      const batch = buffer;
      buffer = [];
      if (ctrl.signal.aborted || batch.length === 0) return;
      setEvents((prev) => {
        let last = prev.length ? prev[prev.length - 1].seq : 0;
        const fresh = batch.filter((ev) => (ev.seq > last ? ((last = ev.seq), true) : false));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
    };
    (async () => {
      let after = 0;
      try {
        const initial = await api.eventsTail(id);
        if (ctrl.signal.aborted) return;
        // A forked side chat inherits the whole conversation as the agent's context, but the panel
        // starts empty, as Codex's side conversation does: only what is asked here is shown.
        setEvents(thread?.forkedFrom ? initial.filter((ev) => ev.seq > baseSeq.current) : initial);
        after = initial.at(-1)?.seq ?? 0;
      } catch (e) {
        if (!ctrl.signal.aborted) onError(e);
        return;
      }
      while (!ctrl.signal.aborted) {
        try {
          await api.stream(`/api/threads/${id}/stream?after=${after}`, (ev) => {
            after = Math.max(after, ev.seq);
            buffer.push(ev);
            flushTimer ??= setTimeout(flush, FLUSH_MS);
            // Turns starting and finishing change the thread itself (queued messages, status).
            if (ev.type.startsWith('turn.')) {
              clearTimeout(refreshTimer);
              refreshTimer = setTimeout(() => {
                api
                  .thread(id)
                  .then((t) => setThread((cur) => (cur?.id === id ? t : cur)))
                  .catch(() => undefined);
              }, 300);
            }
          }, ctrl.signal);
        } catch {
          // The stream retries below; errors the whole app should see come through elsewhere.
        }
        await sleep(1500, ctrl.signal);
      }
    })();
    return () => {
      ctrl.abort();
      clearTimeout(flushTimer);
      clearTimeout(refreshTimer);
    };
    // The panel owns exactly one thread, so the id is all this effect needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Small panel, simple rule: stay at the bottom unless the reader has moved up.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const send = async (text: string, images: PreparedImage[], _mentions?: AgentMention[], videos: PreparedVideo[] = []) => {
    const outgoing = images.map(({ data, mimeType }) => ({ data, mimeType }));
    if (threadId) {
      await api.startTurn(threadId, text, outgoing, { queue: true, videos: await Promise.all(videos.map(async video => (await api.uploadVideo(threadId, video.file)).id)) });
      return;
    }
    const title = `追问：${quoteText.replace(/\s+/g, ' ').slice(0, 24)}`;
    let created: Thread;
    let firstText = text;
    if (forkSourceId) {
      // The fork carries the conversation the passage was selected from, so the first question
      // already lands with all its context. The message itself stays just the quote and the
      // question: the history around it is the attribution. The boundary between inherited
      // history and this panel's turns is read before the question is sent, or the question
      // could be counted as inherited.
      const forked = await api.forkThread(forkSourceId);
      created = await api.updateThread(forked.id, { title });
      baseSeq.current = (await api.eventsTail(created.id)).at(-1)?.seq ?? 0;
    } else {
      // A fresh agent seeing a bare snippet has nothing to go on but the words, so the message
      // says which thread the notes were lifted out of.
      created = await api.createThread({ agent, cwd, permissionMode, model, effort, title });
      const { notes, body } = splitNotes(text);
      if (sourceTitle && notes.length) firstText = withNotes(notes, `（注释引自线程「${sourceTitle}」）\n\n${body}`);
    }
    setThread(created);
    onThreadCreated(created);
    await api.startTurn(created.id, firstText, outgoing, { queue: true, videos: await Promise.all(videos.map(async video => (await api.uploadVideo(created.id, video.file)).id)) });
  };

  const loadImage = (attachmentId: string) =>
    threadId ? api.attachment(threadId, attachmentId) : Promise.reject(new Error('no thread'));
  const loadFile = (path: string) => (threadId ? api.threadFile(threadId, path) : Promise.reject(new Error('no thread')));

  const roots = useMemo(() => (thread ? [thread.cwd, thread.cwdReal] : [cwd]), [thread, cwd]);

  return (
    <div className="dialog-scrim side-chat-scrim" onClick={onClose}>
      <aside className="side-chat" role="dialog" aria-modal="true" aria-label="侧边提问" onClick={(e) => e.stopPropagation()}>
        <header className="side-chat-head">
          <div className="side-chat-heading">
            <div className="side-chat-title">侧边提问</div>
            <div className="side-chat-sub">
              {agentLabel} · {folderName(cwd)}
            </div>
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <div className="side-chat-body" ref={scrollerRef} onScroll={onScroll}>
          {thread ? (
            <ThreadView
              items={timeline.items}
              running={running && !timeline.awaitingApproval}
              roots={roots}
              loadImage={loadImage}
              loadFile={loadFile}
              onDecide={(approvalId, optionId) =>
                api.decide(approvalId, optionId === null ? { cancel: true } : { optionId }).catch(onError)
              }
            />
          ) : (
            <div className="side-chat-intro">
              <div className="side-chat-passage" title={quoteText}>
                {quoteText}
              </div>
            </div>
          )}
        </div>

        <Composer
          running={running}
          placeholder={running ? '追加一条，这一轮结束后发送' : '问点什么…'}
          onSend={send}
          onStop={() => threadId && api.cancel(threadId).catch(onError)}
          header={null}
          left={null}
          right={null}
          commands={[]}
          actions={[]}
          hiddenCommands={[]}
          onAction={() => undefined}
          attachBlocked={attachBlocked}
          onError={(message) => onError(new Error(message))}
          queued={thread?.queued ?? []}
          onRemoveQueued={(id) => threadId && api.removeQueued(threadId, id).catch(onError)}
          onEditQueued={async (id) => {
            if (!threadId) throw new Error('没有打开的线程');
            const taken = await api.removeQueued(threadId, id);
            return { ...taken, videos: await restoreVideos(api, threadId, taken.videos) };
          }}
          onSendQueuedNow={(id) => threadId && api.sendQueuedNow(threadId, id).catch(onError)}
          restore={null}
          note={{ id: 'side-chat-passage', quote: quoteText, comment: '', nonce: 1 }}
        />
      </aside>
    </div>
  );
}
