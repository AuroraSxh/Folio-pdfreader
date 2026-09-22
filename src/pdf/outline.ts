import type { OutlineItem } from '../../shared/types';

export function locateOutline(items: OutlineItem[], id: string): { siblings: OutlineItem[]; index: number; parent?: OutlineItem; parentSiblings?: OutlineItem[] } | undefined {
  const visit = (siblings: OutlineItem[], parent?: OutlineItem, parentSiblings?: OutlineItem[]): ReturnType<typeof locateOutline> => {
    for (let index = 0; index < siblings.length; index++) {
      if (siblings[index].id === id) return { siblings, index, parent, parentSiblings };
      const match = visit(siblings[index].children, siblings[index], siblings);
      if (match) return match;
    }
  };
  return visit(items);
}

/** Preserve descendants while moving an entry through the outline hierarchy. */
export function changeOutline(items: OutlineItem[], id: string, action: 'up' | 'down' | 'indent' | 'outdent' | 'delete'): OutlineItem[] {
  const next = structuredClone(items);
  const found = locateOutline(next, id);
  if (!found) return next;
  const { siblings, index, parent, parentSiblings } = found;
  const item = siblings[index];
  if (action === 'delete') siblings.splice(index, 1);
  if (action === 'up' && index > 0) siblings.splice(index - 1, 0, ...siblings.splice(index, 1));
  if (action === 'down' && index < siblings.length - 1) siblings.splice(index + 1, 0, ...siblings.splice(index, 1));
  if (action === 'indent' && index > 0) siblings[index - 1].children.push(...siblings.splice(index, 1));
  if (action === 'outdent' && parent && parentSiblings) {
    siblings.splice(index, 1);
    parentSiblings.splice(parentSiblings.indexOf(parent) + 1, 0, item);
  }
  return next;
}
