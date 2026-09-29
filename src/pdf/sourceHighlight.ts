/** A confirmed quote is an exact, unique match after typography normalization.
 * Deliberately no fuzzy/semantic matching: a paraphrase must never highlight an
 * unrelated sentence just because it shares a number or a scientific term.
 */
export type SourceQuoteMatch = { status: 'matched'; start: number; end: number } | { status: 'missing' | 'ambiguous' | 'too-short' };

interface NormalizedSource { text: string; starts: number[]; ends: number[] }
const WORD = /[\p{L}\p{N}]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function normalizeSource(input: string): NormalizedSource {
  let text = '';
  const starts: number[] = [], ends: number[] = [];
  for (let index = 0; index < input.length;) {
    const start = index;
    const char = String.fromCodePoint(input.codePointAt(index)!);
    index += char.length;
    if (char === '\u00ad') {
      const lineBreak = input.slice(index).match(/^[ \t]*\r?\n\s*(?=\p{L})/u);
      if (lineBreak && /\p{L}/u.test(input[start - 1] || '')) index += lineBreak[0].length;
      continue;
    }
    if (/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/u.test(char)) continue;
    // Only remove a printed hyphen at a real line break between letters. The
    // minus in CD4-negative and numeric ranges is otherwise significant.
    if (/[-\u2010\u2011]/u.test(char) && /\p{L}/u.test(input[start - 1] || '')) {
      const lineBreak = input.slice(index).match(/^[ \t]*\r?\n\s*(?=\p{L})/u);
      if (lineBreak) { index += lineBreak[0].length; continue; }
    }
    const normalized = char.normalize('NFKC').toLowerCase()
      .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010\u2011]/g, '-');
    for (const unit of normalized) {
      if (/\s/u.test(unit)) {
        // PDF text extraction inserts layout spaces in scripts that do not use
        // them to separate words. This is not a license to join Latin words.
        const previous = text.slice(-2).match(/.$/u)?.[0] || '';
        if (CJK.test(previous) && CJK.test(input.slice(index).match(/^\s*(\S)/u)?.[1] || '')) continue;
        if (text.endsWith(' ')) { ends[ends.length - 1] = index; continue; }
        text += ' '; starts.push(start); ends.push(index);
      } else {
        text += unit;
        // String.indexOf returns UTF-16 offsets, including astral characters.
        for (let offset = 0; offset < unit.length; offset++) { starts.push(start); ends.push(index); }
      }
    }
  }
  return { text, starts, ends };
}

export function matchSourceQuote(source: string, quote: string): SourceQuoteMatch {
  const needle = normalizeSource(quote).text.trim();
  const letters = [...needle].filter(char => WORD.test(char));
  const minimum = letters.some(char => CJK.test(char)) ? 8 : 12;
  if (letters.length < minimum) return { status: 'too-short' };
  const haystack = normalizeSource(source);
  let found = -1, position = 0;
  while (position <= haystack.text.length - needle.length) {
    const index = haystack.text.indexOf(needle, position);
    if (index < 0) break;
    position = index + 1;
    const before = haystack.text.slice(Math.max(0, index - 2), index).match(/.$/u)?.[0] || '';
    const after = haystack.text.slice(index + needle.length, index + needle.length + 2).match(/^./u)?.[0] || '';
    const first = needle.match(/^./u)![0], last = needle.slice(-2).match(/.$/u)![0];
    // CJK does not use spaces as word boundaries. Latin fragments cannot match
    // the middle of a longer word ("active" is not "inactive").
    if ((WORD.test(first) && !CJK.test(first) && WORD.test(before) && !CJK.test(before))
      || (WORD.test(last) && !CJK.test(last) && WORD.test(after) && !CJK.test(after))) continue;
    if (found >= 0) return { status: 'ambiguous' };
    found = index;
  }
  if (found < 0) return { status: 'missing' };
  return { status: 'matched', start: haystack.starts[found], end: haystack.ends[found + needle.length - 1] };
}

/** PDF.js text items receive the same separator used by our durable page index.
 * Keep per-text-node offsets so search highlights wrapping a span do not change
 * the quote or require modifying the browser's native selection.
 */
export function sourceQuoteClientRects(layer: HTMLElement, quote: string): { status: SourceQuoteMatch['status']; rects: DOMRect[] } {
  let text = '';
  const pieces: { node: Text; start: number; end: number }[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = text.length;
      text += node.textContent || '';
      pieces.push({ node: node as Text, start, end: text.length });
      return;
    }
    if (!(node instanceof HTMLElement) || node.classList.contains('endOfContent')) return;
    if (node.tagName === 'BR') { text += '\n'; return; }
    for (const child of node.childNodes) visit(child);
    if (node.tagName === 'SPAN' && node.getAttribute('role') === 'presentation') text += ' ';
  };
  visit(layer);
  const result = matchSourceQuote(text, quote);
  if (result.status !== 'matched') return { status: result.status, rects: [] };
  const rects: DOMRect[] = [];
  for (const piece of pieces) {
    if (piece.end <= result.start || piece.start >= result.end) continue;
    const range = layer.ownerDocument.createRange();
    range.setStart(piece.node, Math.max(0, result.start - piece.start));
    range.setEnd(piece.node, Math.min(piece.node.length, result.end - piece.start));
    rects.push(...range.getClientRects());
  }
  return { status: 'matched', rects };
}
