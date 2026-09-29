import assert from 'node:assert/strict';
import test from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { citationURL, createCitationResolver, parseCitationLabel, readableCitations } from '../shared/citations';
import { remarkSourceCitations } from '../src/components/citation-markdown';
import { getSystemPrompt } from '../shared/prompts';

const documents = [
  { id: 'main-id', name: 'Main paper.pdf', fileName: 'stored-main.pdf', pageCount: 12 },
  { id: 'supp-id', name: '补充材料.pdf', fileName: 'supp.pdf', pageCount: 3 },
];
const resolver = createCitationResolver(documents);

test('citation anchors preserve exact source excerpts, legacy references and document aliases', () => {
  assert.deepEqual(resolver.fromLabel('Main paper.pdf p.7 | CD4+ T cells were enriched in the tissue.'), {
    documentId: 'main-id', name: 'Main paper.pdf', page: 7, quote: 'CD4+ T cells were enriched in the tissue.',
  });
  assert.deepEqual(resolver.fromLabel('supp.pdf 第 2 页 | 补充材料支持这一结论。'), {
    documentId: 'supp-id', name: '补充材料.pdf', page: 2, quote: '补充材料支持这一结论。',
  });
  assert.deepEqual(resolver.fromLabel('stored-main.pdf p.1'), { documentId: 'main-id', name: 'Main paper.pdf', page: 1 });
  assert.equal(resolver.fromLabel('Main paper.pdf p.1 | ' + 'a'.repeat(401))?.quote, undefined);
  assert.deepEqual(resolver.fromLabel('Main paper.pdf p.7 ｜ CD4+ T cells were enriched in the tissue.'), resolver.fromLabel('Main paper.pdf p.7 | CD4+ T cells were enriched in the tissue.'));
  assert.deepEqual(resolver.fromLabel('Main paper.pdf p.7 \\| CD4+ T cells were enriched in the tissue.'), resolver.fromLabel('Main paper.pdf p.7 | CD4+ T cells were enriched in the tissue.'));
});

test('unresolvable, ambiguous and invalid citations cannot select an arbitrary PDF or page', () => {
  for (const label of ['Elsewhere.pdf p.1', 'Main paper.pdf p.0', 'Main paper.pdf p.-1', 'Main paper.pdf p.1.5', 'Main paper.pdf p.13', 'supp.pdf p.4', 'Main paper.pdf p.999999', 'Main paper.pdf p.1 | line\nline']) assert.equal(resolver.fromLabel(label), undefined, label);
  const ambiguous = createCitationResolver([...documents, { id: 'other-id', name: 'Main paper.pdf', fileName: 'different.pdf', pageCount: 100 }]);
  assert.equal(ambiguous.fromLabel('Main paper.pdf p.1'), undefined);
  assert.equal(ambiguous.fromLabel('stored-main.pdf p.1')?.documentId, 'main-id');
  assert.equal(parseCitationLabel('CD4+'), undefined);
});

test('local citation URLs round-trip evidence without allowing foreign IDs, page overflow or malformed URLs', () => {
  const citation = resolver.fromLabel('补充材料.pdf p.3 | A/B + C% were present.')!;
  assert.deepEqual(resolver.fromURL(citationURL(citation)), citation);
  assert.equal(resolver.fromURL('folio-cite://main-id/13'), undefined);
  assert.equal(resolver.fromURL('folio-cite://unknown/1'), undefined);
  assert.equal(resolver.fromURL('folio-cite://main-id/1?quote=%ZZ'), undefined);
  assert.equal(resolver.fromURL('https://example.org/main-id/1'), undefined);
  assert.equal(resolver.fromURL('folio-cite://main-id/1#extra'), undefined);
});

