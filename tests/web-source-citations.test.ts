import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WebSearchResult } from '../shared/web-search';
import { findWebSourceCitation, visibleWebSearchResult, webSourceDomain, webSourcePopoverBounds, type WebSourceCitationMatch } from '../src/components/web-source-utils';

const result: WebSearchResult = { query: 'Study evidence', searchedAt: 1, sources: [
  { title: 'Study <title>', url: 'https://www.example.org/paper?q=1', snippet: 'Evidence & context' },
  { title: 'Another study', url: 'https://example.net/paper#results', snippet: 'Additional evidence' },
] };

test('only safe exact URLs from this answer metadata become numbered citations', () => {
  assert.deepEqual(findWebSourceCitation('https://WWW.EXAMPLE.ORG:443/paper?q=1', result), { source: result.sources[0], index: 1 });
  assert.equal(findWebSourceCitation('https://example.net/paper#results', result)?.index, 2);
  for (const url of ['https://www.example.org/invented', 'https://www.example.org/paper?q=2', 'https://www.example.org/paper?q=1#invented', 'https://elsewhere.org/', 'folio-cite://paper/1', 'javascript:alert(1)', 'file:///a.pdf', 'http://127.0.0.1/', '', undefined]) assert.equal(findWebSourceCitation(url, result), null, String(url));
  assert.equal(findWebSourceCitation(result.sources[0].url), null);
  assert.equal(findWebSourceCitation(result.sources[0].url, { ...result, searchedAt: NaN }), null);
});

test('sanitized source counts and inline numbers agree after invalid entries and canonical duplicates', () => {
  const input = { ...result, sources: [
    { title: 'Unsafe', url: 'https://user:password@example.org/', snippet: '' },
    result.sources[0], { ...result.sources[0], url: 'https://WWW.EXAMPLE.ORG:443/paper?q=1' },
    { title: 'Internal', url: 'http://service.internal/', snippet: '' },
    result.sources[1], null,
  ] };
  assert.equal(visibleWebSearchResult(input)?.sources.length, 2);
  assert.equal(findWebSourceCitation(result.sources[1].url, input)?.index, 2);
  assert.equal(findWebSourceCitation('http://service.internal/', input), null);
  assert.equal(webSourceDomain(result.sources[0].url), 'example.org');
});

test('popover geometry remains inside narrow, clipped and short assistant panels', () => {
  const viewport = { width: 1280, height: 900 };
  for (const panel of [
    { left: 900, right: 1280, top: 80, bottom: 900 },
    { left: 40, right: 340, top: 250, bottom: 720 },
    { left: -30, right: 280, top: -20, bottom: 210 },
  ]) for (const anchor of [
    { left: panel.left + 25, right: panel.left + 125, top: panel.top + 25, bottom: panel.top + 45 },
    { left: panel.right - 90, right: panel.right - 20, top: panel.bottom - 45, bottom: panel.bottom - 25 },
  ]) for (const height of [80, 300, 1000]) {
    const card = webSourcePopoverBounds(anchor, panel, viewport, height);
    assert.ok(card.left >= Math.max(12, panel.left + 12));
    assert.ok(card.left + card.width <= Math.min(viewport.width - 12, panel.right - 12));
    assert.ok(card.top >= Math.max(12, panel.top + 12));
    assert.ok(card.top + Math.min(height, card.maxHeight) <= Math.min(viewport.height - 12, panel.bottom - 12));
  }
});

type Renderer = {
  WebSourceCitation: ComponentType<{ citation: WebSourceCitationMatch; onError: (error: string) => void }>;
  I18nProvider: ComponentType<{ language: 'en' | 'zh-CN'; children?: ReactNode }>;
};
let ui: Renderer;
before(async () => {
  const built = await build({ stdin: { contents: "export { WebSourceCitation } from './src/components/WebSourceCitation'; export { I18nProvider } from './src/i18n';", resolveDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), loader: 'tsx' }, bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', loader: { '.css': 'empty' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  ui = module.exports as Renderer;
});

test('citation is a bilingual keyboard button; closed DOM contains no title, URL, snippet, dialog or remote media', () => {
  const citation = findWebSourceCitation(result.sources[0].url, result)!;
  for (const language of ['en', 'zh-CN'] as const) {
    const html = renderToStaticMarkup(createElement(ui.I18nProvider, { language }, createElement(ui.WebSourceCitation, { citation, onError: () => {} })));
    assert.match(html, /<button[^>]+type="button"/);
    assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/);
    assert.match(html, language === 'en' ? /View web source 1: example\.org/ : /查看网页来源 1：example\.org/);
    assert.doesNotMatch(html, /href=|Study|Evidence|role="dialog"|https:|<img|<iframe|folio-cite/);
  }
});

test('a directly imported unsafe citation cannot render an actionable badge', () => {
  const html = renderToStaticMarkup(createElement(ui.I18nProvider, { language: 'en' }, createElement(ui.WebSourceCitation, { citation: { source: { ...result.sources[0], url: 'javascript:alert(1)' }, index: 1 }, onError: () => {} })));
  assert.equal(html, '');
});
