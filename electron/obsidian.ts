import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExportResult, Settings, Workspace } from '../shared/types';
import { MEMORY_LABELS } from '../shared/types';
import { safeFilename } from './store';

const START = '<!-- folio:generated:start -->';
const END = '<!-- folio:generated:end -->';
const generatedKeys = new Set(['article_id', 'title', 'authors', 'journal', 'doi', 'firstRead', 'lastRead', 'favorite', 'tags', 'kind']);
const locks = new Map<string, Promise<unknown>>();

function clean(value: string): string {
  return value.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/<!--\s*folio:generated:(?:start|end)\s*-->/gi, '[Folio marker]');
}
function scalar(value: string): string { return JSON.stringify(clean(value)); }
function label(value: string): string { return clean(value).replace(/[\[\]\\]/g, '\\$&').replace(/[\r\n]/g, ' '); }
function iso(value: number): string { return new Date(Number.isFinite(value) ? value : 0).toISOString(); }

/** A stable generated region lets Obsidian edits outside that region survive all re-exports. */
export function renderMarkdown(workspace: Workspace, firstReadOverride?: string, libraryPath?: string): string {
  const fm = ['---', `article_id: ${scalar(workspace.id)}`, `title: ${scalar(workspace.title)}`];
  if (workspace.authors) fm.push(`authors: ${scalar(workspace.authors)}`);
  if (workspace.journal) fm.push(`journal: ${scalar(workspace.journal)}`);
  if (workspace.doi) fm.push(`doi: ${scalar(workspace.doi)}`);
  fm.push(`firstRead: ${scalar(firstReadOverride || iso(workspace.createdAt))}`, `lastRead: ${scalar(iso(workspace.lastReadAt))}`, 'kind: academic-paper', `favorite: ${workspace.favorite}`);
  if (workspace.tags.length) fm.push('tags:', ...workspace.tags.map(tag => `  - ${scalar(tag)}`));
  fm.push('---', '');
  const out = [...fm, START, '', `# ${clean(workspace.title).replace(/[\r\n]/g, ' ')}`, ''];
  if (workspace.doi) out.push(`[DOI: ${label(workspace.doi)}](https://doi.org/${encodeURI(workspace.doi).replace(/[()]/g, c => encodeURIComponent(c))})`, '');
  if (workspace.documents.length) {
    out.push('## 论文文件', '');
    for (const doc of workspace.documents) {
      const location = libraryPath ? pathToFileURL(path.resolve(libraryPath, workspace.id, doc.fileName)).href : encodeURI(doc.fileName).replace(/[()]/g, c => encodeURIComponent(c));
      out.push(`- ${doc.role === 'main' ? '正文' : '补充材料'}：[${label(doc.name)}](${location.replace(/[()]/g, c => encodeURIComponent(c))}) · ${doc.pageCount || '未知'} 页`);
    }
    out.push('');
  }
  if (workspace.summary?.content) out.push('## AI 总结', '', `> ${label(workspace.summary.provider)} / ${label(workspace.summary.model)} · ${iso(workspace.summary.createdAt)}`, '', clean(workspace.summary.content), '');
  if (workspace.memoryIndex.trim()) out.push('## 记忆索引', '', clean(workspace.memoryIndex.trim()), '');
  if (workspace.memories.length) {
    out.push('## 长期记忆', '');
    for (const type of ['finding', 'interpretation', 'question', 'cross-ref', 'user-note'] as const) {
      const entries = workspace.memories.filter(m => m.type === type);
      if (!entries.length) continue;
      out.push(`### ${MEMORY_LABELS[type]}`, '');
      for (const entry of entries) {
        out.push(`- **${label(entry.title)}**`, '', ...clean(entry.body).split('\n').map(line => `  ${line}`), '');
        if (entry.tags.length) out.push(`  主题：${entry.tags.map(label).join(' · ')}`, '');
      }
    }
  }
  if (workspace.notes.trim()) out.push('## 我的笔记', '', clean(workspace.notes.trim()), '');
  const annotated = workspace.documents.filter(doc => doc.annotations.length);
  if (annotated.length) {
    out.push('## PDF 标注', '');
    for (const doc of annotated) {
      out.push(`### ${label(doc.name)}`, '');
      for (const annotation of doc.annotations) {
        const kind=annotation.kind==='underline'?'下划线':annotation.kind==='strikeout'?'删除线':'高亮';
        out.push(`- **第 ${annotation.page} 页 · ${kind}**${annotation.comment ? `：${clean(annotation.comment)}` : ''}`, '');
        if (annotation.text) out.push(...clean(annotation.text).split('\n').map(line => `  > ${line}`), '');
      }
    }
  }
  const conversations = workspace.conversations.filter(c => c.messages.length);
  if (conversations.length) {
    out.push('## 阅读对话', '');
    for (const conversation of conversations) {
      out.push(`### ${clean(conversation.title).replace(/[\r\n]/g, ' ')}`, '');
      for (const message of conversation.messages) out.push(`#### ${message.role === 'user' ? '我' : '助手'} · ${iso(message.createdAt)}${message.interrupted ? '（已中断）' : ''}`, '', clean(message.content), '');
    }
  }
  out.push('_由 Folio 导出。此标记区域由应用更新；可在区域之外自由添加笔记。_', '', END, '');
  return out.join('\n');
}

