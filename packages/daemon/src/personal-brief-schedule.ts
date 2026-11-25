import { HttpError } from './errors.js';
import { buildBrief, LAST_BRIEF_KEY, type BriefKind, type PersonalBrief, type LastPersonalBrief } from './personal-brief.js';
import type { PushService } from './push.js';
import type { Store } from './store.js';
import type { TodoStage } from './todo-priority.js';

export interface BriefSettings { enabled: boolean; morning: string; evening: string; deep?: boolean }
export type DeepBriefRunner = (kind: BriefKind, now: Date) => Promise<{ status: 'brief' | 'quiet' | 'fallback'; brief?: { headline: string }; markdown?: string }>;
const KEY = 'personalBriefSettings';
const SENT = 'personalBriefSent';
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const minutes = (time: string) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
const day = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** Uses the existing scheduler's tick and push queue; no second timer or agent thread unless `deep` is opted in. */
export class PersonalBriefSchedule {
  private readonly deepInFlight = new Set<string>();
  constructor(private readonly store: Store, private readonly quietHours: () => { start: string; end: string },
    private readonly stages: () => Map<string, TodoStage | null> = () => new Map()) {}
  settings(): BriefSettings { return this.store.hubSetting(KEY, { enabled: false, morning: '09:00', evening: '19:00' }); }
  save(input: Record<string, unknown>): BriefSettings {
    const next = { ...this.settings(), ...input };
    if (typeof next.enabled !== 'boolean' || typeof next.morning !== 'string' || !TIME.test(next.morning) || typeof next.evening !== 'string' || !TIME.test(next.evening)) throw new HttpError(400, 'brief settings require enabled and HH:mm times');
    if (next.deep !== undefined && typeof next.deep !== 'boolean') throw new HttpError(400, 'brief deep must be a boolean');
    const value: BriefSettings = { enabled: next.enabled, morning: next.morning, evening: next.evening, ...(next.deep !== undefined ? { deep: next.deep } : {}) };
    this.store.saveHubSetting(KEY, value); return value;
  }
  preview(kind: unknown, now = new Date()): PersonalBrief | null {
    if (kind !== 'morning' && kind !== 'evening') throw new HttpError(400, 'kind must be morning or evening');
    const stages = this.stages();
    const todos = this.store.listTodos().map(todo => ({ ...todo, stage: stages.get(todo.id) ?? null, threads: this.store.todoThreadIds(todo.id).flatMap(id => {
      const thread = this.store.getThread(id); return thread ? [{ updatedAt: thread.updatedAt }] : [];
    }) }));
    return buildBrief(kind, todos, now);
  }
  last(kind: unknown): LastPersonalBrief | null {
    if (kind !== 'morning' && kind !== 'evening') throw new HttpError(400, 'kind must be morning or evening');
    return this.store.hubSetting<Partial<Record<BriefKind, LastPersonalBrief>>>(LAST_BRIEF_KEY, {})[kind] ?? null;
  }
  tick(now: Date, push?: Pick<PushService, 'brief'>, deepRunner?: DeepBriefRunner): void {
    const settings = this.settings();
    if (!push || !settings.enabled) return;
    const quiet = this.quietHours();
    const current = now.getHours() * 60 + now.getMinutes();
    const start = minutes(quiet.start), end = minutes(quiet.end);
    if (start !== end && (start < end ? current >= start && current < end : current >= start || current < end)) return;
    const today = day(now);
    for (const kind of ['morning', 'evening'] as BriefKind[]) {
      // Match just this minute. Downtime and quiet hours never cause surprise catch-up messages.
      if (minutes(settings[kind]) !== current) continue;
      const sent = this.store.hubSetting<Partial<Record<BriefKind, string>>>(SENT, {});
      if (sent[kind] && sent[kind]! >= today) continue;
      if (settings.deep === true && deepRunner) {
        const flightKey = `${today}:${kind}`;
        if (this.deepInFlight.has(flightKey)) continue;
        this.deepInFlight.add(flightKey);
        this.store.saveHubSetting(SENT, { ...sent, [kind]: today });
        void deepRunner(kind, now).then(result => {
          if (result.status === 'brief' && result.markdown) {
            const last = this.store.hubSetting<Partial<Record<BriefKind, LastPersonalBrief>>>(LAST_BRIEF_KEY, {});
            this.store.saveHubSetting(LAST_BRIEF_KEY, { ...last, [kind]: { text: result.markdown, sentAt: new Date().toISOString() } });
            return;
          }
          if (result.status === 'quiet') return;
          const fallback = this.preview(kind, now);
          if (fallback && !push.brief(kind, fallback, `brief-${today}-${kind}`)) this.store.saveHubSetting(SENT, sent);
        }).catch(() => {
          const fallback = this.preview(kind, now);
          if (fallback && !push.brief(kind, fallback, `brief-${today}-${kind}`)) this.store.saveHubSetting(SENT, sent);
        }).finally(() => { this.deepInFlight.delete(flightKey); });
        continue;
      }
      const brief = this.preview(kind, now);
      if (!brief) { this.store.saveHubSetting(SENT, { ...sent, [kind]: today }); continue; }
      // Reserve before enqueueing. This also survives a restart in the same minute or a DST repeat.
      this.store.saveHubSetting(SENT, { ...sent, [kind]: today });
      if (!push.brief(kind, brief, `brief-${today}-${kind}`)) this.store.saveHubSetting(SENT, sent);
    }
  }
}
