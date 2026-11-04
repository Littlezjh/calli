/**
 * Where an answer's pictures go: right after the passage that names them, not all at the bottom.
 *
 * A remark plugin, given each picture's path and where in the text it is first named. It finds the
 * block holding that place (a paragraph, a heading, a table, a code block) and puts a strip of
 * pictures after it, inside the same list item or quote. A picture named nowhere such a block can
 * hold it goes to a strip at the very end. The strip is an element Markdown draws as a `div` with
 * the class `file-images` and the paths in `data-paths`; the component for `div` puts the pictures up.
 */

interface Node {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
  data?: Record<string, unknown>;
}

export interface ImagePlace {
  path: string;
  at: number;
}

/** Blocks a picture can follow. Everything an answer says sits in one of these. */
const HOSTS = new Set(['paragraph', 'heading', 'table', 'code', 'html']);

export const IMAGE_STRIP_CLASS = 'file-images';

function strip(paths: string[]): Node {
  return { type: 'imageStrip', data: { hName: 'div', hProperties: { className: [IMAGE_STRIP_CLASS], dataPaths: JSON.stringify(paths) } } };
}

export function placeImages(places: ImagePlace[]) {
  return () => (tree: Node) => {
    if (!places.length) return;
    const left = new Set(places);
    const visit = (parent: Node) => {
      const children = parent.children ?? [];
      for (let i = 0; i < children.length; i++) {
        const node = children[i];
        if (!HOSTS.has(node.type)) {
          visit(node);
          continue;
        }
        const from = node.position?.start.offset;
        const to = node.position?.end.offset;
        if (from === undefined || to === undefined) continue;
        const here = places.filter((p) => left.has(p) && p.at >= from && p.at < to);
        if (!here.length) continue;
        for (const p of here) left.delete(p);
        children.splice(i + 1, 0, strip(here.map((p) => p.path)));
        i++;
      }
    };
    visit(tree);
    if (left.size) (tree.children ??= []).push(strip([...left].map((p) => p.path)));
  };
}

/** The paths a strip carries, read back from the element Markdown drew. */
export function stripPaths(props: { className?: string; 'data-paths'?: unknown }): string[] | null {
  if (!props.className?.split(' ').includes(IMAGE_STRIP_CLASS) || typeof props['data-paths'] !== 'string') return null;
  try {
    const paths: unknown = JSON.parse(props['data-paths']);
    return Array.isArray(paths) && paths.every((p) => typeof p === 'string') ? paths : null;
  } catch {
    return null;
  }
}
