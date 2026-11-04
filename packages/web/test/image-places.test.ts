import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { placeImages, stripPaths } from '../src/image-places.js';
import { imagePlaces } from '../src/timeline.js';

/** The answer as drawn, with each strip of pictures written out as [paths] and line breaks left out. */
const draw = (text: string) => renderToStaticMarkup(createElement(Markdown, {
  remarkPlugins: [remarkGfm, placeImages(imagePlaces(text))],
  components: { div: (props: ComponentProps<'div'>) => createElement('i', null, `[${stripPaths(props as { className?: string; 'data-paths'?: unknown })?.join(',')}]`) },
}, text)).replace(/\n/g, '');

test('pictures follow the passage that names them, inside its list item', () => {
  const html = draw('Intro.\n\n- light: /tmp/shots/light.png\n- dark: /tmp/shots/dark.png\n\nThe end.');
  assert.equal(html, '<p>Intro.</p><ul><li>light: /tmp/shots/light.png<i>[/tmp/shots/light.png]</i></li><li>dark: /tmp/shots/dark.png<i>[/tmp/shots/dark.png]</i></li></ul><p>The end.</p>');
});

test('pictures in one paragraph share a strip; tables and code blocks get theirs after them', () => {
  assert.match(draw('Before ![a](a.png) and b.png here.\n\nAfter.'), /^<p>Before <img[^>]*\/> and b\.png here\.<\/p><i>\[a\.png,b\.png\]<\/i><p>After\.<\/p>$/);
  assert.match(draw('| shot |\n| --- |\n| c.png |\n\nNext.'), /<\/table><i>\[c\.png\]<\/i><p>Next\.<\/p>/);
  assert.match(draw('```\nsaved d.png\n```\n\nNext.'), /<\/pre><i>\[d\.png\]<\/i><p>Next\.<\/p>/);
});

test('a picture named twice is shown once, where it is first named; no places, no strips', () => {
  assert.equal(draw('See e.png.\n\nAgain e.png.').match(/\[e\.png\]/g)?.length, 1);
  assert.match(draw('See e.png.\n\nAgain e.png.'), /^<p>See e\.png\.<\/p><i>\[e\.png\]<\/i>/);
  assert.equal(draw('Nothing to show.'), '<p>Nothing to show.</p>');
  assert.equal(stripPaths({ className: 'note', 'data-paths': '["x.png"]' }), null);
});
