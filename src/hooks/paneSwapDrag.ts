export type PaneSide = 'left' | 'right';

export const PANE_SWAP_MIME = 'application/x-pairleaf-pane-swap';

export interface PaneSwapSession {
  version: 1;
  workspaceId: string;
  identity: string;
  from: PaneSide;
  token: string;
}

export interface PaneSwapContext {
  workspaceId?: string;
  identity: string;
  split: boolean;
  disabled?: boolean;
}

export function isPaneSwapTransfer(transfer: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(transfer.types).includes(PANE_SWAP_MIME);
}

export function parsePaneSwapSession(raw: string): PaneSwapSession | null {
  if (!raw || raw.length > 8_192) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (item.version !== 1 || (item.from !== 'left' && item.from !== 'right')) return null;
    if (typeof item.workspaceId !== 'string' || !item.workspaceId || item.workspaceId.length > 256) return null;
    if (typeof item.identity !== 'string' || !item.identity || item.identity.length > 4_096) return null;
    if (typeof item.token !== 'string' || !item.token || item.token.length > 256) return null;
    return { version: 1, workspaceId: item.workspaceId, identity: item.identity, from: item.from, token: item.token };
  } catch {
    return null;
  }
}

/** A drop only exchanges the pair that was visible when this local drag began. */
export function canDropPaneSwap(session: PaneSwapSession | null, context: PaneSwapContext, target: PaneSide): boolean {
  return Boolean(session && context.split && !context.disabled && context.workspaceId
    && session.workspaceId === context.workspaceId && session.identity === context.identity && session.from !== target);
}

export function matchesPaneSwapSession(payload: PaneSwapSession | null, active: PaneSwapSession | null): boolean {
  return Boolean(payload && active && payload.version === active.version && payload.token === active.token
    && payload.workspaceId === active.workspaceId && payload.identity === active.identity && payload.from === active.from);
}
