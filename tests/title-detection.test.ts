import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credibleMetadataTitle, detectPaperTitle, titleFromFilename, MAX_PAPER_TITLE_LENGTH, type PaperTitleInput, type TitleTextItem } from '../src/pdf/titleDetection';

const line = (str: string, y: number, fontSize = 22, x = 48): TitleTextItem => ({ str, y, x, fontSize, width: str.length * fontSize * 0.46 });
const detect = (items: TitleTextItem[], extra: Partial<PaperTitleInput> = {}) => detectPaperTitle({ filename: 's43587-026-01209-9.pdf', items, pageWidth: 620, pageHeight: 820, ...extra });
const body = [line('Abstract', 310, 11), line('The cells were analyzed using a range of methods.', 335, 10), line('Our results demonstrate a change in the immune response.', 350, 10)];

test('credible metadata is preferred and normalized without truncating a scientific title', () => {
  assert.deepEqual(detect([line('A different first page title', 120)], { metadataTitle: '  CD4+ T cells\n support immune memory  ' }), { title: 'CD4+ T cells support immune memory', source: 'metadata' });
  assert.equal(credibleMetadataTitle('Cellular senescence'), 'Cellular senescence');
  assert.equal(credibleMetadataTitle('细胞衰老的分子机制'), '细胞衰老的分子机制');
});

test('producer labels, filenames, article IDs, DOI links, and placeholder metadata are rejected', () => {
  for (const title of ['Microsoft Word - final manuscript', 'Untitled 12', 'Document 1', 's43587-026-01209-9', 'paper_final.pdf', '10.1038/s43587-026-01209-9', 'https://example.org/real title', 'Supplementary Information', 'Research Article', 'Graphical Abstract', 'Nature Immunology', '']) {
    assert.equal(credibleMetadataTitle(title), undefined, title);
  }
  assert.equal(credibleMetadataTitle({ Title: 'Not a string title' }), undefined);
});

test('reconstructs a multiline headline while excluding larger publisher and article labels', () => {
  const title = detect([
    line('Nature', 20, 40), line('RESEARCH ARTICLE', 74, 26),
    line('Cell surface proteins coordinate', 125), line('immune responses during aging', 153),
    line('Jane Smith, Alice Brown, Bo Wang', 197, 12), ...body,
  ], { metadataTitle: 'Microsoft Word - document1' });
  assert.deepEqual(title, { title: 'Cell surface proteins coordinate immune responses during aging', source: 'first-page' });
});

test('joins separate PDF text fragments in visual order and retains punctuation', () => {
  const title = detect([
    { ...line('regulate memory', 120), x: 229, width: 167 },
    { ...line('T cells', 120), x: 123, width: 83 },
    { ...line('CD4+', 120), x: 48, width: 61 },
    ...body,
  ]);
  assert.deepEqual(title, { title: 'CD4+ T cells regulate memory', source: 'first-page' });
});

test('centered multiline titles are joined even when their left edges differ', () => {
  const first = { ...line('Immune responses during aging', 110), x: 100, width: 400 };
  const second = { ...line('in human tissues', 138), x: 170, width: 260 };
  assert.equal(detect([first, second, ...body]).title, 'Immune responses during aging in human tissues');
});

test('author lists and affiliations do not become part of the headline even at the same font size', () => {
  const result = detect([line('The molecular basis of immune memory', 110), line('Jane Smith, Alice Brown', 138), line('Department of Biology, University of Example', 166), ...body]);
  assert.equal(result.title, 'The molecular basis of immune memory');
});

test('multiline Chinese headlines join without inserted word spaces', () => {
  assert.deepEqual(detect([line('细胞表面蛋白调控', 110), line('衰老过程中的免疫反应', 138), ...body]), { title: '细胞表面蛋白调控衰老过程中的免疫反应', source: 'first-page' });
});

test('visible scientific compound hyphens survive a line wrap', () => {
  assert.equal(detect([line('The mechanisms of cell-', 110), line('surface protein transport', 138), ...body]).title, 'The mechanisms of cell-surface protein transport');
});

test('large section headings below the title do not win title detection', () => {
  const result = detect([line('Molecular mechanisms of immune memory', 100), ...body, line('Introduction', 400, 36), line('References', 550, 42)]);
  assert.equal(result.title, 'Molecular mechanisms of immune memory');
});

test('scanned pages, missing text, malformed coordinates, and generic metadata fall back to the filename', () => {
  assert.deepEqual(detect([], { filename: 'my_paper.pdf', metadataTitle: 'Untitled' }), { title: 'my paper', source: 'filename' });
  assert.equal(detect([{ ...line('Incorrect coordinates must be ignored', 100), x: NaN }]).source, 'filename');
  assert.equal(detect([line('A plausible paper title', 100)], { pageWidth: 0 }).source, 'filename');
  assert.equal(detect([line('A plausible paper title', 100)], { pageHeight: Infinity }).source, 'filename');
});

test('the filename fallback handles macOS and Windows paths and bounds its length', () => {
  assert.equal(titleFromFilename('/Users/example/My_paper.PDF'), 'My paper');
  assert.equal(titleFromFilename('C:\\Papers\\my_paper.pdf'), 'my paper');
  assert.equal(titleFromFilename(`${'A'.repeat(800)}.pdf`).length, MAX_PAPER_TITLE_LENGTH);
  assert.equal(credibleMetadataTitle(`This title is ${'too long '.repeat(90)}`), undefined);
});

test('ordinary body paragraphs without a headline do not get promoted to the title', () => {
  assert.equal(detect([line('Many investigations have studied these immune cells.', 330, 10), line('The mechanisms remain incompletely understood in aging.', 346, 10)]).source, 'filename');
});
