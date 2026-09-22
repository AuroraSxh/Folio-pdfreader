import { useEffect, useRef } from 'react';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import type { DocumentIndex, PaperDocument, Workspace } from '../../shared/types';
import { hasPdfIndex, loadPdf, readSharedPdfIndex } from './documentIndex';

function visibleDocuments(workspace: Workspace): Set<string> {
  const left = workspace.documents.find(doc => doc.id === workspace.layout.leftId) ?? workspace.documents[0];
  const right = workspace.documents.find(doc => doc.id === workspace.layout.rightId) ?? workspace.documents[1] ?? left;
  return new Set([left?.id, workspace.layout.split ? right?.id : undefined].filter((id): id is string => !!id));
}

type IndexSession = {
  workspaceId: string;
  cancelled: boolean;
  running: boolean;
  activeId?: string;
  loadingTask?: PDFDocumentLoadingTask;
  pump: () => Promise<void>;
};

/** Prepare hidden supplements without resetting the queue when notes or chat change. */
export default function useBackgroundIndex(
  workspace: Workspace | undefined,
  onIndexed: (workspaceId: string, documentId: string, index: DocumentIndex) => Promise<void>,
  onError: (message: string) => void,
) {
  const latest = useRef({ workspace, onIndexed, onError });
  latest.current = { workspace, onIndexed, onError };
  const session = useRef<IndexSession | null>(null);
  // Includes completed and failed documents. Visible PdfPane can still retry/unlock failures.
  const attempted = useRef(new Set<string>());
  const warned = useRef(new Set<string>());
  const workspaceId = workspace?.id;
  const signature = workspace ? `${workspace.layout.split}:${workspace.layout.leftId}:${workspace.layout.rightId}:${workspace.documents.map(doc => `${doc.id}:${doc.textStatus || ''}`).join(',')}` : '';

  useEffect(() => {
    if (!workspaceId) return;
    const worker: IndexSession = { workspaceId, cancelled: false, running: false, pump: async () => {} };
    session.current = worker;
    const currentWorkspace = () => !worker.cancelled && latest.current.workspace?.id === workspaceId ? latest.current.workspace : undefined;
    const eligible = (doc: PaperDocument, current: Workspace) => !hasPdfIndex(doc) && !visibleDocuments(current).has(doc.id) && !attempted.current.has(`${workspaceId}:${doc.id}`);
    const notifyOnce = (key: string, message: string) => {
      if (!currentWorkspace() || warned.current.has(key)) return;
      warned.current.add(key);
      latest.current.onError(message);
    };
    worker.pump = async () => {
      if (worker.running || !currentWorkspace()) return;
      worker.running = true;
      try {
        while (true) {
          const current = currentWorkspace();
          const doc = current?.documents.find(item => eligible(item, current));
          if (!current || !doc) break;
          const key = `${workspaceId}:${doc.id}`;
          worker.activeId = doc.id;
          const stillHidden = () => {
            const now = currentWorkspace();
            return !!now && now.documents.some(item => item.id === doc.id && !hasPdfIndex(item)) && !visibleDocuments(now).has(doc.id);
          };
          try {
            const bytes = await window.folio.readDocument(workspaceId, doc.id);
            if (!stillHidden()) continue;
            const task = loadPdf(bytes);
            worker.loadingTask = task;
            // Supplying no password callback lets PDF.js reject immediately; no hidden dialog.
            const pdf = await task.promise;
            if (!stillHidden()) continue;
            const index = await readSharedPdfIndex(key, pdf, {
              outline: doc.outlineLoaded ? doc.outline : undefined,
              isCancelled: () => !stillHidden(),
            });
            if (!stillHidden()) continue;
            // Capture the callback before awaiting; its explicit IDs keep saves scoped correctly.
            await latest.current.onIndexed(workspaceId, doc.id, index);
            attempted.current.add(key);
          } catch (error) {
            if (!currentWorkspace()) break;
            const failure = error as { name?: string; message?: string };
            if (failure.name === 'PasswordException') {
              attempted.current.add(key);
              notifyOnce(key, `“${doc.name}”已加密，暂未加入 AI 文章索引。请先在阅读区打开该 PDF 并输入密码。`);
            } else if (stillHidden() && failure.name !== 'AbortError') {
              attempted.current.add(key);
              notifyOnce(key, `“${doc.name}”的文章索引未完成：${failure.message || String(error)}。请在阅读区打开此 PDF 重试。`);
            }
          } finally {
            const task = worker.loadingTask;
            worker.loadingTask = undefined;
            worker.activeId = undefined;
            // Always release workers, fonts, and decoded page resources between documents.
            if (task) await task.destroy().catch(() => {});
          }
        }
      } finally {
        worker.running = false;
      }
    };
    void worker.pump();
    return () => {
      worker.cancelled = true;
      void worker.loadingTask?.destroy().catch(() => {});
      if (session.current === worker) session.current = null;
    };
  }, [workspaceId]);

  useEffect(() => {
    const worker = session.current;
    if (!worker || worker.workspaceId !== workspaceId) return;
    const current = latest.current.workspace;
    if (current && worker.activeId && (visibleDocuments(current).has(worker.activeId) || !current.documents.some(doc => doc.id === worker.activeId))) {
      // The foreground pane takes over as soon as this document is opened.
      void worker.loadingTask?.destroy().catch(() => {});
    }
    void worker.pump();
  }, [workspaceId, signature]);
}
