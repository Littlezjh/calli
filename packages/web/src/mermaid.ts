/**
 * Mermaid diagrams in answers: an agent describing an architecture in a ```mermaid block gets a
 * drawing instead of syntax. The library is a megabyte, so it is loaded the first time a diagram
 * actually appears — a conversation without one never pays for it — and it re-renders with the
 * theme when the look changes. Anything it cannot parse stays code, the way a broken SVG does.
 */

let loading: Promise<typeof import('mermaid').default> | null = null;

/** Renders one diagram to the SVG markup mermaid produces, themed as the page is. */
export async function renderMermaidDiagram(code: string, dark = document.documentElement.dataset.theme === 'dark'): Promise<string> {
  loading ??= import('mermaid').then((m) => m.default);
  const mermaid = await loading;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
  const { svg } = await mermaid.render(`mmd-${Math.random().toString(36).slice(2)}`, code);
  return svg;
}

/** Isolate the enlarged inline SVG's IDs, including its CSS and marker references. Called on open. */
export function enlargeMermaidDiagram(svg: string): string {
  // Mermaid's HTML labels can contain <br> and named entities. Parse like the inline preview.
  const document = new DOMParser().parseFromString(svg, 'text/html');
  const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
  const prefix = `enlarged-${Math.random().toString(36).slice(2)}-`;
  for (const node of document.querySelectorAll('[id]')) node.id = prefix + node.id;
  for (const node of document.querySelectorAll('[aria-labelledby], [aria-describedby]')) {
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      const value = node.getAttribute(attribute);
      if (value) node.setAttribute(attribute, value.split(/\s+/).map(id => ids.includes(id) ? prefix + id : id).join(' '));
    }
  }
  let markup = new XMLSerializer().serializeToString(document.querySelector('svg')!);
  // Match longer IDs first: a diagram's root ID can prefix its marker IDs.
  for (const id of ids.sort((a, b) => b.length - a.length)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    markup = markup.replace(new RegExp(`#${escaped}(?=[\\s).,;:"'\\]{}>]|$)`, 'g'), `#${prefix}${id}`);
  }
  return markup;
}
