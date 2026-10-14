import type { HTMLAttributes } from 'react';
import type { AssistantResizeEdge } from '../hooks/floatingAssistantGeometry';
import { useI18n } from '../i18n';

interface Props {
  docked: boolean;
  width: number;
  dockedProps: Pick<HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onKeyDown'>;
  floatingProps: (edge: AssistantResizeEdge) => HTMLAttributes<HTMLElement>;
}
const edges: AssistantResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export default function AssistantResizeHandles({ docked, width, dockedProps, floatingProps }: Props) {
  const { t } = useI18n();
  if (docked) return <div className="assistant-resize-handle" role="separator"
    aria-label={t('调整阅读伙伴宽度', 'Resize reading companion')} aria-orientation="vertical"
    aria-valuemin={320} aria-valuemax={600} aria-valuenow={width} tabIndex={0}
    {...dockedProps} />;
  return <>{edges.map(edge => edge.length === 2
    ? <button key={edge} type="button" {...floatingProps(edge)} className={`assistant-edge-resize assistant-edge-resize-${edge}`} />
    : <div key={edge} {...floatingProps(edge)} className={`assistant-edge-resize assistant-edge-resize-${edge}`} />)}</>;
}
