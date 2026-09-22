import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpeechPlan, type SpeechPreferences } from '../src/hooks/speechPlan';

const prefs: SpeechPreferences = { locale: 'zh-CN', readingMode: 'auto', chineseVoiceId: 'com.apple.zh', englishVoiceId: 'com.apple.en' };

test('English words and phrases inside Chinese use English pronunciation without letter splitting', () => {
  const text = '这些 T cells 表达 IL-6，变化为 2.5 倍。 T cells showed a stronger response. 因此结果支持这一假设。';
  const plan = buildSpeechPlan(text, prefs);
  assert.deepEqual(plan.segments.filter(s => s.locale === 'en-US').map(s => s.text.trim()), ['T cells', 'interleukin 6', 'T cells showed a stronger response.']);
  assert(plan.segments.filter(s => s.locale === 'en-US').every(s => s.voiceId === 'com.apple.en'));
  assert.equal(plan.text, text.replace('IL-6', 'interleukin 6'));
  assert.equal(plan.segments.find(s => s.text === 'interleukin 6')?.locale, 'en-US');
  assert.equal(plan.segments[0].pauseAfter, 0, 'No inserted pause merely for switching voices');
});

test('pronunciation is separate from history, with figure references expanded and gene names/units unchanged', () => {
  const original = '**见 Fig. 2：**IL-6 和 CD8+ T cells 的比例为 2.5%，剂量是 3 mg。';
  const plan = buildSpeechPlan(original, prefs);
  assert.equal(plan.segments.find(s => s.text === 'CD 8 positive T cells')?.locale, 'en-US');
  assert.equal(plan.text, '见 图 2：interleukin 6 和 CD 8 positive T cells 的比例为 2.5%，剂量是 3 mg。');
  assert.equal(original, '**见 Fig. 2：**IL-6 和 CD8+ T cells 的比例为 2.5%，剂量是 3 mg。');
});

test('English abbreviations, quoted endings, decimals and sentence boundaries preserve the full text', () => {
  const text = '中文说明。 "Dr. Smith et al. reported 2.5 fold changes in Fig. 2." 这需要验证。';
  const plan = buildSpeechPlan(text, prefs);
  assert.deepEqual(plan.segments.map(s => s.locale), ['zh-CN', 'en-US', 'zh-CN']);
  assert.equal(plan.text, text.replace('Fig. 2', 'Figure 2'));
});

test('fixed playback language ignores recognition language and never swaps voices', () => {
  for (const mode of ['zh-CN', 'en-US'] as const) {
    const plan = buildSpeechPlan('中文句子。 An English sentence.', { ...prefs, locale: 'en-US', readingMode: mode });
    assert(plan.segments.every(s => s.locale === mode));
    assert.equal(plan.segments.length, 1);
    assert.equal(plan.segments[0].voiceId, mode === 'zh-CN' ? prefs.chineseVoiceId : prefs.englishVoiceId);
  }
});

test('same-language sentences stay together, paragraph pauses remain bounded and numeric fragments retain context', () => {
  const plan = buildSpeechPlan('第一句。第二句。\n\n下一段。\n3.14。\n最后一句。', prefs);
  assert.equal(plan.segments.length, 2);
  assert.equal(plan.segments[0].pauseAfter, 0.12);
  assert.equal(plan.segments[1].pauseAfter, 0);
  assert(plan.segments.every(s => s.locale === 'zh-CN'));
});

test('large alternating input stays bounded without dropping text; no work for an empty speech copy', () => {
  const text = '中文。 English sentence. '.repeat(300).trim();
  const plan = buildSpeechPlan(text, prefs);
  assert(plan.segments.length <= 256);
  assert.equal(plan.text, text);
  assert.deepEqual(buildSpeechPlan('```js\ncode()\n```', prefs).segments, []);
});


test('macrophage, checkpoint and RNA sequencing remain whole English words/phrases; acronyms and molecular IDs keep their spelling', () => {
  const text = '激活 macrophage 后，immune checkpoint 和 RNA sequencing 的结果提示 DNA、PCR、IL-6、CD8+ T cells 与 NF-κB 有变化。';
  const plan = buildSpeechPlan(text, prefs);
  assert.equal(plan.text, text.replace('CD8+', 'CD 8 positive').replace('IL-6', 'interleukin 6').replace('NF-κB', 'NF kappa B'));
  assert.deepEqual(plan.segments.filter(s => s.locale === 'en-US').map(s => s.text.replace(/[、，。]$/g, '').trim()),
    ['macrophage', 'immune checkpoint', 'RNA sequencing', 'DNA、PCR、interleukin 6、CD 8 positive T cells', 'NF kappa B']);
  assert(plan.segments.every(s => s.pauseAfter === 0));
});


test('CD4+ and fl/fl use explicit, continuous pronunciation aliases without changing genotype meaning or the answer', () => {
  const original = '比较 CD4+ T cells 和 fl/fl小鼠。CD8⁻ 细胞也有变化。';
  const plan = buildSpeechPlan(original, prefs);
  const english = plan.segments.filter(s => s.locale === 'en-US').map(s => s.text.trim());
  assert.deepEqual(english, ['CD 4 positive T cells', 'flox flox', 'CD 8 negative']);
  assert.equal(original, '比较 CD4+ T cells 和 fl/fl小鼠。CD8⁻ 细胞也有变化。');
  assert.equal(plan.text, '比较 CD 4 positive T cells 和 flox flox小鼠。CD 8 negative 细胞也有变化。');
  assert(plan.segments.every(s => s.pauseAfter === 0));
  assert.equal(buildSpeechPlan('fl/+、fl/-、CD4-5、/fl/fl/、Gfl/fl', prefs).text, 'flox plus、flox minus、CD4-5、/fl/fl/、Gfl/fl');
});
