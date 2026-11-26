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

/** Find explicitly typed links without treating a fragment inside another URI as a local link. */
export function threadLinkCandidates(text: string): string[] {
  const found: string[] = [];
  const pattern = /https?:\/\/[^\s<>"'`，。；：、！？（）【】「」『』]+|#\/thread(?:[/?][^\s<>"'`，。；：、！？（）【】「」『』]*|(?=\s|$))/gi;
  for (const match of text.matchAll(pattern)) {
    // Chinese prose commonly touches the URL; URI slashes still cannot introduce a local hash.
    if (match.index && !/[\s([<'"，。；：、！？（【「『]/.test(text[match.index - 1]) && text.charCodeAt(match.index - 1) < 128) continue;
    const candidate = match[0].replace(/[)\]}>.,;!?]+$/, '');
    if (isThreadLinkQuery(candidate)) found.push(candidate);
  }
  return [...new Set(found)];
}
