import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReadingReport } from '../shared/reading';
import type { WebSearchResult } from '../shared/web-search';
import type { ChatEvent, TextSelection } from '../shared/types';
import { resolveReadingRequest, resolveReadingSources } from '../src/components/readingRequest';

test('request modes keep voice smart, summary deep, and retry independent of the current selector', () => {
  const question = { prompt: ' Explain page 60. ', language: 'en' as const };
  assert.deepEqual(resolveReadingRequest(question), { prompt: 'Explain page 60.', kind: 'chat', readingMode: 'smart', webSearch: false });
  assert.equal(resolveReadingRequest({ ...question, mode: 'deep' }).readingMode, 'deep');
  assert.equal(resolveReadingRequest({ ...question, kind: 'summary', mode: 'smart' }).readingMode, 'deep');
  assert.equal(resolveReadingRequest({ ...question, mode: 'deep', override: 'smart' }).readingMode, 'smart');
  assert.equal(resolveReadingRequest({ ...question, mode: 'smart', override: 'deep' }).readingMode, 'deep');
  assert.equal(resolveReadingRequest({ ...question, mode: 'deep', override: 'deep', voice: true }).readingMode, 'smart');
});
test('an empty deep request uses the selected language summary prompt; smart input stays empty', () => {
  const english = resolveReadingRequest({ prompt: ' ', mode: 'deep', language: 'en' });
  const chinese = resolveReadingRequest({ prompt: '', mode: 'deep', language: 'zh-CN' });
  assert.equal(english.kind, 'summary'); assert.equal(chinese.kind, 'summary');
  assert.match(english.prompt, /structured reading notes/i); assert.match(chinese.prompt, /笔记|总结|摘要/);
  assert.equal(resolveReadingRequest({ prompt: ' ', language: 'en' }).prompt, '');
  assert.equal(resolveReadingRequest({ prompt: '', mode: 'deep', voice: true, language: 'en' }).prompt, '');
});

test('web search is opt-in in every reading mode and voice, while retry and automatic summaries keep an explicit snapshot', () => {
  const question = { prompt: 'Explain this result.', language: 'en' as const };
  for (const mode of ['smart', 'deep'] as const) {
    assert.equal(resolveReadingRequest({ ...question, mode }).webSearch, false);
    assert.equal(resolveReadingRequest({ ...question, mode, voice: true }).webSearch, false);
    assert.equal(resolveReadingRequest({ ...question, mode, webSearch: true }).webSearch, true);
  }
  assert.equal(resolveReadingRequest({ ...question, webSearch: true, webSearchOverride: false }).webSearch, false);
  assert.equal(resolveReadingRequest({ ...question, webSearch: false, webSearchOverride: true }).webSearch, true);
  assert.equal(resolveReadingRequest({ ...question, kind: 'summary', webSearch: true, webSearchOverride: false }).webSearch, false);
  assert.equal(resolveReadingRequest({ ...question, voice: true, webSearch: true }).webSearch, true);
});

const sourceDocuments = [{ id: 'paper' }, { id: 'supplement' }, { id: 'figures' }];
const quote = (documentId = 'supplement', text = 'Selected evidence'): TextSelection => ({ documentId, documentName: `${documentId}.pdf`, page: 4, text, rects: [[0.1, 0.2, 0.3, 0.4]] });

test('a passage from another PDF joins the filtered sources without replacing them', () => {
  const selection = quote();
  const result = resolveReadingSources({ documents: sourceDocuments, source: 'paper', selection });
  assert.deepEqual(result.documentIds, ['paper', 'supplement']);
  assert.equal(result.selection, selection);
  assert.equal(result.addedSelectionDocument, true);
  assert.equal(result.selectionUnavailable, false);
});

test('all-documents and same-document scopes include the quote once, and clearing it restores the base scope', () => {
  const selection = quote();
  const all = resolveReadingSources({ documents: sourceDocuments, source: 'all', selection });
  assert.deepEqual(all.documentIds, ['paper', 'supplement', 'figures']);
  assert.equal(all.addedSelectionDocument, false);
  const same = resolveReadingSources({ documents: sourceDocuments, source: 'supplement', selection });
  assert.deepEqual(same.documentIds, ['supplement']);
  assert.equal(same.addedSelectionDocument, false);
  const cleared = resolveReadingSources({ documents: sourceDocuments, source: 'paper', selection: null });
  assert.deepEqual(cleared.documentIds, ['paper']);
  assert.equal(cleared.selection, undefined);
});

