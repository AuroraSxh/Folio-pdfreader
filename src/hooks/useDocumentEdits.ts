import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaperDocument, Workspace } from '../../shared/types';

type DocumentPatch = Partial<Pick<PaperDocument, 'name' | 'role' | 'outline' | 'annotations' | 'view'>>;
type Direction = 'undo' | 'redo';

export function isTextEditing() {
  const element = document.activeElement;
  return element instanceof HTMLElement && (element.isContentEditable || !!element.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'));
}

export default function useDocumentEdits(workspaceId: string | undefined, onWorkspace: (workspace: Workspace) => void, onError: (message: string) => void) {
  const current = useRef({ workspaceId, onWorkspace, onError });
  current.current = { workspaceId, onWorkspace, onError };
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingRequests = useRef(new Set<Promise<unknown>>());
  const replayCount = useRef(0);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const refresh = useCallback(async (id: string) => {
    const value = await window.folio.getDocumentEditHistory(id);
    if (current.current.workspaceId === id) setHistory(value);
  }, []);
  useEffect(() => {
    setHistory({ canUndo: false, canRedo: false });
    if (workspaceId) void refresh(workspaceId).catch(error => current.current.onError(String(error)));
  }, [workspaceId, refresh]);
  const schedule = useCallback(<T,>(action: () => Promise<T>, replay = false) => {
    if (replay) replayCount.current++;
    const pending = queue.current.then(action);
    pendingRequests.current.add(pending);
    setBusy(true);
    const finish = () => {
      if (replay) replayCount.current--;
      pendingRequests.current.delete(pending);
      setBusy(pendingRequests.current.size > 0);
    };
    void pending.then(finish, finish);
    queue.current = pending.catch(() => {});
    return pending;
  }, []);
  const editDocument = useCallback((id: string, documentId: string, patch: DocumentPatch) => {
    // Reject a snapshot captured before an in-flight Undo/Redo has reached React.
    if (replayCount.current && (patch.annotations || patch.outline)) return Promise.reject(new Error('正在撤销或重做，请稍后再编辑标记'));
    return schedule(async () => {
      const workspace = await window.folio.updateDocument(id, documentId, patch);
      current.current.onWorkspace(workspace);
      if (patch.annotations || patch.outline) await refresh(id);
      return workspace;
    });
  }, [schedule, refresh]);
  const undo = useCallback((direction: Direction, preferDocument = false) => {
    if (!preferDocument && isTextEditing()) { void window.folio.nativeEdit(direction).catch(error => current.current.onError(String(error))); return; }
    const id = current.current.workspaceId;
    if (!id) return;
    void schedule(async () => {
      const workspace = await window.folio.undoDocumentEdit(id, direction);
      current.current.onWorkspace(workspace);
      await refresh(id);
    }, true).catch(error => current.current.onError(String(error)));
  }, [schedule, refresh]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && !(event.ctrlKey && key === 'y')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      undo(event.shiftKey || key === 'y' ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey, true);
    const onFlush = (event: Event) => (event as CustomEvent<Promise<unknown>[]>).detail.push(...pendingRequests.current);
    window.addEventListener('folio:flush-notes', onFlush);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('folio:flush-notes', onFlush); };
  }, [undo]);
  return { ...history, busy, editDocument, undo, refresh };
}
