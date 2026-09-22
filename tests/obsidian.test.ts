import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { exportToObsidian, renderMarkdown } from '../electron/obsidian';
import type { Settings, Workspace } from '../shared/types';

function workspace(): Workspace {
  return { version: 1, id: 'stable-article-id', title: 'My: Paper / 学术笔记', authors: 'A. Author', journal: 'Journal', doi: '10.123/test', tags: ['immunity', '中文标签'], favorite: true, createdAt: Date.UTC(2020, 0, 2), updatedAt: Date.now(), lastReadAt: Date.UTC(2026, 8, 21),
    documents: [{ id: 'main', name: 'Main paper.pdf', fileName: 'main-file.pdf', role: 'main', size: 100, pageCount: 2, outline: [], outlineLoaded: true, annotations: [{ id: 'highlight', page: 2, text: 'Evidence from paper', comment: 'My annotation', color: '#ff0', rects: [], createdAt: 1 }], view: { page: 1, scale: 'page-width', rotation: 0, scrollMode: 0, spreadMode: 0 } }], notes: 'My workspace notes', memories: [{ id: 'memory', type: 'finding', title: 'A finding', body: 'Evidence [Main paper.pdf p.2]', source: 'ai', createdAt: 1, tags: ['immunity'] }], memoryIndex: '- [finding] A finding', summary: { content: 'Summary', provider: 'deepseek', model: 'deepseek-flash', createdAt: 1 }, conversations: [{ id: 'conv', title: 'Conversation', createdAt: 1, messages: [{ id: 'message', role: 'user', content: 'My question', createdAt: 1 }] }], activeConversationId: 'conv', layout: { split: false, leftId: 'main', rightId: '', ratio: .5 } };
}
function settings(vaultPath: string): Settings {
  return { language: 'zh-CN', autoCheckUpdates: true, vaultPath, obsidianSubfolder: 'Papers', libraryPath: '/Users/Test/Library/Folio', activeProvider: 'deepseek', providers: {} as Settings['providers'], autoSummary: false, autoMemory: false, contextMaxChars: 12000, theme: 'light', readingTheme: 'white', annotationToolbar: 'floating' };
}
async function temp(t: { after(fn: () => Promise<void>): void }) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'folio-obsidian-'))); t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test('Markdown contains metadata, absolute PDF links, summaries, typed memories, notes, annotations and conversations', () => {
  const ws = workspace(); const md = renderMarkdown(ws, undefined, '/Users/Test/Library/Folio');
  assert.match(md, /article_id: "stable-article-id"/); assert.match(md, /firstRead: "2020-01-02T00:00:00.000Z"/);
  assert.match(md, /file:\/\/\/Users\/Test\/Library\/Folio\/stable-article-id\/main-file.pdf/);
  for (const item of ['Summary', 'A finding', 'My workspace notes', 'My annotation', 'Evidence from paper', 'My question']) assert.ok(md.includes(item));
  assert.match(md, /<!-- folio:generated:start -->/);
});

test('Markdown distinguishes legacy highlights, underlines and strikeouts without losing quoted text or comments',()=>{
  const ws=workspace(),original=ws.documents[0].annotations[0];
  ws.documents[0].annotations.push({...original,id:'underline',kind:'underline',text:'Underlined evidence',comment:'下划线备注'},{...original,id:'strikeout',kind:'strikeout',text:'Rejected claim',comment:'删除线备注'});
  const markdown=renderMarkdown(ws);
  assert.match(markdown,/第 2 页 · 高亮\*\*：My annotation/);assert.match(markdown,/第 2 页 · 下划线\*\*：下划线备注/);assert.match(markdown,/第 2 页 · 删除线\*\*：删除线备注/);
  assert.match(markdown,/> Evidence from paper/);assert.match(markdown,/> Underlined evidence/);assert.match(markdown,/> Rejected claim/);
});

test('Obsidian re-export matches article id recursively after rename and preserves firstRead, custom fields, appended notes', async t => {
  const vault = await temp(t), config = settings(vault), ws = workspace();
  const first = await exportToObsidian(ws, config); assert.equal(first.overwritten, false);
  const nested = path.join(vault, 'Papers', 'Archive'); await mkdir(nested);
  const moved = path.join(nested, 'My renamed note.md'); await rename(first.path, moved);
  let existing = await readFile(moved, 'utf8');
  existing = existing.replace('firstRead: "2020-01-02T00:00:00.000Z"', 'firstRead: "2018-05-06T00:00:00.000Z"\nrating: 5\nmy_property:\n  - preserved');
  existing += '\n## Handwritten Obsidian notes\nNever overwrite this.\n'; await writeFile(moved, existing);
  ws.title = 'Changed title'; ws.notes = 'Updated notes'; ws.createdAt = Date.now();
  const second = await exportToObsidian(ws, config); assert.equal(second.path, moved); assert.equal(second.overwritten, true);
  const result = await readFile(moved, 'utf8');
  assert.match(result, /firstRead: "2018-05-06T00:00:00.000Z"/); assert.match(result, /rating: 5/); assert.match(result, /my_property:\n  - preserved/);
  assert.match(result, /Never overwrite this/); assert.match(result, /Updated notes/); assert.ok(!result.includes('My workspace notes'));
  assert.equal((result.match(/folio:generated:start/g) || []).length, 1);
  assert.deepEqual(await readdir(path.join(vault, 'Papers')), ['Archive']);
});