test('retry keeps its original quote and ordered sources despite a new picker value or live selection', () => {
  const original = quote('paper', 'Original passage');
  const documentIds = ['supplement', 'paper'];
  const result = resolveReadingSources({ documents: sourceDocuments, source: 'figures', selection: quote('figures', 'A different passage'), sourceOverride: documentIds, selectionOverride: original });
  assert.deepEqual(result.documentIds, documentIds);
  assert.notEqual(result.documentIds, documentIds);
  assert.equal(result.selection, original);
  assert.equal(result.addedSelectionDocument, false);
  assert.deepEqual(documentIds, ['supplement', 'paper']);
});

test('a retry originally without a quote and an explicit summary request never inherit a newer quote', () => {
  for (const selectionOverride of [null, undefined]) {
    const result = resolveReadingSources({ documents: sourceDocuments, source: 'all', selection: quote('figures'), sourceOverride: ['paper'], selectionOverride });
    assert.deepEqual(result.documentIds, ['paper']);
    assert.equal(result.selection, undefined);
    assert.equal(result.addedSelectionDocument, false);
  }
  const withoutQuote = resolveReadingSources({ documents: sourceDocuments, source: 'paper', selection: quote(), selectionOverride: null });
  assert.deepEqual(withoutQuote.documentIds, ['paper']);
  assert.equal(withoutQuote.selection, undefined);
});

test('a quote from a removed or different-workspace document is reported unavailable, not added to request sources', () => {
  const result = resolveReadingSources({ documents: sourceDocuments, source: 'paper', selection: quote('removed') });
  assert.deepEqual(result.documentIds, ['paper']);
  assert.equal(result.selection, undefined);
  assert.equal(result.selectionUnavailable, true);
  assert.equal(result.addedSelectionDocument, false);
  const retry = resolveReadingSources({ documents: sourceDocuments, source: 'all', selection: quote(), sourceOverride: ['paper'], selectionOverride: quote('removed') });
  assert.equal(retry.selectionUnavailable, true);
  assert.deepEqual(retry.documentIds, ['paper']);
});

