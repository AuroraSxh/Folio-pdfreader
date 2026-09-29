import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSourceQuote } from '../src/pdf/sourceHighlight';

test('source matching returns original offsets across PDF whitespace and ligatures', () => {
  const source = 'Header. The efﬁcient  cell\nsurface protein was observed. Footer.';
  const match = matchSourceQuote(source, 'The efficient cell surface protein was observed.');
  assert.equal(match.status, 'matched');
  if (match.status === 'matched') assert.equal(source.slice(match.start, match.end), 'The efﬁcient  cell\nsurface protein was observed.');
});

test('line-end hyphenation and soft hyphens match while actual minus signs remain significant', () => {
  const source = 'We found sur- \n face-associated macro\u00adphages and CD4-negative cells.';
  assert.equal(matchSourceQuote(source, 'surface-associated macrophages and CD4-negative cells').status, 'matched');
  assert.equal(matchSourceQuote('The macro\u00ad\nphages migrated toward the signal.', 'The macrophages migrated toward the signal.').status, 'matched');
  assert.equal(matchSourceQuote(source, 'surface associated macrophages and CD4-positive cells').status, 'missing');
  assert.equal(matchSourceQuote('The result was CD4-negative in every sample.', 'CD4negative in every sample').status, 'missing');
});

test('ambiguous, abbreviated, translated, and missing quotes never guess a span', () => {
  const source = 'The cells were activated. Control. The cells were activated.';
  assert.equal(matchSourceQuote(source, 'The cells were activated.').status, 'ambiguous');
  assert.equal(matchSourceQuote(source, 'cells').status, 'too-short');
  assert.equal(matchSourceQuote(source, '研究中的细胞被进一步激活了。').status, 'missing');
  assert.equal(matchSourceQuote(source, 'The cells were inhibited.').status, 'missing');
});

test('word boundaries reject snippets inside longer words without imposing Latin rules on CJK', () => {
  assert.equal(matchSourceQuote('Inactive macrophages appeared.', 'active macrophages').status, 'missing');
  assert.equal(matchSourceQuote('Cells activate macrophages.', 'activate macrophage').status, 'missing');
  assert.equal(matchSourceQuote('研究显示这些细胞表面存在蛋白结合结构并参与转运。', '细胞表面存在蛋白结合结构').status, 'matched');
  assert.equal(matchSourceQuote('研究显示这些细胞表面\n存在蛋白结合结构并参与转运。', '细胞表面存在蛋白结合结构').status, 'matched');
});

test('typographic punctuation, casing, and full-width glyphs normalize with exact source boundaries', () => {
  const source = 'Prefix “Ｔ cells” and ‘B cells’ respond to stimulation. Suffix';
  const quote = '"T cells" and \'B cells\' respond to stimulation.';
  const match = matchSourceQuote(source, quote);
  assert.equal(match.status, 'matched');
  if (match.status === 'matched') assert.equal(source.slice(match.start, match.end), '“Ｔ cells” and ‘B cells’ respond to stimulation.');
});

test('normalization preserves UTF-16 offsets before and within a quote', () => {
  const source = '🧬 prefix. The 𐐀 cells show efficient growth. suffix';
  const match = matchSourceQuote(source, 'The 𐐨 cells show efficient growth.');
  assert.equal(match.status, 'matched');
  if (match.status === 'matched') assert.equal(source.slice(match.start, match.end), 'The 𐐀 cells show efficient growth.');
});