test('Markdown conversion keeps code, external links, ordinary brackets and unverified names untouched', async () => {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkSourceCitations, resolver);
  const markdown = 'Claim [Main paper.pdf p.7 | CD4+ T cells were enriched.]\n\n' +
    '- Supplement [supp.pdf p.2]\n\n' +
    '`[Main paper.pdf p.1]`\n\n```txt\n[Main paper.pdf p.2 | literal code]\n```\n\n' +
    '[Main paper.pdf p.3](https://example.org) and [CD4+] and [Unknown.pdf p.1].';
  const tree = await processor.run(processor.parse(markdown)) as Root;
  const nodes: any[] = [];
  const walk = (node: any) => { nodes.push(node); for (const child of node.children ?? []) walk(child); }; walk(tree);
  const local = nodes.filter(node => node.type === 'link' && node.url.startsWith('folio-cite://'));
  assert.equal(local.length, 2);
  assert.equal(resolver.fromURL(local[0].url)?.quote, 'CD4+ T cells were enriched.');
  assert.equal(local[0].children[0].value, 'Main paper.pdf p.7');
  assert.equal(nodes.find(node => node.type === 'inlineCode').value, '[Main paper.pdf p.1]');
  assert.equal(nodes.find(node => node.type === 'code').value, '[Main paper.pdf p.2 | literal code]');
  assert.equal(nodes.filter(node => node.type === 'link' && node.url === 'https://example.org').length, 1);
  assert(nodes.some(node => node.type === 'text' && node.value.includes('[Unknown.pdf p.1]')));
});

test('copy/export output stays concise while the persisted response retains original evidence', () => {
  const response = '结果 [Main paper.pdf p.7 | CD4+ T cells were enriched.]。对照 [supp.pdf p.2 | No cells were detected.]';
  assert.equal(readableCitations(response, documents), '结果 [Main paper.pdf p.7]。对照 [补充材料.pdf p.2]');
  assert(response.includes('CD4+ T cells were enriched.'));
  assert.equal(readableCitations('Uncertain [Unknown.pdf p.7 | example] and [95% CI]', documents), 'Uncertain [Unknown.pdf p.7 | example] and [95% CI]');
  assert.equal(readableCitations(response.replaceAll(' | ', ' ｜ '), documents), readableCitations(response, documents));
  assert.equal(readableCitations(response.replaceAll(' | ', ' \\| '), documents), readableCitations(response, documents));
});

test('canonical source anchors stay in one GFM table cell and retain their original evidence', async () => {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkSourceCitations, resolver);
  for (const delimiter of ['｜', '\\|']) {
    const markdown = '| Claim | Evidence |\n| --- | --- |\n' +
      `| Enriched | [Main paper.pdf p.7 ${delimiter} CD4+ T cells were enriched.] |\n` +
      `| Control | [supp.pdf p.2 ${delimiter} No cells were detected.] |`;
    const tree = await processor.run(processor.parse(markdown)) as Root;
    const table = tree.children[0]; assert.equal(table.type, 'table'); if (table.type !== 'table') throw new Error('Expected table');
    assert.equal(table.children.length, 3);
    assert(table.children.every(row => row.children.length === 2), `Citation separator ${delimiter} must not create another cell`);
    const mainLink = table.children[1].children[1].children[0]; assert.equal(mainLink.type, 'link'); if (mainLink.type !== 'link') throw new Error('Expected citation');
    assert.equal(resolver.fromURL(mainLink.url)?.quote, 'CD4+ T cells were enriched.');
    const supplementLink = table.children[2].children[1].children[0]; assert.equal(supplementLink.type, 'link'); if (supplementLink.type !== 'link') throw new Error('Expected citation');
    assert.equal(resolver.fromURL(supplementLink.url)?.documentId, 'supp-id');
    assert.equal(resolver.fromURL(supplementLink.url)?.quote, 'No cells were detected.');
  }
});

test('both prompt languages demand exact evidence and permit page-only citations when unavailable', () => {
  for (const kind of ['chat', 'selection', 'summary'] as const) {
    const zh = getSystemPrompt(kind, 'zh-CN'), en = getSystemPrompt(kind, 'en');
    assert.match(zh, /连续、逐字一致的原文/); assert.match(zh, /不得翻译、改写/); assert.match(zh, /只用原有标记 \[文件名 p.页码\]/);
    assert.match(en, /continuous, exact passage/); assert.match(en, /never translate, paraphrase/); assert.match(en, /use the original marker \[filename p.N\]/);
    assert.match(en, /400 characters/); assert.match(en, /Markdown formatting/);
    assert.match(zh, /\[文件名 p.页码 ｜ 原文短摘录\]/); assert.match(zh, /全角分隔符「｜」/);
    assert.match(en, /\[filename p.N ｜ short verbatim source excerpt\]/); assert.match(en, /fullwidth separator ｜/);
  }
});
