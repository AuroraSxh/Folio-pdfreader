import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { newWorkspace } from '../electron/store';
import { buildSmartContext, planDeepReading, clearReadingCache, getReadingCacheStats, type ReadingSource } from '../shared/reading';

const workspace = newWorkspace('Research paper');
const filler = 'The experiment followed established procedures with replicate measurements and controls. '.repeat(12);
const source = (id: string, pages: string[], role: ReadingSource['role'] = 'main'): ReadingSource => ({ id, name: `${id}.pdf`, pages, role });

test('smart reading finds evidence unique to page 60 instead of filling the budget from the front', () => {
  const pages = Array.from({ length: 80 }, () => filler);
  pages[59] = 'Znf608 regulates the unusual zephyrase response. The measured zephyrase value was 742.\n\n' + filler;
  const context = buildSmartContext(workspace, [source('Main', pages)], 7000, 'What was the zephyrase value?');
  assert.match(context.content, /zephyrase value was 742/);
  assert.match(context.content, /\[Main\.pdf p\.60\]/);
  assert.ok(context.report.documents[0].includedPages.includes(60));
  assert.equal(context.strategy, 'retrieval');assert.equal(context.report.complete, false);
  assert.ok(context.content.length <= 7000);
});

test('short papers send every readable page and record blank or missing pages separately', () => {
  const docs = [{ ...source('Main', ['Introduction', '', 'Final finding']), pageCount: 4 }, source('Supplement', ['Control measurements'], 'supplement')];
  const context = buildSmartContext(workspace, docs, 5000, 'unmatched question');
  assert.equal(context.strategy, 'full');assert.equal(context.report.complete, true);
  assert.deepEqual(context.report.documents[0], { documentId: 'Main', name: 'Main.pdf', totalPages: 4, readablePages: 2, includedPages: [1, 3], unavailablePages: [2, 4] });
  assert.deepEqual(context.report.documents[1].includedPages, [1]);assert.equal(context.needsQueryRewrite, false);
  assert.match(context.warnings.join(' '), /2 页没有可提取文字/);
});

test('a tiny supplement does not reserve half the budget or truncate an otherwise fitting main paper', () => {
  const docs = [source('Main', ['Main evidence '.repeat(400)]), source('Supplement', ['Short supporting observation'], 'supplement')];
  const context = buildSmartContext(workspace, docs, 6500, 'evidence');
  assert.equal(context.strategy, 'full');assert.match(context.content, /Short supporting observation/);
  assert.equal((context.content.match(/Main evidence/g) ?? []).length, 400);
});

test('relevant evidence is retrieved across the main paper and multiple supplements', () => {
  const docs = [source('Main', [filler, 'Zephyrase treatment changed the response. ' + filler]),
    source('Supplement-A', [filler, 'Zephyrase controls establish specificity. ' + filler], 'supplement'),
    source('Supplement-B', [filler, 'Zephyrase sample size was forty. ' + filler], 'supplement')];
  const context = buildSmartContext(workspace, docs, 6500, 'What are the zephyrase response, controls, and sample size?');
  assert.equal(context.strategy, 'retrieval');
  for (const doc of context.report.documents) assert.ok(doc.includedPages.includes(2), `${doc.name} evidence should be included`);
  assert.match(context.content, /response/);assert.match(context.content, /specificity/);assert.match(context.content, /forty/);
});

