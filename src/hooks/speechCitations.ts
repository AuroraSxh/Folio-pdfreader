export interface SpeechSource { name: string; fileName?: string; role?: string }
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PAGE = '(?:pp?\\.?\\s*|第\\s*)(\\d{1,5})(?:\\s*[-–—]\\s*(\\d{1,5}))?(?:\\s*页)?(?![A-Za-z0-9]|\\.\\d)';
const SEP = '[\\s\\u2800-\\u28ff\\u200b-\\u200d\\ufeff]+';

/** References remain clickable in chat. In speech, bracketed source markers
 * are silent; explicit inline references keep a short, grounded page location. */
export function speechCitations(text: string, sources: SpeechSource[] = [], language = 'zh-CN'): string {
  const names = new Map<string, SpeechSource>();
  for (const source of sources) for (const name of [source.name, source.fileName]) if (name && !names.has(name)) names.set(name, source);
  const isReference = (label: string) => {
    const match = label.match(new RegExp(`^(.+?)${SEP}${PAGE}$`, 'i'));
    return !!match && ([...names.keys()].some(name => name.toLowerCase() === match[1].trim().toLowerCase()) || /\.pdf$/i.test(match[1].trim()));
  };
  // Strip full local-citation links before generic Markdown removes their URLs.
  let output = text.replace(/\[([^\]\n]{1,500})\]\((folio-cite:\/\/[^)\s]+)\)/gi, '');
  output = output.replace(/\[([^\]\n]{1,500})\](?:\(([^)\s]+)\))?/g,
    (original, label: string) => isReference(label) ? '' : original);
  const location = (name: string, start: string, end?: string) => {
    const source = names.get(name);
    const page = `${Number(start)}${end ? language === 'en-US' ? ` to ${Number(end)}` : `至${Number(end)}` : ''}`;
    if (language === 'en-US') return `${source?.role === 'main' ? 'main text' : source?.role === 'supplement' ? 'supplement' : 'document'} ${end ? 'pages' : 'page'} ${page}`;
    return `${source?.role === 'main' ? '正文' : source?.role === 'supplement' ? '补充材料' : '文献'}第${page}页`;
  };
  // Use workspace names first (including names with spaces/non-Latin letters).
  for (const name of [...names.keys()].sort((a,b) => b.length-a.length)) {
    output = output.replace(new RegExp(`(?<![A-Za-z0-9_.-])${escaped(name)}${SEP}${PAGE}`, 'gi'), (_all, start: string, end: string) => location(name, start, end));
  }
  // Unrecognized PDF filenames are still technical citation identifiers, not
  // speech. Do not guess whether an unknown file is the main text or supplement.
  output = output.replace(new RegExp(`(?:[A-Za-z0-9][A-Za-z0-9_.-]*\\.pdf)${SEP}${PAGE}`, 'gi'),
    (_all, start: string, end: string) => location('', start, end));
  return output.replace(/[\u2800-\u28ff\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t]+([，。！？,.;!?])/g, '$1').replace(/([（(])\s*([）)])/g, '');
}