test('same-title collision and repeated concurrent exports do not overwrite unrelated files or duplicate article notes', async t => {
  const vault = await temp(t), config = settings(vault), ws = workspace();
  await mkdir(path.join(vault, 'Papers')); const unrelated = path.join(vault, 'Papers', 'My Paper 学术笔记.md'); await writeFile(unrelated, 'User existing note');
  const results = await Promise.all([exportToObsidian(ws, config), exportToObsidian(ws, config), exportToObsidian(ws, config)]);
  assert.equal(new Set(results.map(result => result.path)).size, 1); assert.equal(await readFile(unrelated, 'utf8'), 'User existing note');
  assert.equal((await readdir(path.join(vault, 'Papers'))).filter(name => name.endsWith('.md')).length, 2);
  assert.ok(!(await readdir(path.join(vault, 'Papers'))).some(name => name.endsWith('.tmp')));
});

test('legacy matching export without markers is preserved and YAML IDs support escaped quotes', async t => {
  const vault = await temp(t), config = settings(vault), ws = workspace(); ws.id = 'article"quoted';
  await mkdir(path.join(vault, 'Papers')); const note = path.join(vault, 'Papers', 'Legacy.md');
  await writeFile(note, `---\narticle_id: ${JSON.stringify(ws.id)}\nfirstRead: '2010-01-01T00:00:00.000Z'\n---\nLegacy handwritten text\n`);
  const result = await exportToObsidian(ws, config); assert.equal(result.path, note);
  let content = await readFile(note, 'utf8'); assert.match(content, /Legacy handwritten text/); assert.match(content, /2010-01-01/);
  await exportToObsidian(ws, config); content = await readFile(note, 'utf8');
  assert.equal((content.match(/Legacy handwritten text/g) || []).length, 1);
});

test('vault subfolder cannot traverse out or follow an outside symlink', async t => {
  const vault = await temp(t), outside = await temp(t), config = settings(vault);
  config.obsidianSubfolder = '../elsewhere'; await assert.rejects(() => exportToObsidian(workspace(), config), /相对路径/);
  await symlink(outside, path.join(vault, 'Shortcut')); config.obsidianSubfolder = 'Shortcut';
  await assert.rejects(() => exportToObsidian(workspace(), config), /Vault 外部/); assert.deepEqual(await readdir(outside), []);
});

test('Obsidian note names remain portable for Windows-reserved article titles',async t=>{
  const vault=await temp(t),config=settings(vault),ws=workspace();ws.title='CON';
  const result=await exportToObsidian(ws,config);assert.equal(path.basename(result.path),'_CON.md');
  assert.match(await readFile(result.path,'utf8'),/title: "CON"/);
});