test('explicit page numbers, figure aliases and supplementary figure labels find later pages', () => {
  const main = Array.from({ length: 65 }, (_, page) => `Main section ${page + 1}. ` + filler);
  main[58] = 'Fig. 7. The krypton assay result was positive.\n' + filler;
  main[59] = 'Requested page sixty contains the complete protocol.\n' + filler;
  const supplement = Array.from({ length: 12 }, () => filler);
  supplement[10] = 'Figure S7. Supplementary validation uses violet markers.\n' + filler;
  const docs = [source('Main', main), source('Supplement', supplement, 'supplement')];
  for (const query of ['page60', '第60页', 'p.60']) {
    const context = buildSmartContext(workspace, docs, 4000, query);
    assert.ok(context.report.documents[0].includedPages.includes(60));assert.match(context.content, /Requested page sixty/);
  }
  const figure = buildSmartContext(workspace, docs, 4000, '图7');
  assert.ok(figure.report.documents[0].includedPages.includes(59));assert.match(figure.content, /krypton assay/);
  const extra = buildSmartContext(workspace, docs, 4000, '补充S7');
  assert.ok(extra.report.documents[1].includedPages.includes(11));assert.match(extra.content, /violet markers/);
});

test('scientific tokens retain punctuation, common aliases match, and query expansion retrieves English evidence', () => {
  const pages = Array.from({ length: 20 }, () => filler);
  pages[16] = 'CD4+ and fl/fl mice had distinct phenotypes. A tumour deficient in Znf608 was observed.\n' + filler;
  const docs = [source('Main', pages)];
  for (const query of ['CD4+ fl/fl', 'tumor knockout']) {
    const context = buildSmartContext(workspace, docs, 4000, query);
    assert.ok(context.report.documents[0].includedPages.includes(17));assert.match(context.content, /Znf608/);
  }
  const original = buildSmartContext(workspace, docs, 4000, '肿瘤中基因敲除有什么变化');assert.equal(original.needsQueryRewrite, true);
  const expanded = buildSmartContext(workspace, docs, 4000, '肿瘤中基因敲除有什么变化', undefined, 'zh-CN', 'tumor gene knockout Znf608');
  assert.ok(expanded.report.documents[0].includedPages.includes(17));assert.equal(expanded.needsQueryRewrite, false);
});

test('no-match retrieval labels its opening and ending overview without claiming all pages were read', () => {
  const docs = [source('Main', Array.from({ length: 30 }, (_, index) => (index === 29 ? 'Closing remarks. ' : 'Opening discussion. ') + filler))];
  const context = buildSmartContext(workspace, docs, 5000, 'quuxquasar');
  assert.equal(context.strategy, 'overview');assert.equal(context.report.complete, false);
  assert.match(context.warnings.join(' '), /未找到与问题明确匹配/);
  assert.ok(context.report.documents[0].includedPages.includes(1));assert.ok(context.report.documents[0].includedPages.includes(30));
  assert.match(context.content, /Closing remarks/);
});

test('selected passages take priority, include their page label and obey the complete character budget', () => {
  const docs = [source('Main', Array.from({ length: 40 }, () => filler))];
  const selection = { documentId: 'Main', documentName: 'Main.pdf', page: 35, text: 'Selected zephyrase evidence. '.repeat(800), rects: [] };
  for (const limit of [1000, 2000, 8500]) {
    const context = buildSmartContext(workspace, docs, limit, 'zephyrase', selection);
    assert.ok(context.content.length <= limit, `${context.content.length} exceeds ${limit}`);
    assert.match(context.content, /<selection>\n\[Main.pdf p\.35\]/);assert.match(context.content, /Selected zephyrase/);
    assert.match(context.warnings.join(' '), /选中文字超过/);
    assert.ok(context.report.documents[0].includedPages.includes(35));
  }
});

test('an index-free selection reports its provided page without inventing a total page count or full coverage', () => {
  const doc = source('Main', []), selection = { documentId: 'Main', documentName: 'Main.pdf', page: 60, text: 'Explicitly selected evidence.', rects: [] };
  const result = buildSmartContext(workspace, [doc], 2000, 'Explain this selection', selection);
  assert.equal(result.hasText, true);assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.documents[0].includedPages, [60]);assert.equal(result.report.documents[0].totalPages, 0);
  assert.equal(result.report.documents[0].readablePages, 1);assert.match(result.warnings.join(' '), /总页数尚未就绪/);
});

