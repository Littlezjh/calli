import { test } from 'node:test';
import assert from 'node:assert/strict';
import remarkGfm from 'remark-gfm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { trimAutolinkJunk } from '../src/markdown-links.js';

const render = (text: string) =>
  renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkGfm, trimAutolinkJunk] }, text));

test('autolinks do not swallow emphasis markers or CJK punctuation', () => {
  const html = render('打开（或刷新）\n**http://192.0.2.10:8899/**（PID 3174724）：');
  assert.ok(!/%EF%BC%88/.test(html), 'no percent-encoded CJK inside the link: ' + html);
  assert.ok(html.includes('href="http://192.0.2.10:8899/"'), 'the link is the plain address: ' + html);
  assert.ok(html.includes('<strong>'), 'the emphasis is restored: ' + html);
  assert.ok(!/\*\*/.test(html), 'no literal markers remain: ' + html);
});

test('a plain autolink is left alone', () => {
  const html = render('see https://example.com/a for more');
  assert.ok(html.includes('href="https://example.com/a"'), html);
  assert.ok(html.includes('>https://example.com/a</a> for more'), html);
});

test('trailing CJK punctuation is handed back to the text', () => {
  const html = render('见 http://10.0.0.1:8899/，然后继续。');
  assert.ok(html.includes('href="http://10.0.0.1:8899/"'), html);
  assert.ok(html.includes('8899/</a>，然后继续。'), html);
});
