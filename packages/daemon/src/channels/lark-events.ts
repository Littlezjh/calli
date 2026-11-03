import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { larkProcess, messageCandidates, source, summary, withSender, type LarkChannel, type LarkChannelSettings, type LarkRealtimeStatus, type LarkSignal } from './lark.js';

type ObjectValue = Record<string, any>;
const object = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};

/** Only source IDs cross the boundary; callback tokens and app credentials never do. */
export function eventSignals(input: unknown, key: string, settings: LarkChannelSettings): LarkSignal[] {
  const row = object(input), header = object(row.header), event = object(row.event);
  if (key === 'im.message.receive_v1') {
    const message = Object.keys(event).length ? { ...object(event.message), sender: event.sender } : row;
    return messageCandidates([message], settings);
  }
  if (key === 'task.task.update_user_access_v2') {
    const task = Object.keys(event).length ? event : row;
    const guid = task.task_guid ?? task.guid;
    if (typeof guid !== 'string' || !guid || guid.length > 200 || /\s/.test(guid)) return [];
    // A task can change many times; its delivery ID identifies the signal, its guid the subscription.
    const s = source('lark-task', { create_time: header.create_time ?? row.timestamp }, header.event_id ?? row.event_id);
    return s ? [withSender({ summary: summary(`任务 ${guid}：${(Array.isArray(task.event_types) ? task.event_types : ['task_update']).join('、')}`),
      source: s, thread: { kind: 'lark-task', ref: guid } }, task, settings)] : [];
  }
  // Meeting/minute events do not necessarily contain a calendar event ID. Do not guess one.
  if (['vc.meeting.participant_meeting_ended_v1', 'minutes.minute.generated_v1', 'vc.note.generated_v1'].includes(key)) {
    const s = source('lark-calendar', { create_time: header.create_time ?? row.timestamp }, header.event_id ?? row.event_id);
    const calendarId = event.calendar_event_id;
    return s ? [{ summary: summary(`${key}：${String(event.meeting_id ?? event.minute_token ?? event.note_id ?? s.ref)}`), source: s,
      ...(typeof calendarId === 'string' && calendarId ? { thread: { kind: 'lark-calendar' as const, ref: calendarId } } : {}) }] : [];
  }
  return [];
}

