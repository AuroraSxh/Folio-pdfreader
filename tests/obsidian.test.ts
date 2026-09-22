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
  return { vaultPath, obsidianSubfolder: 'Papers', libraryPath: '/Users/Test/Library/Folio', activeProvider: 'deepseek', providers: {} as Settings['providers'], autoSummary: false, autoMemory: false, contextMaxChars: 12000, theme: 'light', readingTheme: 'white', annotationToolbar: 'floating' };
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
