import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter } from './adapters/types.js';
import type { BorrowedTool } from './adapters/borrowed-tools.js';
import { sniffImageType } from './attachments.js';
import { turnAnswer } from './coordination.js';
import { HttpError } from './errors.js';
import type { StoredEvent } from './events.js';
import { turnOutcome } from './lifecycle.js';
import type { Store } from './store.js';
import type { ThreadManager } from './threads.js';
import type { ToolArtifact, ToolJob } from './tool-jobs.js';

const active = (job: ToolJob) => job.state === 'queued' || job.state === 'running';
const message = (err: unknown) => err instanceof Error ? err.message : String(err);

/** The shared execution layer behind the CLI. Provider details belong in adapters. */
export class BorrowingService {
  private readonly credentials = new Map<string, string>();
  private readonly byThread = new Map<string, string>();
  private readonly launches = new Set<Promise<void>>();
  private readonly introduced = new Set<string>();
  private readonly unsubscribe: () => void;
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly manager: ThreadManager,
    private readonly adapters: Map<string, AgentAdapter>,
    private readonly dataDir: string,
    readonly socket: string,
  ) {
    manager.borrowing = this;
    for (const job of store.toolJobs.list()) {
      if (job.threadId) this.byThread.set(job.threadId, job.id);
      if (!active(job)) continue;
      const events = job.threadId ? store.listEvents(job.threadId, 0, -1) : [];
      const end = events.reverse().find(e => e.turnId === job.turnId && turnOutcome(e));
      if (end) this.finish(job, end);
      else this.fail(job, 'interrupted', 'Limi restarted before this task finished. The task was not retried automatically.', 'interrupted');
    }
    this.unsubscribe = manager.subscribe(e => this.onEvent(e));
  }

  environment(threadId: string): Record<string, string> | undefined {
    // A provider task must not recursively borrow another provider.
    if (this.byThread.has(threadId)) return undefined;
    let key = this.credentials.get(threadId);
    if (!key) { key = randomUUID(); this.credentials.set(threadId, key); }
    return { LIMI_TOOLS_SOCKET: this.socket, LIMI_TOOLS_KEY: key,
      LIMI_BIN_DIR: resolve(dirname(fileURLToPath(import.meta.url)), '../bin') };
  }

  toolForThread(threadId: string): string | undefined {
    const id = this.byThread.get(threadId);
    const job = id ? this.store.toolJobs.get(id) : undefined;
    return job ? this.tool(job.tool).spec.name : undefined;
  }

  /** A single discovery hint per caller after startup; schemas and the Skill stay out of context. */
  instructions(threadId: string, text: string): string {
    if (this.byThread.has(threadId) || this.introduced.has(threadId)
      || ![...this.adapters.values()].some(a => a.borrowedTools?.length)) return text;
    return `${text}\n\n<limi-tools>可按需借用其他 Agent 的能力：limi tools search 关键词。用 limi tools skill 读取使用说明。</limi-tools>`;
  }

  caller(key: string): string {
    for (const [id, secret] of this.credentials) {
      if (key === secret && this.store.getThread(id)) return id;
    }
    throw new HttpError(401, 'invalid tool credentials');
  }

  private tool(id: unknown): { agent: string; adapter: AgentAdapter; spec: BorrowedTool } {
    if (typeof id !== 'string') throw new HttpError(400, 'tool is required');
    for (const [agent, adapter] of this.adapters) {
      const spec = adapter.borrowedTools?.find(t => `${agent}/${t.name}` === id);
      if (spec) return { agent, adapter, spec };
    }
    throw new HttpError(404, 'unknown tool');
  }

  private async describe(id: string, schema = true) {
    const { agent, adapter, spec } = this.tool(id);
    const installed = await adapter.available().catch(() => false);
    return {
      id, provider: agent, label: adapter.label, description: spec.description,
      mode: 'delegated', availability: installed && !spec.unavailableReason ? 'unverified' : 'unavailable',
      ...(!installed || spec.unavailableReason ? { reason: !installed ? 'Provider CLI is unavailable.' : spec.unavailableReason } : {}),
      ...(schema ? { inputSchema: spec.inputSchema, resultKind: spec.resultKind, permissionMode: spec.permissionMode } : {}),
    };
  }

  async command(owner: string, raw: unknown): Promise<unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'command must be an object');
    const input = raw as Record<string, unknown>;
    switch (input.op) {
      case 'tools.search': {
        if (input.query !== undefined && typeof input.query !== 'string') throw new HttpError(400, 'query must be a string');
        const query = String(input.query ?? '').toLowerCase().trim();
        const ids: string[] = [];
        for (const [id, adapter] of this.adapters) for (const spec of adapter.borrowedTools ?? []) {
          if (!query || `${id} ${adapter.label} ${spec.name} ${spec.description} ${spec.keywords.join(' ')}`.toLowerCase().includes(query)) ids.push(`${id}/${spec.name}`);
        }
        return Promise.all(ids.map(id => this.describe(id, false)));
      }
      case 'tools.describe': return this.describe(String(input.tool ?? ''));
      case 'tools.run': return this.run(owner, input);
      case 'jobs.get': return this.view(this.owned(owner, input.id));
      case 'jobs.cancel': {
        const job = this.owned(owner, input.id);
        if (active(job)) {
          this.fail(job, 'cancelled', 'Cancelled by caller.', 'cancelled');
          if (job.threadId) await this.manager.cancelTurn(job.threadId);
        }
        return this.view(this.store.toolJobs.get(job.id)!);
      }
      default: throw new HttpError(400, 'unknown tools command');
    }
  }

  private owned(owner: string, id: unknown): ToolJob {
    const job = typeof id === 'string' ? this.store.toolJobs.get(id) : undefined;
    if (!job || (owner !== 'operator' && job.owner !== owner)) throw new HttpError(404, 'no such tool job');
    return job;
  }

  private view(job: ToolJob) {
    const waiting = active(job) && job.threadId && this.store.getThread(job.threadId) ? this.manager.threadView(job.threadId).waiting : false;
    return {
      id: job.id, tool: job.tool, requestId: job.requestId, state: job.state,
      threadId: job.threadId, waiting, summary: job.summary, error: job.error,
      summaryTruncated: job.summaryTruncated ?? false, result: job.result ?? null,
      artifacts: job.artifacts.map(({ path: _path, ...artifact }) => artifact),
      createdAt: job.createdAt, updatedAt: job.updatedAt,
    };
  }

  private run(owner: string, input: Record<string, unknown>) {
    if (this.stopped) throw new HttpError(503, 'tool service is stopping');
    const { agent, spec } = this.tool(input.tool);
    if (typeof input.requestId !== 'string' || !/^[\w.-]{1,128}$/.test(input.requestId)) throw new HttpError(400, 'requestId must contain 1–128 letters, digits, dots, underscores or hyphens');
    const prepared = spec.prepare(input.input);
    const fingerprint = createHash('sha256').update(JSON.stringify([input.tool, prepared.input])).digest('hex');
    const previous = this.store.toolJobs.previous(owner, input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new HttpError(409, 'requestId already belongs to a different request');
      return this.view(previous);
    }
    if (spec.unavailableReason) throw new HttpError(503, spec.unavailableReason);
    if (this.store.toolJobs.activeCount() >= 4) throw new HttpError(429, 'four tool jobs are already running; wait for one to finish');
    const now = new Date().toISOString();
    const job: ToolJob = {
      id: randomUUID(), owner, requestId: input.requestId, fingerprint, tool: String(input.tool), agent,
      threadId: null, turnId: null, state: 'queued', input: prepared.input, summary: '', artifacts: [], error: null,
      createdAt: now, updatedAt: now,
    };
    this.store.toolJobs.save(job);
    const launch = this.launch(job.id, prepared.text).catch(err => {
      const current = this.store.toolJobs.get(job.id);
      if (current && active(current)) this.fail(current, 'start_failed', message(err));
    });
    this.launches.add(launch);
    void launch.finally(() => this.launches.delete(launch));
    return this.view(job);
  }

  private async launch(id: string, text: string): Promise<void> {
    let job = this.store.toolJobs.get(id)!;
    const thread = await this.manager.createThread({ agent: job.agent, cwd: '', scratch: true,
      permissionMode: this.tool(job.tool).spec.permissionMode, title: `${job.tool} · ${job.id.slice(0, 8)}` });
    job = this.store.toolJobs.get(id)!;
    job.threadId = thread.id;
    this.byThread.set(thread.id, id);
    this.save(job);
    if (!active(job)) return;
    if (this.stopped) { this.fail(job, 'interrupted', 'Limi is stopping.', 'interrupted'); return; }
    await this.manager.startTurn(thread.id, { text });
    if (this.store.toolJobs.get(id)?.state === 'cancelled') await this.manager.cancelTurn(thread.id);
  }

  private onEvent(event: StoredEvent): void {
    if (event.type === 'turn.started' && typeof event.data.text === 'string' && event.data.text.includes('<limi-tools>')) this.introduced.add(event.threadId);
    const id = this.byThread.get(event.threadId);
    const job = id ? this.store.toolJobs.get(id) : undefined;
    if (!job || !active(job) || event.data.imported || event.data.fromTerminal) return;
    if (event.type === 'turn.started') {
      job.turnId = event.turnId; job.state = 'running'; this.save(job);
    } else if (event.turnId === job.turnId && turnOutcome(event)) {
      this.finish(job, event);
    }
  }

  private finish(job: ToolJob, event: StoredEvent): void {
    const outcome = turnOutcome(event)!;
    if (outcome.outcome !== 'ok') {
      const state = outcome.outcome === 'cancelled' ? 'cancelled' : outcome.outcome === 'interrupted' ? 'interrupted' : 'failed';
      this.fail(job, outcome.code ?? state, outcome.message ?? state, state);
      return;
    }
    let resultKind: BorrowedTool['resultKind'] | undefined;
    try {
      const events = this.store.listEvents(job.threadId!, 0, -1).filter(e => e.turnId === job.turnId);
      const answer = turnAnswer(events, job.turnId!);
      job.summary = answer.slice(0, 16000);
      job.summaryTruncated = answer.length > 16000;
      const spec = this.tool(job.tool).spec;
      resultKind = spec.resultKind;
      const collected = spec.collect(events, answer, job.input);
      const artifacts: ToolArtifact[] = [];
      for (const path of collected.images ?? []) {
        try {
          const { real } = this.manager.resolveInThread(job.threadId!, path, new HttpError(404, 'artifact outside task workspace'));
          const image = this.manager.getThreadImage(job.threadId!, real);
          if (image.mimeType === 'image/svg+xml') continue;
          const bytes = readFileSync(image.path);
          if (bytes.length > 20 * 1024 * 1024 || !sniffImageType(bytes)) continue;
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          if (artifacts.some(a => a.sha256 === sha256)) continue;
          const id = randomUUID();
          const ext = image.mimeType.split('/')[1];
          const name = `image-${artifacts.length + 1}.${ext}`;
          const dir = join(this.dataDir, 'tool-artifacts', job.id);
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const saved = join(dir, `${id}.${ext}`);
          writeFileSync(saved, bytes, { flag: 'wx', mode: 0o600 });
          artifacts.push({ id, name, path: saved, mimeType: image.mimeType, size: bytes.length, sha256 });
          if (artifacts.length === 4) break;
        } catch { /* A tool can mention inaccessible intermediate paths; only verified artifacts count. */ }
      }
      if (resultKind === 'image' && !artifacts.length) throw new Error('The native tool returned no readable bitmap in its task workspace or conversation artifacts.');
      job.state = 'succeeded'; job.artifacts = artifacts; job.result = collected.data;
      this.save(job);
    } catch (err) {
      this.fail(job, resultKind === 'image' ? 'artifact_unverified' : 'result_unverified', message(err));
    }
  }

  artifact(owner: string, jobId: string, artifactId: string): ToolArtifact {
    const artifact = this.owned(owner, jobId).artifacts.find(a => a.id === artifactId);
    if (!artifact) throw new HttpError(404, 'no such artifact');
    return artifact;
  }

  private save(job: ToolJob): void {
    job.updatedAt = new Date().toISOString();
    this.store.toolJobs.save(job);
  }
  private fail(job: ToolJob, code: string, message: string, state: 'failed' | 'cancelled' | 'interrupted' = 'failed'): void {
    job.state = state; job.error = { code, message }; this.save(job);
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.launches);
    this.unsubscribe(); this.credentials.clear();
  }
}
