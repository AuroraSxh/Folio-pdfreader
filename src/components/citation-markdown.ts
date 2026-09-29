import type { Root, RootContent, Parent, Text } from 'mdast';
import { CITATION_PATTERN, citationURL, type createCitationResolver } from '../../shared/citations';

/** Transform Markdown text nodes only: code, existing links and images stay intact. */
export function remarkSourceCitations(resolver: ReturnType<typeof createCitationResolver>) {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      const next: RootContent[] = [];
      for (const child of parent.children) {
        if (child.type !== 'text') {
          if ('children' in child && !['link', 'linkReference', 'image', 'imageReference'].includes(child.type)) visit(child as Parent);
          next.push(child); continue;
        }
        let cursor = 0;
        for (const match of child.value.matchAll(CITATION_PATTERN)) {
          const citation = resolver.fromLabel(match[1]); if (!citation) continue;
          if (match.index > cursor) next.push({ type: 'text', value: child.value.slice(cursor, match.index) } as Text);
          next.push({ type: 'link', url: citationURL(citation), children: [{ type: 'text', value: `${citation.name} p.${citation.page}` }] });
          cursor = match.index + match[0].length;
        }
        if (!cursor) next.push(child);
        else if (cursor < child.value.length) next.push({ type: 'text', value: child.value.slice(cursor) } as Text);
      }
      parent.children = next;
    };
    visit(tree);
  };
}
