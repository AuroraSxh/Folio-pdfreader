// Mirrored panes replace the same persisted annotations array. Permit one write
// per document until the parent has received its saved state; unrelated PDFs stay usable.
const writes = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export const isAnnotationSaving = (key: string) => writes.has(key);
export const subscribeAnnotationWrites = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function beginAnnotationWrite(key: string, write: () => void | Promise<void>): boolean {
  if (writes.has(key)) return false;
  const request = Promise.resolve().then(write);
  writes.set(key, request);
  notify();
  const finish = () => { if (writes.get(key) === request) writes.delete(key); notify(); };
  // The parent reports errors. Release the lock on failure without showing an
  // optimistic mark or leaking an unhandled rejection from a UI event callback.
  void request.then(finish, finish);
  return true;
}