test('a selected passage in an unindexed page is not also reported as unavailable', () => {
  const doc = { ...source('Main', []), pageCount: 12 };
  const selection = { documentId: 'Main', documentName: 'Main.pdf', page: 6, text: 'Explicitly selected evidence.', rects: [] };
  const result = buildSmartContext(workspace, [doc], 2000, 'Explain this selection', selection);
  const coverage = result.report.documents[0];
  assert.equal(result.report.complete, false);
  assert.equal(coverage.totalPages, 12); assert.equal(coverage.readablePages, 1);
  assert.deepEqual(coverage.includedPages, [6]);
  assert.equal(coverage.unavailablePages.includes(6), false);
  assert.equal(coverage.unavailablePages.length, 11);
  assert.match(result.warnings.join(' '), /不能视为已读完整页面/);
});

test('mentioning both main and supplement permits direct figure matches from both scopes', () => {
  const main = source('Article', Array.from({ length: 40 }, () => filler));
  const extra = source('Supporting', Array.from({ length: 40 }, () => filler), 'supplement');
  main.pages[25] = 'Figure 7. Main amber result. ' + filler;extra.pages[30] = 'Fig. 7. Supplementary indigo result. ' + filler;
  const result = buildSmartContext(workspace, [main, extra], 6000, '比较正文和补充的图7');
  assert.ok(result.report.documents[0].includedPages.includes(26));assert.ok(result.report.documents[1].includedPages.includes(31));
  assert.match(result.content, /amber result/);assert.match(result.content, /indigo result/);
});

test('deep reading covers every character of every readable page including a long page and the last supplement', () => {
  const huge = ('段落开始 CD4+ fl/fl 中文和 English together. 🧬\n\n').repeat(230) + 'Last unique tail 🧬';
  const docs = [source('Main', ['Opening paragraph.\n\n', huge, '', 'Last main page with a vital finding.']),
    { ...source('Supplement', ['Supporting observation.\n' + filler, 'Supplement final page.  '], 'supplement'), pageCount: 3 }];
  const plan = planDeepReading(docs, 1000);
  assert.ok(plan.batches.length > 3);assert.equal(plan.report.complete, true);assert.equal(plan.report.batches, plan.batches.length);
  for (const batch of plan.batches) {
    assert.ok(batch.content.length <= 1000);assert.ok(batch.sources.length);
    for (const item of batch.sources) assert.match(batch.content, new RegExp(`\\[${item.name.replace('.', '\\.')} p\\.${item.page}\\]`));
  }
  for (const doc of docs) for (const [index, page] of doc.pages.entries()) {
    const segments = plan.batches.flatMap(batch => batch.sources).filter(item => item.documentId === doc.id && item.page === index + 1);
    if (!page.trim()) { assert.equal(segments.length, 0);continue; }
    assert.equal(segments[0].start, 0);assert.equal(segments.at(-1)!.end, page.length);
    for (let i = 1; i < segments.length; i++) assert.equal(segments[i].start, segments[i - 1].end, 'No character omitted or repeated at a batch boundary');
    assert.equal(segments.map(part => page.slice(part.start, part.end)).join(''), page);
  }
  assert.deepEqual(plan.report.documents[0].includedPages, [1, 2, 4]);assert.deepEqual(plan.report.documents[0].unavailablePages, [3]);
  assert.deepEqual(plan.report.documents[1].unavailablePages, [3]);
  assert.match(plan.batches.map(batch => batch.content).join('\n'), /Last unique tail 🧬/);
});

test('deep batch IDs are stable, content-sensitive and separate documents even if the text is identical', () => {
  const docs = [source('Main', [filler, filler]), source('Supplement', [filler], 'supplement')];
  const first = planDeepReading(docs, 2500), second = planDeepReading(structuredClone(docs), 2500);
  assert.deepEqual(first, second);assert.equal(new Set(first.batches.map(batch => batch.id)).size, first.batches.length);
  const changed = structuredClone(docs);changed[0].pages[0] = 'Changed evidence. ' + filler;
  assert.notEqual(planDeepReading(changed, 2500).batches[0].id, first.batches[0].id);
});