interface Frontmatter { raw: string; body: string }
function frontmatter(text: string): Frontmatter | undefined {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? { raw: match[1], body: text.slice(match[0].length) } : undefined;
}
function property(raw: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.*?)\\s*$`, 'm').exec(raw);
  if (!match) return;
  const value = match[1];
  if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return; } }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value.replace(/\s+#.*$/, '').trim();
}
function extraFrontmatter(raw: string): string {
  const chunks = raw.split(/\r?\n(?=[A-Za-z_][A-Za-z_\d-]*:)/);
  return chunks.filter(chunk => {
    const key = /^([A-Za-z_][A-Za-z_\d-]*):/.exec(chunk)?.[1];
    return key && !generatedKeys.has(key);
  }).join('\n');
}

async function findExisting(directory: string, articleId: string): Promise<{ filePath: string; text: string; firstRead?: string } | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const match = await findExisting(filePath, articleId);
      if (match) return match;
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      const text = await readFile(filePath, 'utf8');
      const fm = frontmatter(text);
      if (fm && property(fm.raw, 'article_id') === articleId) return { filePath, text, firstRead: property(fm.raw, 'firstRead') };
    }
  }
}

async function exists(filePath: string): Promise<boolean> {
  try { await lstat(filePath); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function performExport(workspace: Workspace, settings: Settings): Promise<ExportResult> {
  if (!settings.vaultPath.trim()) throw new Error('请先在设置中选择 Obsidian Vault 文件夹。');
  const vault = await realpath(settings.vaultPath);
  if (!(await lstat(vault)).isDirectory()) throw new Error('Obsidian Vault 路径不是文件夹。');
  const subfolder = settings.obsidianSubfolder.trim();
  const segments = subfolder.split(/[\\/]+/).filter(Boolean);
  if (path.isAbsolute(subfolder) || segments.some(part => part === '..' || part === '.' || part.includes('\0'))) throw new Error('Obsidian 子文件夹必须是 Vault 内的相对路径。');
  let directory = vault;
  for (const segment of segments) {
    directory = path.join(directory, segment);
    await mkdir(directory, { recursive: true });
    const resolved = await realpath(directory);
    if (resolved !== vault && !resolved.startsWith(vault + path.sep)) throw new Error('Obsidian 子文件夹不能通过链接指向 Vault 外部。');
  }
  const existing = await findExisting(directory, workspace.id);
  const filename = safeFilename(clean(workspace.title));
  let filePath = existing?.filePath || path.join(directory, `${filename}.md`);
  if (!existing && await exists(filePath)) {
    const suffix = createHash('sha256').update(workspace.id).digest('hex').slice(0, 10);
    filePath = path.join(directory, `${filename} (${suffix}).md`);
    let count = 2;
    while (await exists(filePath)) filePath = path.join(directory, `${filename} (${suffix}-${count++}).md`);
  }
  let markdown = renderMarkdown(workspace, existing?.firstRead, settings.libraryPath);
  if (existing) {
    const old = frontmatter(existing.text)!;
    const fresh = frontmatter(markdown)!;
    const extra = extraFrontmatter(old.raw);
    let body: string;
    const first = old.body.indexOf(START), last = old.body.indexOf(END, first + START.length);
    if (first >= 0 && last >= first) {
      // Preserve all handwritten content before and after the generated block.
      const generatedStart = fresh.body.indexOf(START), generatedEnd = fresh.body.indexOf(END) + END.length;
      body = old.body.slice(0, first) + fresh.body.slice(generatedStart, generatedEnd) + old.body.slice(last + END.length);
    } else {
      // Older exports had no managed region: retain their body rather than overwrite user edits.
      body = fresh.body + (old.body.trim() ? `\n## 先前笔记（保留）\n\n${old.body}` : '');
    }
    markdown = `---\n${fresh.raw}${extra ? '\n' + extra : ''}\n---\n${body}`;
  }
  const temporary = path.join(path.dirname(filePath), `.folio-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, filePath);
  } finally { await unlink(temporary).catch(() => {}); }
  return { path: filePath, overwritten: !!existing };
}

/** Serialize exports per vault so parallel exports of the same article cannot create duplicates. */
export async function exportToObsidian(workspace: Workspace, settings: Settings): Promise<ExportResult> {
  const key = path.resolve(settings.vaultPath || '.');
  const previous = locks.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => performExport(workspace, settings));
  locks.set(key, task);
  try { return await task; } finally { if (locks.get(key) === task) locks.delete(key); }
}
