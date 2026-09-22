import assert from 'node:assert/strict';
import test from 'node:test';
import { pronounceAcademicText } from '../src/hooks/speechPronunciation';
import { buildSpeechPlan, type SpeechPreferences } from '../src/hooks/speechPlan';
const prefs: SpeechPreferences = { locale: 'zh-CN', readingMode: 'auto', chineseVoiceId: '', englishVoiceId: '' };

test('surface marker families retain subtypes, positivity and compact neighboring markers', () => {
  const cases = [
    ['CD4+', 'CD 4 positive'], ['CD4+CD8-', 'CD 4 positive CD 8 negative'],
    ['CD11b⁺', 'CD 11 b positive'], ['CD45RA+', 'CD 45 RA positive'], ['CD45RO-', 'CD 45 RO negative'],
    ['CD44hi', 'CD 44 high'], ['CD62Llo', 'CD 62 L low'], ['CD25dim', 'CD 25 dim'],
    ['PD-L1+', 'PD L 1 positive'], ['CTLA-4', 'CTLA 4'], ['LAG-3+', 'LAG 3 positive'],
    ['CD69+PD-1+', 'CD 69 positive PD 1 positive'], ['CD4+/CD8-', 'CD 4 positive/CD 8 negative'], ['CD44hi/CD62Llo', 'CD 44 high/CD 62 L low'],
    ['CD4^{+}', 'CD 4 positive'], ['CD8^-', 'CD 8 negative'],
  ];
  for (const [original, spoken] of cases) assert.equal(pronounceAcademicText(original), spoken, original);
});

test('floxed alleles and slash genotypes are read literally, without inferring knockout or wild type', () => {
  const cases = [['fl/fl', 'flox flox'], ['fl/+', 'flox plus'], ['fl/-', 'flox minus'],
    ['+/+', 'plus slash plus'], ['+/-', 'plus slash minus'], ['-/-', 'minus slash minus'],
    ['CD4-/-', 'CD 4 minus slash minus'], ['Cre+/-', 'Cre plus slash minus']];
  for (const [original, spoken] of cases) assert.equal(pronounceAcademicText(original), spoken, original);
});

test('cytokines preserve Latin subtype letters, Greek subunits and receptor designations', () => {
  for (const [original, spoken] of [
    ['IL-6','interleukin 6'], ['IL-17A','interleukin 17 A'], ['IL-2Rα','interleukin 2 R alpha'],
    ['TNF-α','TNF alpha'], ['TGF-β1','TGF beta 1'], ['IFN-γ','IFN gamma'], ['NF-κB','NF kappa B'],
  ]) assert.equal(pronounceAcademicText(original), spoken, original);
});

test('assay aliases and numeric units are read as phrases while unknown gene symbols and mathematics remain intact', () => {
  for (const [original, spoken] of [
    ['scRNA-seq','single cell RNA sequencing'], ['RNA-seq','RNA sequencing'], ['qPCR','quantitative PCR'],
    ['RT-qPCR','reverse transcription quantitative PCR'], ['ATAC-seq','ATAC sequencing'], ['ChIP-seq','ChIP sequencing'],
    ['CreERT2','Cre E R T 2'], ['loxP','lox P'], ['10 μg','10 micrograms'],
  ]) assert.equal(pronounceAcademicText(original), spoken, original);
  const untouched = 'NFKB1 NFKBIA Il6 STAT3 Stat3fl/fl C++ Ca2+ x+1 -2 CD4++ CD4-5 high low fl/file';
  assert.equal(pronounceAcademicText(untouched), untouched);
});

test('one English pronunciation unit contains the complete marker and genotype aliases', () => {
  const original = '这些 CD4+ T cells 来自 fl/fl 小鼠，表达 IL-17A 和 TNF-α。';
  const plan = buildSpeechPlan(original, prefs);
  const english = plan.segments.filter(s => s.locale === 'en-US').map(s => s.text.trim());
  assert.deepEqual(english, ['CD 4 positive T cells', 'flox flox', 'interleukin 17 A', 'TNF alpha。']);
  assert.equal(original, '这些 CD4+ T cells 来自 fl/fl 小鼠，表达 IL-17A 和 TNF-α。');
  assert(plan.segments.every(s => s.pauseAfter === 0));
});
