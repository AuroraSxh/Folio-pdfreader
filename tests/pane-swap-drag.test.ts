import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANE_SWAP_MIME, canDropPaneSwap, isPaneSwapTransfer, matchesPaneSwapSession, parsePaneSwapSession,
  type PaneSwapSession,
} from '../src/hooks/paneSwapDrag';

const session: PaneSwapSession = {
  version: 1, workspaceId: 'paper-1', identity: '["main","supplement"]', from: 'left', token: 'local-drag-token',
};
const context = { workspaceId: 'paper-1', identity: session.identity, split: true };

test('pane drag data round-trips and requires the custom MIME type', () => {
  assert.deepEqual(parsePaneSwapSession(JSON.stringify(session)), session);
  assert.equal(isPaneSwapTransfer({ types: [PANE_SWAP_MIME] }), true);
  assert.equal(isPaneSwapTransfer({ types: ['Files', 'text/plain'] }), false);
  assert.equal(isPaneSwapTransfer({ types: ['text/html', 'text/plain'] }), false);
});

test('only the other pane of the original visible pair accepts the drag', () => {
  assert.equal(canDropPaneSwap(session, context, 'right'), true);
  assert.equal(canDropPaneSwap(session, context, 'left'), false);
  assert.equal(canDropPaneSwap(session, { ...context, workspaceId: 'paper-2' }, 'right'), false);
  assert.equal(canDropPaneSwap(session, { ...context, identity: '["main","other"]' }, 'right'), false);
  assert.equal(canDropPaneSwap(session, { ...context, split: false }, 'right'), false);
  assert.equal(canDropPaneSwap(session, { ...context, disabled: true }, 'right'), false);
  assert.equal(canDropPaneSwap(session, { ...context, workspaceId: undefined }, 'right'), false);
  assert.equal(canDropPaneSwap(null, context, 'right'), false);
});

test('identical PDFs can exchange separate pane views in either direction', () => {
  const sameDocument = { ...session, identity: '["main","main"]' };
  const samePair = { ...context, identity: sameDocument.identity };
  assert.equal(canDropPaneSwap(sameDocument, samePair, 'right'), true);
  assert.equal(canDropPaneSwap({ ...sameDocument, from: 'right' }, samePair, 'left'), true);
});

test('cancelled, replayed, fabricated, and mismatched drag sessions are rejected', () => {
  assert.equal(matchesPaneSwapSession(session, { ...session }), true);
  assert.equal(matchesPaneSwapSession(session, null), false);
  assert.equal(matchesPaneSwapSession(null, session), false);
  for (const changed of [
    { token: 'previous-drag' }, { workspaceId: 'other-paper' }, { identity: 'other-pair' }, { from: 'right' as const },
  ]) assert.equal(matchesPaneSwapSession({ ...session, ...changed }, session), false);
});

test('malformed and oversize drag data never becomes a pane swap', () => {
  for (const raw of ['', 'null', '[]', 'bad-json', '{}', 'x'.repeat(8_193)]) {
    assert.equal(parsePaneSwapSession(raw), null);
  }
  for (const changed of [
    { version: 2 }, { from: 'center' }, { workspaceId: '' }, { workspaceId: 12 },
    { identity: '' }, { identity: 'x'.repeat(4_097) }, { token: null }, { token: 'x'.repeat(257) },
  ]) assert.equal(parsePaneSwapSession(JSON.stringify({ ...session, ...changed })), null);
});