type Renderer = { ReadingCoverage: ComponentType<{ report?: ReadingReport }>; ReadingProgress: ComponentType<{ progress?: ChatEvent['progress'] }>; WebSearchSources: ComponentType<{ result?: WebSearchResult; onError: (error: string) => void }>; visibleWebSearchResult: (input: unknown) => WebSearchResult | null; I18nProvider: ComponentType<{ language: 'en' | 'zh-CN'; children?: ReactNode }> };
let ui: Renderer;
before(async () => {
  // Bundle CSS away for server rendering; React and the real translation context
  // stay shared. This needs neither a browser process nor a listening socket.
  const result = await build({ stdin: { contents: "export { ReadingCoverage, ReadingProgress } from './src/components/ReadingCoverage'; export { WebSearchSources, visibleWebSearchResult } from './src/components/WebSearchSources'; export { I18nProvider } from './src/i18n';", resolveDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), loader: 'tsx' }, bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', loader: { '.css': 'empty' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  ui = module.exports as Renderer;
});
const report = (mode: 'smart' | 'deep', complete: boolean): ReadingReport => ({ mode, complete, documents: [{ documentId: 'paper', name: 'Paper.pdf', totalPages: 100, readablePages: 99, includedPages: Array.from({ length: 99 }, (_, index) => index + 1), unavailablePages: [100] }], batches: 5, cachedBatches: 2 });
const renderCoverage = (value: unknown, language: 'en' | 'zh-CN' = 'en') => renderToStaticMarkup(createElement(ui.I18nProvider, { language }, createElement(ui.ReadingCoverage, { report: value as ReadingReport })));

test('coverage renders bilingual source ranges and distinguishes short full-context smart answers from retrieved excerpts', () => {
  assert.match(renderCoverage(report('smart', true)), /All extractable text from the selected documents was provided/);
  assert.match(renderCoverage(report('smart', false)), /complete text from every page was not sent/);
  assert.match(renderCoverage(report('smart', true), 'zh-CN'), /全部可提取文字均已提供/);
  assert.match(renderCoverage(report('deep', true)), /1–99/);
  assert.match(renderCoverage(report('deep', true)), /No extractable text: 100/);
  assert.match(renderCoverage(report('deep', true)), /Reused 2 previously read sections/);
});
test('unfinished synthesis remains incomplete even when every text page was read, and malformed imported reports are hidden', () => {
  const html = renderCoverage(report('deep', false));
  assert.match(html, /Text read from 99\/100 pages/);
  assert.match(html, /This reading is unfinished/);
  assert.doesNotMatch(html, /not covered all available text/);
  assert.equal(renderCoverage({ mode: 'deep', documents: [null], complete: true }), '');
});
test('reading progress renders accessible determinate counts and localized phase descriptions', () => {
  const progress = { phase: 'reading' as const, completed: 2, total: 5, cached: 1 };
  const html = renderToStaticMarkup(createElement(ui.I18nProvider, { language: 'en' }, createElement(ui.ReadingProgress, { progress })));
  assert.match(html, /role="status"/); assert.match(html, /aria-live="polite"/);
  assert.match(html, /Full-paper reading progress/); assert.match(html, /max="5" value="2"/);
  const chinese = renderToStaticMarkup(createElement(ui.I18nProvider, { language: 'zh-CN' }, createElement(ui.ReadingProgress, { progress: { phase: 'synthesizing', completed: 5, total: 5 } })));
  assert.match(chinese, /正在综合已读内容/);
});

test('selection-only answers show unknown totals instead of dropping their report or claiming full-text retrieval', () => {
  const value: ReadingReport = { mode: 'smart', complete: false, documents: [{ documentId: 'paper', name: 'Paper.pdf', totalPages: 0, readablePages: 1, includedPages: [60], unavailablePages: [] }] };
  const html = renderCoverage(value, 'zh-CN');
  assert.match(html, /片段涉及 1 页（总页数未知）/);
  assert.match(html, /片段页码：60/);
  assert.doesNotMatch(html, /1\/0|先在全文中寻找/);
  assert.match(renderCoverage(value), /Excerpts span 1 pages \(total unknown\)/);
});

const searchResult: WebSearchResult = { query: 'Related studies', searchedAt: Date.UTC(2026, 9, 13), sources: [{ title: 'Study <title>', url: 'https://example.org/paper', snippet: 'Evidence & context', publishedAt: '2026-09-20' }] };
const renderSearch = (result: unknown, language: 'en' | 'zh-CN' = 'en') => renderToStaticMarkup(createElement(ui.I18nProvider, { language }, createElement(ui.WebSearchSources, { result: result as WebSearchResult, onError: () => {} })));

test('web sources render separate accessible bilingual links, dates, and escaped snippets without fetching favicons', () => {
  const english = renderSearch(searchResult);
  assert.match(english, /aria-label="Web sources"/);
  assert.match(english, /href="https:\/\/example\.org\/paper"/);
  assert.match(english, /Study &lt;title&gt;/);
  assert.match(english, /Evidence &amp; context/);
  assert.match(english, /example\.org/);
  assert.match(english, /Searched/);
  assert.doesNotMatch(english, /<img|<iframe/);
  const chinese = renderSearch(searchResult, 'zh-CN');
  assert.match(chinese, /aria-label="网页来源"/);
  assert.match(chinese, /搜索：Related studies/);
  assert.match(chinese, /搜索于/);
});

test('imported web source data cannot create unsafe links, duplicates, invalid dates, or render-time errors', () => {
  const input = { ...searchResult, sources: [
    ...searchResult.sources, ...searchResult.sources,
    { title: 'Unsafe JS', url: 'javascript:alert(1)', snippet: 'blocked' },
    { title: 'Local file', url: 'file:///private/local.pdf', snippet: 'blocked' },
    { title: 'Private service', url: 'http://127.0.0.1:9000', snippet: 'blocked' },
    { title: 'Credentials', url: 'https://user:secret@example.org/', snippet: 'blocked' },
    { title: '', url: 'https://example.net/', publishedAt: 'not-a-date' },
    null,
  ] };
  const safe = ui.visibleWebSearchResult(input)!;
  assert.equal(safe.sources.length, 2);
  assert.equal(safe.sources[1].title, 'example.net');
  assert.equal(safe.sources[1].publishedAt, undefined);
  const html = renderSearch(input);
  assert.doesNotMatch(html, /Unsafe JS|Local file|Private service|Credentials|javascript:|file:|Invalid Date/);
  assert.equal(renderSearch({ ...searchResult, sources: null }), '');
  assert.equal(renderSearch({ ...searchResult, searchedAt: Number.NaN }), '');
});

test('a completed empty search is stated honestly and absent search metadata creates no source card', () => {
  assert.match(renderSearch({ ...searchResult, sources: [] }), /no usable web sources/);
  assert.match(renderSearch({ ...searchResult, sources: [] }, 'zh-CN'), /没有返回可用的网页来源/);
  assert.equal(renderSearch(undefined), '');
});
