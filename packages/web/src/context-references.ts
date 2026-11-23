import { splitNotes, withNotes } from './timeline';

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
  return [...new Map([...a, ...b].map(r => [r.id, r])).values()];
}

/** Attaches a fallback reference after leading notes, skipping duplicates or texts already at the limit. */
export function attachFallbackReference(text: string, reference?: ContextReference | null): string {
  if (!reference) return text;
  const noted = splitNotes(text);
  const referenced = splitReferences(noted.body);
  if (reference.kind === 'thread' && reference.sourceId
    && referenced.references.some(item => item.kind === 'thread' && item.sourceId === reference.sourceId)) return text;
  if (referenced.references.length >= 12) return text;
  return withNotes(noted.notes, withReferences(mergeReferences(referenced.references, [reference]), referenced.body));
}

/** Compact queue/search labels never expose the metadata wire format. */
export function referencePreview(text: string): string {
  return text.replace(/(?:^|\n\n)<calli-references>\n([^\n]*)\n<\/calli-references>(?=\n\n|$)/g, (_, data: string) => {
    try { return readReferences(JSON.parse(data)).map(r => r.title).join(' · '); }
    catch { return ''; }
  }).replace(/\n\n/g, '\n');
}
