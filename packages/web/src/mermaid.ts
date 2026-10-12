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