test('deep reading handles sanitization expansion, section boundaries and empty documents within budget', () => {
  const docs = [{ ...source('Main', [('<a>\n').repeat(500), 'Second section.\n' + filler]), outline: [{ id: 'section', title: 'Second section', page: 2, children: [] }] }];
  const plan = planDeepReading(docs, 1000);
  assert.ok(plan.batches.every(batch => batch.content.length <= 1000));
  assert.equal(plan.batches.flatMap(batch => batch.sources).filter(part => part.page === 1).at(-1)!.end, docs[0].pages[0].length);
  const empty = planDeepReading([{ ...source('Scanned', ['', ' ']), pageCount: 3 }], 1000);
  assert.equal(empty.hasText, false);assert.equal(empty.report.complete, false);assert.equal(empty.batches.length, 0);
  assert.deepEqual(empty.report.documents[0].unavailablePages, [1, 2, 3]);
  for (const limit of [0, 999, NaN, Infinity]) {
    assert.throws(() => planDeepReading(docs, limit), /at least/);
    assert.throws(() => buildSmartContext(workspace, docs, limit, 'question'), /at least/);
  }
});

test('retrieval performance remains bounded on a long paper with supplements', t => {
  const docs = [source('Main', Array.from({ length: 600 }, () => filler)), source('Supplement', Array.from({ length: 300 }, () => filler), 'supplement')];
  docs[1].pages[289] = 'The rare zephyrase marker was found only in this late supplement.\n' + filler;
  const start = performance.now(), result = buildSmartContext(workspace, docs, 24000, 'rare zephyrase marker'), elapsed = performance.now() - start;
  assert.ok(result.report.documents[1].includedPages.includes(290));assert.ok(result.content.length <= 24000);
  t.diagnostic(`Indexed and ranked 900 extracted pages in ${elapsed.toFixed(1)} ms without network or background polling.`);
  assert.ok(elapsed < 10000, 'Guard against accidental quadratic retrieval work');
});

test('the bounded text index reuses tokenization and invalidates changed content, filenames and workspaces', () => {
  clearReadingCache();
  const original = source('Main', Array.from({ length: 30 }, () => filler));original.pages[20] += ' amberzyme';
  buildSmartContext(workspace, [original], 2500, 'amberzyme');
  const cold = getReadingCacheStats();assert.equal(cold.misses, 1);assert.equal(cold.documents, 1);
  buildSmartContext(workspace, [structuredClone(original)], 2500, 'amberzyme');assert.equal(getReadingCacheStats().hits, 1);
  const changed = structuredClone(original);changed.pages[20] = filler;changed.pages[25] += ' violetzyme';
  const result = buildSmartContext(workspace, [changed], 2500, 'violetzyme');
  assert.equal(getReadingCacheStats().misses, 2);assert.ok(result.report.documents[0].includedPages.includes(26));assert.doesNotMatch(result.content, /amberzyme/);
  buildSmartContext(workspace, [{ ...changed, name: 'Renamed.pdf' }], 2500, 'violetzyme');assert.equal(getReadingCacheStats().misses, 3);
  for (let i = 0; i < 5; i++) buildSmartContext({ ...workspace, id: `workspace-${i}` }, [original], 2500, 'amberzyme');
  assert.ok(getReadingCacheStats().workspaces <= 3);assert.ok(getReadingCacheStats().estimatedBytes <= 10 * 1024 * 1024);
  const before = getReadingCacheStats().estimatedBytes;clearReadingCache('workspace-4');assert.ok(getReadingCacheStats().estimatedBytes < before);
  clearReadingCache();assert.equal(getReadingCacheStats().estimatedBytes, 0);assert.equal(getReadingCacheStats().documents, 0);
});
