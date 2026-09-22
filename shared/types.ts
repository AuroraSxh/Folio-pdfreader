export type ProviderId = 'deepseek' | 'openai' | 'anthropic' | 'custom';
export interface ProviderConfig { id: ProviderId; apiKey?: string; hasKey?: boolean; baseURL: string; model: string; maxTokens: number; thinking?: boolean; reasoningEffort?: 'low'|'high'|'max' }
export interface Settings {
  language: import('./i18n').Language;
  autoCheckUpdates: boolean;
  activeProvider: ProviderId; providers: Record<ProviderId, ProviderConfig>;
  libraryPath: string; vaultPath: string; obsidianSubfolder: string;
  autoSummary: boolean; autoMemory: boolean; contextMaxChars: number;
  theme: 'light' | 'dark'; readingTheme: 'white' | 'sepia' | 'dark';
  annotationToolbar: 'floating' | 'fixed' | 'selection';
}
export interface OutlineItem { id: string; title: string; page: number; children: OutlineItem[] }
export interface ViewState { page: number; scale: string; rotation: number; scrollMode: number; spreadMode: number }
export interface Annotation {
  id: string; page: number; text: string; comment: string; color: string;
  /** Older saved annotations omit kind and are highlights. */
  kind?: 'highlight' | 'underline' | 'strikeout';
  /** Rectangles in PDF user space, [x1,y1,x2,y2]. */
  rects: number[][]; createdAt: number;
}
export interface PaperDocument {
  id: string; name: string; fileName: string; role: 'main' | 'supplement';
  size: number; pageCount: number; outline: OutlineItem[]; outlineLoaded: boolean;
  annotations: Annotation[]; view: ViewState; textStatus?: 'ready' | 'empty';
}
export type MemoryType = 'finding' | 'interpretation' | 'question' | 'user-note' | 'cross-ref';
export interface Memory { id: string; type: MemoryType; title: string; body: string; tags: string[]; createdAt: number; source: 'ai' | 'user' }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: number; provider?: string; model?: string; interrupted?: boolean }
export interface Conversation { id: string; title: string; createdAt: number; messages: ChatMessage[] }
export interface Summary { content: string; provider: string; model: string; createdAt: number }
export interface Workspace {
  version: 1; id: string; title: string; authors: string; journal: string; doi: string; tags: string[];
  favorite: boolean; createdAt: number; updatedAt: number; lastReadAt: number;
  documents: PaperDocument[]; notes: string; summary?: Summary; memories: Memory[]; memoryIndex: string;
  conversations: Conversation[]; activeConversationId: string;
  layout: { split: boolean; direction?: 'vertical'|'horizontal'; leftId: string; rightId: string; ratio: number; views?: Partial<Record<'left'|'right',{documentId:string; state:ViewState}>> };
}
export interface TextSelection { documentId: string; documentName: string; page: number; text: string; rects: number[][] }
export interface DocumentIndex { pageCount: number; outline: OutlineItem[]; title?: string; authors?: string; pages: string[] }
export interface ChatRequest { requestId: string; workspaceId: string; conversationId: string; prompt: string; kind: 'chat' | 'summary'; documentIds: string[]; selection?: TextSelection }
export interface ChatEvent { requestId: string; workspaceId: string; type: 'delta' | 'done' | 'error' | 'memory' | 'status'; text?: string; workspace?: Workspace; interrupted?: boolean }
export interface ExportResult { path: string; overwritten?: boolean }
export interface RemovedWorkspace { id: string; title: string; authors: string; tags: string[]; documentCount: number; removedAt: number }
export interface DocumentEditHistory { canUndo: boolean; canRedo: boolean }
export interface Bootstrap { settings: Settings; workspaces: Workspace[]; removedWorkspaces: RemovedWorkspace[]; version: string }
export interface FolioAPI {
  readonly platform: 'darwin' | 'win32' | 'linux';
  bootstrap(): Promise<Bootstrap>;
  createWorkspace(paths?: string[]): Promise<Workspace | null>;
  importDocuments(workspaceId: string, paths?: string[]): Promise<Workspace | null>;
  createDemo(): Promise<Workspace>;
  updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'title'|'authors'|'journal'|'doi'|'tags'|'favorite'|'notes'|'layout'|'activeConversationId'|'lastReadAt'>>): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<void>;
  listRemovedWorkspaces(): Promise<RemovedWorkspace[]>;
  restoreWorkspace(id: string): Promise<Workspace>;
  purgeWorkspace(id: string): Promise<boolean>;
  copyText(text: string): Promise<void>;
  updateDocument(workspaceId: string, documentId: string, patch: Partial<Pick<PaperDocument, 'name'|'role'|'outline'|'annotations'|'view'>>): Promise<Workspace>;
  undoDocumentEdit(workspaceId: string, direction: 'undo'|'redo'): Promise<Workspace>;
  getDocumentEditHistory(workspaceId: string): Promise<DocumentEditHistory>;
  nativeEdit(action: 'undo'|'redo'): Promise<void>;
  updateView(workspaceId:string,documentId:string,pane:'left'|'right',view:ViewState):Promise<Workspace>;
  removeDocument(workspaceId: string, documentId: string): Promise<Workspace>;
  readDocument(workspaceId: string, documentId: string): Promise<Uint8Array>;
  indexDocument(workspaceId: string, documentId: string, index: DocumentIndex): Promise<Workspace>;
  exportPdf(workspaceId: string, documentId: string): Promise<ExportResult | null>;
  printPdf(workspaceId: string, documentId: string): Promise<void>;
  revealWorkspace(id: string): Promise<void>;
  saveSettings(settings: Settings): Promise<Settings>;
  getUpdateStatus(): Promise<import('./updates').UpdateStatus>;
  checkForUpdates(): Promise<import('./updates').UpdateStatus>;
  downloadUpdate(): Promise<import('./updates').UpdateStatus>;
  cancelUpdate(): Promise<import('./updates').UpdateStatus>;
  installUpdate(): Promise<void>;
  onUpdate(callback: (status: import('./updates').UpdateStatus) => void): () => void;
  pickFolder(kind: 'vault'): Promise<string | null>;
  startChat(request: ChatRequest): Promise<void>;
  abortChat(requestId: string): Promise<void>;
  newConversation(workspaceId: string): Promise<Workspace>;
  deleteMemory(workspaceId: string, memoryId: string): Promise<Workspace>;
  exportMarkdown(workspaceId: string, target: 'file'|'obsidian'): Promise<ExportResult | null>;
  backup(): Promise<ExportResult | null>;
  restore(): Promise<{ count: number } | null>;
  importLegacy(): Promise<{ count: number } | null>;
  openExternal(url: string): Promise<void>;
  openObsidian(): Promise<void>;
  pathForFile(file: File): string;
  onChat(callback: (event: ChatEvent) => void): () => void;
  onOpen(callback: (workspace: Workspace) => void): () => void;
  onCommand(callback: (command: string) => void): () => void;
  onPrepareClose(callback: () => Promise<void>): () => void;
}
export const DEFAULT_VIEW: ViewState = { page: 1, scale: 'page-width', rotation: 0, scrollMode: 0, spreadMode: 0 };
export const MEMORY_LABELS: Record<MemoryType, string> = { finding: '研究发现', interpretation: '分析解读', question: '待解问题', 'user-note': '个人关注', 'cross-ref': '跨文关联' };