test('English Markdown localizes generated headings and labels while preserving Chinese source content and frontmatter', () => {
  const ws = workspace(); ws.title = '中文论文标题'; ws.notes = '## 用户自己的标题\n\n保留原始笔记。'; ws.summary!.content = '原始中文总结'; ws.memoryIndex = '- [finding] 原有记忆索引';
  ws.memories[0].title = '中文发现'; ws.memories[0].body = '中文证据';
  for (const type of ['interpretation', 'question', 'cross-ref', 'user-note'] as const) ws.memories.push({ ...ws.memories[0], id: type, type });
  const doc = ws.documents[0]; doc.name = '正文文件.pdf'; doc.annotations[0].text = '不能翻译这段原文'; doc.annotations[0].comment = '我的中文批注';
  doc.annotations.push({ ...doc.annotations[0], id: 'under', kind: 'underline' }, { ...doc.annotations[0], id: 'strike', kind: 'strikeout' });
  ws.documents.push({ ...doc, id: 'supplement', role: 'supplement', name: '补充文件.pdf', fileName: 'supplement.pdf', pageCount: 0, annotations: [] });
  ws.conversations[0].title = '用户命名对话'; ws.conversations[0].messages[0].content = '原始用户提问';
  ws.conversations[0].messages.push({ id: 'answer', role: 'assistant', content: '原始助手回答', createdAt: 2, interrupted: true });
  const original = structuredClone(ws), zh = renderMarkdown(ws), en = renderMarkdown(ws, undefined, undefined, 'en');
  assert.equal(en.split('<!-- folio:generated:start -->')[0], zh.split('<!-- folio:generated:start -->')[0]);
  for (const heading of ['Paper files', 'AI summary', 'Memory index', 'Long-term memories', 'My notes', 'PDF annotations', 'Reading conversations']) assert.ok(en.includes(`## ${heading}\n`));
  for (const label of ['Findings', 'Interpretations', 'Open questions', 'Cross-paper links', 'Personal interests']) assert.ok(en.includes(`### ${label}\n`));
  assert.match(en, /Main text: \[正文文件.pdf\]/); assert.match(en, /Supplement: \[补充文件.pdf\]/); assert.match(en, /2 pages/); assert.match(en, /Page count unknown/);
  for (const kind of ['Highlight', 'Underline', 'Strikeout']) assert.ok(en.includes(`Page 2 · ${kind}**: 我的中文批注`));
  assert.match(en, /#### Me ·/); assert.match(en, /#### Assistant · .*\(interrupted\)/); assert.match(en, /Topics: immunity/); assert.match(en, /Exported by Pairleaf/);
  for (const content of [ws.title, ws.notes, ws.summary!.content, ws.memoryIndex, '中文发现', '中文证据', '不能翻译这段原文', '我的中文批注', '用户命名对话', '原始用户提问', '原始助手回答']) assert.ok(en.includes(content));
  assert.deepEqual(ws, original); assert.equal((en.match(/folio:generated:start/g) || []).length, 1); assert.match(en, /<!-- folio:generated:end -->/);
});

test('switching export language updates only the managed region and retains handwritten Chinese notes and original firstRead', async t => {
  const vault = await temp(t), config = settings(vault), ws = workspace(); ws.notes = '工作区中文笔记';
  const first = await exportToObsidian(ws, config);
  const handwrittenBefore = '## 用户在托管区前的中文记录\n保留前部手写内容。\n\n';
  const handwrittenAfter = '\n## 用户在托管区后的中文记录\n保留后部手写内容。\n';
  let old = await readFile(first.path, 'utf8');
  old = old.replace('firstRead: "2020-01-02T00:00:00.000Z"', 'firstRead: "2011-02-03T00:00:00.000Z"\nmy_rating: "中文评价"').replace('<!-- folio:generated:start -->', handwrittenBefore + '<!-- folio:generated:start -->') + handwrittenAfter;
  await writeFile(first.path, old); config.language = 'en'; ws.notes += '\n补充中文内容';
  const second = await exportToObsidian(ws, config); assert.equal(second.path, first.path); assert.equal(second.overwritten, true);
  const english = await readFile(second.path, 'utf8'); assert.match(english, /## My notes\n/); assert.ok(!english.includes('## 我的笔记\n')); assert.ok(english.includes(ws.notes));
  assert.ok(english.includes(handwrittenBefore)); assert.ok(english.endsWith(handwrittenAfter)); assert.match(english, /firstRead: "2011-02-03T00:00:00.000Z"/); assert.match(english, /my_rating: "中文评价"/);
  await exportToObsidian(ws, config); assert.equal(await readFile(second.path, 'utf8'), english);
  config.language = 'zh-CN'; await exportToObsidian(ws, config); const chinese = await readFile(second.path, 'utf8');
  assert.match(chinese, /## 我的笔记\n/); assert.ok(chinese.includes(handwrittenBefore)); assert.ok(chinese.endsWith(handwrittenAfter));
});

test('English migration of an unmanaged legacy note labels the preserved section without rewriting its content', async t => {
  const vault = await temp(t), config = settings(vault), ws = workspace(); config.language = 'en';
  await mkdir(path.join(vault, 'Papers')); const note = path.join(vault, 'Papers', 'Legacy中文.md');
  const legacyBody = '## 我自己的旧标题\n\n这是旧中文笔记，不能翻译或覆盖。\n';
  await writeFile(note, `---\narticle_id: ${JSON.stringify(ws.id)}\nfirstRead: '2010-01-01T00:00:00.000Z'\n---\n${legacyBody}`);
  const result = await exportToObsidian(ws, config); assert.equal(result.path, note);
  const text = await readFile(note, 'utf8'); assert.match(text, /## Previous notes \(preserved\)/); assert.ok(text.includes(legacyBody)); assert.match(text, /## Paper files/);
  await exportToObsidian(ws, config); assert.equal(await readFile(note, 'utf8'), text);
});
