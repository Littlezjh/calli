import { parseThreadLink, threadLinkCandidates } from './thread-deep-links';
import { t } from './i18n';

/** Metadata only. The daemon authorizes and reads the source when requested by the agent. */
export interface ContextReference {
  id: string;
  kind: 'thread' | 'directory' | 'message';
  title: string;
  path: string;
  sourceId?: string;
  turnId?: string;
  snapshotSeq?: number;
  at: string;
}

export function readReferences(value: unknown): ContextReference[] {
  return Array.isArray(value) ? value.filter((r): r is ContextReference => r && typeof r.id === 'string'
    && ['thread', 'directory', 'message'].includes(r.kind) && typeof r.title === 'string' && typeof r.path === 'string' && typeof r.at === 'string') : [];
}

export function withReferences(references: ContextReference[], body: string): string {
  return references.length ? `<calli-references>\n${JSON.stringify(references)}\n</calli-references>\n\n${body.trim()}`.trim() : body.trim();
}

/** Called after splitNotes, keeping old note blocks and their numbering unchanged. */
export function splitReferences(text: string): { references: ContextReference[]; body: string } {
  let references: ContextReference[] = [];
  const body = text.replace(/(?:^|\n\n)<calli-references>\n([^\n]*)\n<\/calli-references>(?=\n\n|$)/g, (block, data: string) => {
    try {
      const parsed = readReferences(JSON.parse(data));
      if (!parsed.length) return block;
      references = mergeReferences(references, parsed);
      return '';
    } catch { return block; }
  });
  return { references, body: references.length ? body.replace(/^\n+/, '') : body };
}

export function mergeReferences(a: ContextReference[], b: ContextReference[]): ContextReference[] {
  const merged = new Map<string, ContextReference>();
  for (const reference of [...a, ...b]) {
    const key = reference.kind === 'thread' && reference.sourceId ? `thread:${reference.sourceId}` : `id:${reference.id}`;
    // Keep the first thread snapshot: retries and restored queues must not advance its boundary.
    if (reference.kind !== 'thread' || !merged.has(key)) merged.set(key, reference);
  }
  return [...merged.values()];
}

export class ThreadLinkReferenceError extends Error {
  constructor(readonly reason: 'invalid' | 'remote' | 'unavailable' | 'limit' | 'editing', limit = 12) {
    super(reason === 'invalid' ? t('references.linkInvalid') : reason === 'remote' ? t('references.linkRemote')
      : reason === 'limit' ? t('references.limit', limit) : reason === 'editing' ? t('references.linkEditingSelf') : t('references.linkUnavailable'));
    this.name = 'ThreadLinkReferenceError';
  }
}

/** Resolve only at an explicit user send boundary; creating a snapshot does not grant access. */
export async function resolveThreadLinkReferences({ body, references = [], deployment, source, limit = 12, editingThreadId, onResolved }: {
  body: string;
  references?: ContextReference[];
  deployment: string;
  source?: { host: string | null; createReference: (input: { kind: 'thread'; sourceId: string }) => Promise<ContextReference> };
  limit?: number;
  editingThreadId?: string;
  /** Persist each completed snapshot into the captured draft, even if a later lookup fails. */
  onResolved?: (references: ContextReference[]) => void;
}): Promise<ContextReference[]> {
  let resolved = mergeReferences(references, []);
  // A native edit rewrites the source before sending, invalidating even a previously selected self snapshot.
  if (editingThreadId && resolved.some(reference => reference.kind === 'thread' && reference.sourceId === editingThreadId)) throw new ThreadLinkReferenceError('editing');
  const targets = new Set<string>();
  const candidates = threadLinkCandidates(body);
  // Validate every link and the final count before creating anything or sending a partial message.
  for (const candidate of candidates) {
    const link = parseThreadLink(candidate, deployment);
    if (!link) throw new ThreadLinkReferenceError('invalid');
    if (!source) throw new ThreadLinkReferenceError('unavailable');
    // A link without machine names the main Hub, not whichever remote view is currently open.
    if (link.machine !== source.host) throw new ThreadLinkReferenceError('remote');
    if (link.id === editingThreadId) throw new ThreadLinkReferenceError('editing');
    if (!resolved.some(reference => reference.kind === 'thread' && reference.sourceId === link.id)) targets.add(link.id);
  }
  if (resolved.length + targets.size > limit) throw new ThreadLinkReferenceError('limit', limit);
  for (const sourceId of targets) {
    let reference: ContextReference;
    try { reference = await source!.createReference({ kind: 'thread', sourceId }); }
    catch { throw new ThreadLinkReferenceError('unavailable'); }
    if (reference.kind !== 'thread' || reference.sourceId !== sourceId) throw new ThreadLinkReferenceError('unavailable');
    resolved = mergeReferences(resolved, [reference]);
    onResolved?.(resolved);
  }
  return resolved;
}

/** Compact queue/search labels never expose the metadata wire format. */
export function referencePreview(text: string): string {
  return text.replace(/(?:^|\n\n)<calli-references>\n([^\n]*)\n<\/calli-references>(?=\n\n|$)/g, (_, data: string) => {
    try { return readReferences(JSON.parse(data)).map(r => r.title).join(' · '); }
    catch { return ''; }
  }).replace(/\n\n/g, '\n');
}
