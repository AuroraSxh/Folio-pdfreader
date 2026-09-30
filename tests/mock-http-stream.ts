import type { IncomingMessage, ServerResponse } from 'node:http';

type Handler = (body: any, response: ServerResponse, request: IncomingMessage) => void | Promise<void>;
interface MockEndpoint { handler: Handler; pending: Set<(reason: unknown) => void> }
const endpoints = new Map<string, MockEndpoint>();
let originalFetch: typeof fetch | undefined;
let nextPort = 19000;

/** A transport-only test double: real Fetch Response/ReadableStream objects,
 * with the small Node response surface already used by our SSE fixtures.
 * No listener, socket, or external network is needed. */
async function dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const endpoint = endpoints.get(url.origin);
  if (!endpoint) {
    if (!originalFetch) throw new Error('No fetch implementation is installed for this test request.');
    return originalFetch(input, init);
  }
  const request = new Request(input, init);
  request.signal.throwIfAborted();
  const raw = await request.text();
  request.signal.throwIfAborted();
  const headers = new Headers();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let resolveHeaders!: (value: Response) => void, rejectHeaders!: (reason: unknown) => void;
  let sent = false, ended = false, cancelled = false;
  const received = new Promise<Response>((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
  const cleanup = () => { request.signal.removeEventListener('abort', onAbort); endpoint.pending.delete(abort); };
  const abort = (reason: unknown) => {
    if (cancelled) return;
    cancelled = true;
    cleanup();
    controller.error(reason);
    if (!sent) rejectHeaders(reason);
  };
  const onAbort = () => abort(request.signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cancelled = true; cleanup(); },
  });
  const publish = () => {
    if (sent || cancelled) return;
    const response = new Response([204, 205, 304].includes(reply.statusCode) ? null : stream, { status: reply.statusCode, headers });
    sent = true;
    resolveHeaders(response);
  };
  const write = (chunk: string | Uint8Array) => {
    if (ended || cancelled) return false;
    publish();
    controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
    return true;
  };
  const reply = {
    statusCode: 200,
    get headersSent() { return sent; },
    get writableEnded() { return ended; },
    get destroyed() { return cancelled; },
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name, Array.isArray(value) ? value.join(', ') : String(value)); return this;
    },
    getHeader(name: string) { return headers.get(name) ?? undefined; },
    writeHead(status: number, values: Record<string, string | number | readonly string[]> = {}) {
      if (cancelled) return this;
      this.statusCode = status;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
      return this;
    },
    flushHeaders() { if (!cancelled) publish(); },
    write,
    end(chunk?: string | Uint8Array) {
      if (ended || cancelled) return this;
      if (chunk !== undefined) write(chunk);
      publish(); ended = true; controller.close();
      return this;
    },
    destroy(error?: Error) { abort(error ?? new Error('The mock response was destroyed.')); return this; },
  };
  endpoint.pending.add(abort);
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  if (!cancelled) {
    const nodeRequest = { url: url.pathname + url.search, method: request.method,
      headers: Object.fromEntries(request.headers.entries()) } as IncomingMessage;
    // Deliberately expose only the fixture-used methods; application code sees
    // a standards-compliant Fetch response and its unchanged SSE parser.
    void Promise.resolve().then(() => endpoint.handler(JSON.parse(raw), reply as unknown as ServerResponse, nodeRequest))
      .catch(error => { if (!cancelled && !ended) { reply.statusCode = 500; reply.end(String(error)); } });
  }
  return received;
}

export async function mock(handler: Handler): Promise<{ url: string; close: () => void }> {
  if (!endpoints.size) { originalFetch = globalThis.fetch; globalThis.fetch = dispatch as typeof fetch; }
  const url = `http://127.0.0.1:${nextPort++}`;
  const endpoint: MockEndpoint = { handler, pending: new Set() };
  endpoints.set(url, endpoint);
  let closed = false;
  return { url, close() {
    if (closed) return;
    closed = true;
    for (const abort of [...endpoint.pending]) abort(new DOMException('The mock endpoint was closed.', 'AbortError'));
    endpoints.delete(url);
    if (!endpoints.size && originalFetch) { globalThis.fetch = originalFetch; originalFetch = undefined; }
  } };
}
