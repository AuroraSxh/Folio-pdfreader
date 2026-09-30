/** First-page title detection stays local and deliberately falls back when evidence is weak. */
export interface TitleTextItem {
  str: string;
  x: number;
  /** Top-to-bottom page coordinate, independent of the PDF's bottom-up coordinate system. */
  y: number;
  width: number;
  fontSize: number;
}

export interface PaperTitleInput {
  metadataTitle?: unknown;
  filename: string;
  items: TitleTextItem[];
  pageWidth: number;
  pageHeight: number;
}
export interface DetectedPaperTitle { title: string; source: 'metadata' | 'first-page' | 'filename' }
export const MAX_PAPER_TITLE_LENGTH = 500;

const clean = (value: string) => value.normalize('NFKC').replace(/[\u0000-\u001f\u007f\u200b\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
const cjk = /[\u3400-\u9fff]/;
const generic = /^(?:untitled(?:\s*\d+)?|unknown|document(?:\s*\d+)?|pdf(?:\s+document)?|manuscript(?:\s*\d+)?|title|full\s*text|main(?:\s+text)?|article|research\s+article|original\s+(?:article|research)|accepted\s+manuscript|author\s+manuscript|supplement(?:al|ary)?(?:\s+(?:information|material|materials|data))?|supporting\s+information|无标题|未命名(?:文档)?|正文|论文|文章|研究论文|补充材料)$/i;
const section = /^(?:abstract|summary|introduction|highlights|graphical abstract|contents|keywords|key words|references|摘要|关键词|引言)(?:\s*[:：].*)?$/i;
const publisher = /^(?:(?:www\.|https?:\/\/)|(?:nature(?:\s+(?:communications|medicine|immunology|aging|methods|biotechnology|cancer|genetics|microbiology|neuroscience|cell biology))?|cell(?:\s+(?:press|reports|metabolism|host\s*&\s*microbe))?|science(?:\s+(?:advances|immunology|signaling))?|scientific reports|pnas|elsevier|springer(?:\s+nature)?|wiley|frontiers|plos\s+\w+|biorxiv|medrxiv|arxiv|open access|research|review|letter|article|research article|original article|research paper|journal of .{0,70})$)/i;

export function titleFromFilename(filename: string): string {
  const name = filename.split(/[\\/]/).pop() ?? filename;
  return clean(name.replace(/\.pdf$/i, '').replace(/_/g, ' ')).slice(0, MAX_PAPER_TITLE_LENGTH);
}

/** Reject producer labels and machine identifiers, but preserve real short scientific titles. */
export function credibleMetadataTitle(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_000) return;
  const title = clean(value);
  if (title.length < 8 || title.length > MAX_PAPER_TITLE_LENGTH || generic.test(title) || publisher.test(title) || section.test(title)) return;
  if (/^(?:microsoft\s+(?:word|powerpoint)|adobe\s+acrobat|acrobat|latex|untitled|document\d*)\b/i.test(title)) return;
  if (/^(?:doi\s*:?\s*)?10\.\d{4,9}\//i.test(title) || /^(?:https?:\/\/|[a-z]:[\\/]|\/)/i.test(title)) return;
  if (/\.(?:pdf|docx?|tex|pptx?)$/i.test(title) || /^[\w.-]+$/u.test(title) || /^\d+(?:\.\d+)+/.test(title)) return;
  const letters = (title.match(/\p{L}/gu) ?? []).length;
  if (letters < 6 || letters / title.length < 0.5) return;
  if (!cjk.test(title) && title.split(/\s+/).length < 2) return;
  return title;
}

interface Line { text: string; x: number; right: number; y: number; size: number }
function linesFromItems(items: TitleTextItem[], pageHeight: number): Line[] {
  const valid = items.slice(0, 6_000).filter(item => clean(item.str) && Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.width) && Number.isFinite(item.fontSize) && item.fontSize >= 5 && item.y >= 0 && item.y <= pageHeight * 0.78).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: TitleTextItem[][] = [];
  for (const item of valid) {
    let row = rows[rows.length - 1];
    if (!row || Math.abs(row[0].y - item.y) > Math.max(2, Math.min(row[0].fontSize, item.fontSize) * 0.33)) rows.push(row = []);
    row.push(item);
  }
  return rows.flatMap(row => {
    row.sort((a, b) => a.x - b.x);
    const groups: TitleTextItem[][] = [];
    for (const item of row) {
      let group = groups[groups.length - 1];
      const previous = group?.[group.length - 1];
      if (!previous || item.x - previous.x - previous.width > Math.max(35, item.fontSize * 3)) groups.push(group = []);
      group!.push(item);
    }
    return groups.map(group => {
      let text = '';
      for (let i = 0; i < group.length; i++) {
        const item = group[i]; const before = group[i - 1];
        const gap = before ? item.x - before.x - before.width : 0;
        const space = before && !/\s$/.test(before.str) && !/^\s/.test(item.str) && gap > item.fontSize * 0.12 && !(cjk.test(before.str.slice(-1)) && cjk.test(item.str[0] ?? ''));
        text += `${space ? ' ' : ''}${item.str}`;
      }
      // Superscript author markers should not change the line's estimated typography.
      const main = [...group].sort((a, b) => b.str.trim().length - a.str.trim().length)[0];
      return { text: clean(text), x: group[0].x, right: Math.max(...group.map(item => item.x + item.width)), y: main.y, size: main.fontSize };
    });
  }).sort((a, b) => a.y - b.y || a.x - b.x);
}

function looksLikeAuthors(text: string): boolean {
  if (/@|\b(?:university|department|institute|correspondence|received|accepted|published|copyright)\b|大学|研究所|通讯作者/i.test(text)) return true;
  const names = text.replace(/[\d*†‡]/g, '').split(/[,，;]/).map(value => value.trim()).filter(Boolean);
  return names.length >= 2 && names.every(name => /^(?:(?:and|&)\s+)?(?:[A-Z][\p{L}.'’-]*\s+){1,3}[A-Z][\p{L}.'’-]*$/u.test(name));
}
function isHeadlineLine(line: Line): boolean {
  return !generic.test(line.text) && !publisher.test(line.text) && !section.test(line.text) && !looksLikeAuthors(line.text) && !/^(?:doi\s*:|https?:|©|\d+\s*$|\w*ISSN|volume\s|vol\.\s)/i.test(line.text);
}
function joinHeadline(lines: Line[]): string {
  let title = '';
  for (const line of lines) {
    if (!title) title = line.text;
    // Keep visible scientific compound hyphens: their meaning cannot be inferred from a line break.
    else if (/\p{L}-$/u.test(title) && /^\p{L}/u.test(line.text)) title += line.text;
    else title += `${cjk.test(title.slice(-1)) && cjk.test(line.text[0] ?? '') ? '' : ' '}${line.text}`;
  }
  return title;
}

export function detectPaperTitle(input: PaperTitleInput): DetectedPaperTitle {
  const metadata = credibleMetadataTitle(input.metadataTitle);
  if (metadata) return { title: metadata, source: 'metadata' };
  const fallback: DetectedPaperTitle = { title: titleFromFilename(input.filename), source: 'filename' };
  if (!Number.isFinite(input.pageWidth) || !Number.isFinite(input.pageHeight) || input.pageWidth <= 0 || input.pageHeight <= 0) return fallback;
  const lines = linesFromItems(input.items, input.pageHeight);
  const bodySizes = lines.filter(line => line.text.length >= 30 && line.y > input.pageHeight * 0.32).map(line => line.size).sort((a, b) => a - b);
  const bodySize = bodySizes[Math.floor(bodySizes.length / 2)] ?? 10;
  const candidates: { title: string; score: number }[] = [];
  for (let start = 0; start < lines.length; start++) {
    const first = lines[start];
    if (first.y > input.pageHeight * 0.57 || !isHeadlineLine(first) || first.size < Math.max(10, bodySize * 1.08)) continue;
    const block = [first];
    for (let index = start + 1; index < lines.length && block.length < 8; index++) {
      const next = lines[index]; const previous = block[block.length - 1];
      const sameSize = next.size >= first.size * 0.85 && next.size <= first.size * 1.15;
      const aligned = Math.abs(next.x - first.x) < Math.max(25, first.size * 1.5) || Math.abs((next.x + next.right) / 2 - (first.x + first.right) / 2) < input.pageWidth * 0.08;
      if (next.y - previous.y < first.size * 0.5 || next.y - previous.y > first.size * 2 || !sameSize || !aligned || !isHeadlineLine(next)) break;
      block.push(next);
    }
    const title = joinHeadline(block);
    if (!credibleMetadataTitle(title) || (cjk.test(title) ? title.length < 8 : title.length < 14 || title.split(/\s+/).length < 3)) continue;
    const score = Math.min(first.size / bodySize, 3) * 45 + Math.min(title.length, 130) * 0.16 - first.y / input.pageHeight * 20;
    candidates.push({ title, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? { title: candidates[0].title, source: 'first-page' } : fallback;
}
