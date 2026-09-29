import assert from 'node:assert/strict';
import test from 'node:test';
import { speechCitations } from '../src/hooks/speechCitations';
import { buildSpeechPlan } from '../src/hooks/speechPlan';
const sources = [
  { name: 's43587-026-01209-9.pdf', role: 'main' },
  { name: 'Supplementary Information', fileName: 'supp.pdf', role: 'supplement' },
];

test('bracketed PDF citations are silent without losing the supporting statement or original text', () => {
  const original = '这些细胞有贡献 [s43587-026-01209-9.pdf p.7]。补充材料也支持 [supp.pdf p.2]。';
  assert.equal(speechCitations(original, sources), '这些细胞有贡献。补充材料也支持。');
  assert(original.includes('s43587-026-01209-9.pdf p.7'));
  assert.equal(speechCitations('结果 [CD4+] 并非 [CD8-]。', sources), '结果 [CD4+] 并非 [CD8-]。');
});

test('source excerpt anchors are silent in speech, including long excerpts and Unicode filenames', () => {
  const response = '主要结论 [s43587-026-01209-9.pdf p.7 | CD4+ T cells were enriched in the tissue.]。补充结果 [Supplementary Information p.2 | No cells were detected.]。';
  assert.equal(speechCitations(response, sources), '主要结论。补充结果。');
  assert.equal(speechCitations(response.replaceAll(' | ', ' ｜ '), sources), '主要结论。补充结果。');
  assert.equal(speechCitations(response.replaceAll(' | ', ' \\| '), sources), '主要结论。补充结果。');
  assert.equal(speechCitations('结果 [中文论文.pdf p.2 | 这是原文中的连续选段。]。', []), '结果。');
  assert.equal(speechCitations(`结果 [s43587-026-01209-9.pdf p.7 | ${'evidence '.repeat(70)}]。`, sources), '结果。');
  const plan = buildSpeechPlan(response, { locale: 'zh-CN', readingMode: 'auto', chineseVoiceId: '', englishVoiceId: '' }, sources);
  assert.equal(plan.text, '主要结论。补充结果。');
  assert(!plan.segments.some(segment => /pdf|enriched|43587/.test(segment.text)));
  assert.equal(buildSpeechPlan(response.replaceAll(' | ', ' ｜ '), { locale: 'zh-CN', readingMode: 'auto', chineseVoiceId: '', englishVoiceId: '' }, sources).text, plan.text);
});

test('inline filenames, braille separators, ranges and known supplement names become short grounded locations', () => {
  assert.equal(speechCitations('贡献 s43587-026-01209-9.pdf⠈p.7。', sources), '贡献 正文第7页。');
  assert.equal(speechCitations('参见 Supplementary Information p.2–3。', sources), '参见 补充材料第2至3页。');
  assert.equal(speechCitations('See supp.pdf p.2.', sources, 'en-US'), 'See supplement page 2.');
  assert.equal(speechCitations('见 unknown.pdf p.9。', sources), '见 文献第9页。');
});

test('citation links are silent but ordinary link labels and non-citation brackets remain readable', () => {
  assert.equal(speechCitations('结果[原文](folio-cite://paper-1/7)，见[解释](https://example.org)。[95% CI]。', sources), '结果，见[解释](https://example.org)。[95% CI]。');
  const plan = buildSpeechPlan('证据 [s43587-026-01209-9.pdf p.7]。', { locale: 'zh-CN', readingMode: 'auto', chineseVoiceId: '', englishVoiceId: '' }, sources);
  assert.equal(plan.text, '证据。');
  assert(!plan.segments.some(s => /pdf|43587/.test(s.text)));
});


test('URL and DOI removal never consumes following Chinese prose or ordinary Markdown labels', () => {
  const preferences = { locale: 'zh-CN', readingMode: 'auto', chineseVoiceId: '', englishVoiceId: '' } as const;
  assert.equal(buildSpeechPlan('见 https://example.org。随后分析对照组。', preferences).text, '见 。随后分析对照组。');
  assert.equal(buildSpeechPlan('请看[方法说明](https://example.org)之后继续解释。', preferences).text, '请看方法说明之后继续解释。');
  assert.equal(buildSpeechPlan('doi:10.1234/test。结论仍有局限。', preferences).text, '。结论仍有局限。');
  assert.equal(speechCitations('domain p. 4; main p. 12abc; main p. 4.5', [{ name: 'main', role: 'main' }]), 'domain p. 4; main p. 12abc; main p. 4.5');
});
