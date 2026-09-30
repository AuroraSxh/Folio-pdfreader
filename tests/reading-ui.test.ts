import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReadingReport } from '../shared/reading';
import type { ChatEvent } from '../shared/types';
import { resolveReadingRequest } from '../src/components/readingRequest';

test('request modes keep voice smart, summary deep, and retry independent of the current selector', () => {
  const question = { prompt: ' Explain page 60. ', language: 'en' as const };
  assert.deepEqual(resolveReadingRequest(question), { prompt: 'Explain page 60.', kind: 'chat', readingMode: 'smart' });
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

type Renderer = { ReadingCoverage: ComponentType<{ report?: ReadingReport }>; ReadingProgress: ComponentType<{ progress?: ChatEvent['progress'] }>; I18nProvider: ComponentType<{ language: 'en' | 'zh-CN'; children?: ReactNode }> };
let ui: Renderer;
before(async () => {
  // Bundle CSS away for server rendering; React and the real translation context
  // stay shared. This needs neither a browser process nor a listening socket.
  const result = await build({ stdin: { contents: "export { ReadingCoverage, ReadingProgress } from './src/components/ReadingCoverage'; export { I18nProvider } from './src/i18n';", resolveDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), loader: 'tsx' }, bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', loader: { '.css': 'empty' }, logLevel: 'silent' });
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
