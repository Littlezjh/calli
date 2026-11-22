/** The browser's stable Calli identity, independent of the agent's native session ID. */
export interface ThreadDeepLink {
  id: string;
  machine: string | null;
}

/** Preserve hash links used by existing extensions and notifications. */
export function threadLinkHash(id: string, machine: string | null): string {
  // Escape Markdown delimiters too, so a copied link remains intact inside a sentence.
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `#/thread/${encode(id)}${machine === null ? '' : `?machine=${encode(machine)}`}`;
}

/** Copy only the deployment address and thread identity, never login parameters or credentials. */
export function threadDeepLink(id: string, machine: string | null, location: string): string {
  const url = new URL(location);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid Calli deployment');
  url.username = ''; url.password = ''; url.search = '';
  url.hash = threadLinkHash(id, machine);
  return url.href;
}

/** Full URLs must belong to this deployment before they can be used as local references. */
export function parseThreadLink(value: string, deployment?: string): ThreadDeepLink | null {
  try {
    let hash = value.trim();
    if (/\s/.test(hash)) return null; // A search link is one exact address, not a link plus keywords.
    if (!hash.startsWith('#')) {
      const url = new URL(hash);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      if (deployment) {
        const current = new URL(deployment);
        if (url.origin !== current.origin || url.pathname !== current.pathname) return null;
      }
      hash = url.hash;
    }
    if (!hash.startsWith('#/thread/')) return null;
    const queryAt = hash.indexOf('?');
    const encoded = hash.slice('#/thread/'.length, queryAt < 0 ? undefined : queryAt);
    const id = decodeURIComponent(encoded);
    if (!id || /[\s/\\?#\u0000-\u001f\u007f]/.test(id)) return null;
    const query = queryAt < 0 ? '' : hash.slice(queryAt + 1);
    decodeURIComponent(query.replace(/\+/g, ' ')); // URLSearchParams alone tolerates broken encoding.
    const params = new URLSearchParams(query);
    if (params.getAll('machine').length > 1) return null;
    const machine = params.get('machine') || null;
    if (machine && /[\u0000-\u001f\u007f]/.test(machine)) return null;
    return { id, machine };
  } catch { return null; }
}

/** A link-shaped search gets its own result/error state rather than a full-text search. */
export function isThreadLinkQuery(value: string): boolean {
  return /^(?:https?:\/\/\S*)?#\/thread(?:\/|$|\?)/i.test(value.trim());
}

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const COPY_INVISIBLES = /[\xAD\u{200B}-\u{200F}\u{2060}\u{FEFF}]/gu;
const COPY_HYPHENS = /[\u{2010}-\u{2015}\u{2212}\u{FE63}\u{FF0D}]/gu;
const ATTACHED_PROSE = /^(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u{2013}\u{2014}\u{2026}]|:+$)/u;

/** Repair only a temporary UUID identity, never deployment paths, machines or the user's text. */
function normalizeThreadLinkCandidate(candidate: string): string {
  const hashAt = candidate.indexOf('#');
  if (!candidate.startsWith('#/thread/', hashAt)) return candidate;
  const start = hashAt + '#/thread/'.length;
  const queryAt = candidate.indexOf('?', start);
  const end = queryAt < 0 ? candidate.length : queryAt;
  let id: string;
  try { id = decodeURIComponent(candidate.slice(start, end)); }
  catch { return candidate; }
  const cleaned = id.replace(COPY_INVISIBLES, '');
  const uuid = UUID_PREFIX.exec(cleaned.replace(COPY_HYPHENS, '-'))?.[0];
  // Non-UUID and ambiguous longer IDs retain exact matching; only unambiguous prose is detached.
  if (!uuid || cleaned.length > uuid.length && !ATTACHED_PROSE.test(cleaned.slice(uuid.length))) return candidate;
  return candidate.slice(0, start) + uuid.toLowerCase() + candidate.slice(end);
}

/** Find explicitly typed links without treating a fragment inside another URI as a local link. */
export function threadLinkCandidates(text: string): string[] {
  const found: string[] = [];
  // Keep embedded BOMs available to UUID repair while other whitespace still separates links.
  const pattern = /https?:\/\/(?:[^\s<>"'`“”‘’，。；：、！？（）【】「」『』]|\u{FEFF})+|#\/thread(?:[/?](?:[^\s<>"'`“”‘’，。；：、！？（）【】「」『』]|\u{FEFF})*|(?=\s|$))/giu;
  for (const match of text.matchAll(pattern)) {
    // Chinese prose commonly touches the URL; URI slashes still cannot introduce a local hash.
    if (match.index && !/[\s([<'"`，。；：、！？（【「『]/.test(text[match.index - 1]) && text.charCodeAt(match.index - 1) < 128) continue;
    // Unrepaired BOMs retain their original whitespace-boundary meaning for legacy IDs and queries.
    const candidate = normalizeThreadLinkCandidate(match[0].replace(/[)\]}>.,;!?]+$/, '')).split('\u{FEFF}')[0];
    if (isThreadLinkQuery(candidate)) found.push(candidate);
  }
  return [...new Set(found)];
}