interface Consumer {
  key: string; status: LarkRealtimeStatus; child?: ChildProcess;
  cancelRetry?: () => void; attempts: number; stopped: boolean; closed?: Promise<void>;
}
export interface LarkEventsOptions {
  executable?: string; env?: NodeJS.ProcessEnv;
  /** Tests can advance retry deadlines without waiting ten real minutes. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** One CLI consumer per event key shares the CLI's local bus. No live connection during preflight. */
export class LarkEvents {
  private consumers: Consumer[] = [];
  private unsubscribe?: () => void;
  private signature = '';
  private processing: Promise<unknown> = Promise.resolve();
  private readonly retiring = new Set<Promise<void>>();
  constructor(private readonly channel: LarkChannel, private readonly options: LarkEventsOptions = {}) {}
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.channel.onSettingsChanged(() => this.configure());
    this.configure();
  }
  private configure(): void {
    const settings = this.channel.settings();
    const keys = settings.enabled ? settings.events ?? ['im.message.receive_v1'] : [];
    const signature = JSON.stringify(keys);
    if (signature === this.signature) return;
    this.signature = signature;
    for (const consumer of this.consumers) this.stop(consumer);
    this.consumers = keys.map(key => ({ key, status: 'connecting', attempts: 0, stopped: false }));
    this.publish();
    for (const consumer of this.consumers) void this.connect(consumer);
  }
  private publish(): void {
    const priority: LarkRealtimeStatus[] = ['busy-elsewhere', 'console-off', 'unavailable', 'error', 'connecting', 'live'];
    this.channel.setRealtime(priority.find(s => this.consumers.some(c => c.status === s)) ?? 'off');
  }
  private set(consumer: Consumer, status: LarkRealtimeStatus): void {
    if (consumer.stopped) return;
    consumer.status = status;
    this.publish();
  }
  private retry(consumer: Consumer): void {
    if (consumer.stopped || consumer.cancelRetry) return;
    const delay = consumer.status === 'busy-elsewhere' || consumer.status === 'console-off' ? 600_000
      : consumer.status === 'unavailable' ? 300_000 : Math.min(300_000, 5000 * 2 ** Math.min(consumer.attempts++, 6));
    const schedule = this.options.schedule ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return () => clearTimeout(timer); });
    consumer.cancelRetry = schedule(() => { consumer.cancelRetry = undefined; void this.connect(consumer); }, delay);
  }
  private async connect(consumer: Consumer): Promise<void> {
    if (consumer.stopped) return;
    this.set(consumer, 'connecting');
    if (!await this.channel.ready()) {
      this.set(consumer, 'unavailable'); this.retry(consumer); return;
    }
    if (!consumer.stopped) this.launch(consumer, true);
  }
  private launch(consumer: Consumer, preflight: boolean): void {
    const { executable, env } = larkProcess(this.options);
    const identity = consumer.key.startsWith('im.') ? 'bot' : 'user';
    const child = spawn(executable, ['event', 'consume', consumer.key, '--as', identity, ...(preflight ? ['--dry-run'] : [])],
      { env, stdio: ['pipe', 'pipe', 'pipe'], ...(preflight ? { timeout: 20_000 } : {}) });
    consumer.child = child;
    let output = '', diagnostics = '', malformed = false;
    let finish!: () => void;
    consumer.closed = new Promise(resolve => { finish = resolve; });
    const diagnose = (text: string) => {
      if (/another event bus is already connected/i.test(text)) { this.set(consumer, 'busy-elsewhere'); child.kill('SIGTERM'); }
      else if (/console_event_published[^\n]*(?:blocked|missing|not.ok)|event types not subscribed|subscribe.*event.*console/i.test(text)) this.set(consumer, 'console-off');
      else if (/not logged in|credentials.*(?:missing|unavailable)|login required/i.test(text)) this.set(consumer, 'unavailable');
      else if (!preflight && /\bready\b/i.test(text) && consumer.status === 'connecting') this.set(consumer, 'live');
    };
    child.stderr!.on('data', chunk => {
      diagnostics = (diagnostics + String(chunk)).slice(-16_000); diagnose(diagnostics);
    });
    if (preflight) child.stdout!.on('data', chunk => { output = (output + String(chunk)).slice(-128_000); diagnose(output); });
    else {
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      lines.on('line', line => {
        if (consumer.stopped) return;
        if (!line.trimStart().startsWith('{')) { diagnose(line); return; }
        let signals: LarkSignal[];
        try {
          const value = JSON.parse(line);
          signals = eventSignals(value, consumer.key, this.channel.settings());
          // External message text must not be interpreted as a consumer diagnostic.
          if (!signals.length && value.error) diagnose(JSON.stringify(value.error));
        } catch { malformed = true; this.set(consumer, 'error'); return; }
        if (!signals.length) return;
        this.set(consumer, 'live'); consumer.attempts = 0;
        this.processing = this.processing.catch(() => undefined).then(async () => {
          if (!consumer.stopped) await this.channel.receive(signals);
        }).catch(() => this.set(consumer, 'error'));
      });
    }
    child.on('error', error => this.set(consumer, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'error'));
    child.on('close', code => {
      consumer.child = undefined; finish();
      if (consumer.stopped) return;
      if (preflight && output.trimStart().startsWith('{')) {
        try {
          const decision = object(object(JSON.parse(output).data).decision);
          const conditions = Array.isArray(decision.preconditions) ? decision.preconditions : [];
          if (conditions.some(c => c.name === 'console_event_published' && c.status !== 'ok')) this.set(consumer, 'console-off');
          else if (conditions.some(c => c.name === 'credentials_available' && c.status !== 'ok')) this.set(consumer, 'unavailable');
          else if (code === 0 && decision.status === 'ready') { this.launch(consumer, false); return; }
          else this.set(consumer, 'error');
        } catch { this.set(consumer, 'error'); }
      } else if (!['busy-elsewhere', 'console-off', 'unavailable'].includes(consumer.status)) this.set(consumer, 'error');
      if (malformed && consumer.status === 'live') this.set(consumer, 'error');
      this.retry(consumer);
    });
  }
  private stop(consumer: Consumer): void {
    consumer.stopped = true; consumer.cancelRetry?.(); consumer.cancelRetry = undefined;
    if (consumer.child) {
      const child = consumer.child;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref();
      const closed = consumer.closed!.finally(() => { clearTimeout(timer); this.retiring.delete(closed); });
      this.retiring.add(closed);
    }
  }
  async dispose(): Promise<void> {
    this.unsubscribe?.(); this.unsubscribe = undefined; this.signature = '';
    for (const consumer of this.consumers) this.stop(consumer);
    this.consumers = []; this.publish();
    await Promise.all([...this.retiring]);
    await this.processing;
  }
}
