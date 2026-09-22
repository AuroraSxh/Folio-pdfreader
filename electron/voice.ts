import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import type { VoiceCapabilities, VoiceErrorCode, VoiceEvent, VoiceListenOptions, VoiceService, VoiceSpeakOptions, VoiceSpeakSegment, VoiceQuality } from '../shared/voice';

export const MAX_VOICE_TEXT_BYTES = 128 * 1024;
export const MAX_VOICE_LINE_BYTES = 256 * 1024;
const MAX_VOICE_COMMAND_BYTES = 512 * 1024;
const ERROR_CODES = new Set<VoiceErrorCode>([
  'invalid-request', 'busy', 'unsupported', 'unsupported-locale', 'on-device-unavailable', 'recognizer-unavailable', 'needs-model-download', 'model-download-failed',
  'microphone-denied', 'speech-permission-denied', 'audio-unavailable', 'recognition-failed', 'voice-unavailable',
  'synthesis-failed', 'stale-session', 'cancelled', 'finalization-timeout', 'helper-unavailable', 'helper-exited',
  'timeout', 'protocol-error', 'disposed',
]);
const EVENT_TYPES = new Set<VoiceEvent['type']>(['partial', 'final', 'listening', 'speech-start', 'speech-end', 'error']);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VOICE_ID = /^com\.apple\.[A-Za-z0-9._-]{1,245}$/;

export class VoiceServiceError extends Error {
  constructor(readonly code: VoiceErrorCode) { super(`[${code}]`); this.name = 'VoiceServiceError'; }
}

export type VoiceSpawn = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export interface VoiceHost {
  helperPath: string;
  emit: (event: VoiceEvent) => void;
  platform?: NodeJS.Platform;
  spawn?: VoiceSpawn;
  commandTimeoutMs?: number;
  startupTimeoutMs?: number;
  modelDownloadTimeoutMs?: number;
  idleTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

type Command = 'capabilities' | 'listen' | 'stop-listening' | 'speak' | 'stop-speaking' | 'shutdown';
type Pending = { resolve: (value: unknown) => void; reject: (error: VoiceServiceError) => void; timer: ReturnType<typeof setTimeout> };
type Helper = {
  process: ChildProcessWithoutNullStreams;
  closing: boolean;
  closed: boolean;
  buffer: string;
  decoder: StringDecoder;
  pending: Map<string, Pending>;
  usedSessions: Set<string>;
  idleTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  forceTimer?: ReturnType<typeof setTimeout>;
  closeTimer?: ReturnType<typeof setTimeout>;
  exited: Promise<void>;
  finish: () => void;
};
type Job = {
  mode: 'listen' | 'speak';
  sessionId: string;
  phase: 'starting' | 'active' | 'stopping';
  helper?: Helper;
  lastText: string;
  cancelled: boolean;
  failed?: VoiceErrorCode;
  startupTimer?: ReturnType<typeof setTimeout>;
  startPromise: Promise<void>;
  stopPromise?: Promise<{ text: string }>;
  ready: Promise<Helper | undefined>;
  resolveReady: (helper?: Helper) => void;
};

function errorCode(value: unknown, fallback: VoiceErrorCode): VoiceErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value as VoiceErrorCode) ? value as VoiceErrorCode : fallback;
}
function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new VoiceServiceError('invalid-request');
  return value;
}
function locale(value: unknown, fromNative = false): string {
  const text = typeof value === 'string' && fromNative ? value.replaceAll('_', '-') : value;
  if (typeof text !== 'string' || text.length > 64 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(text)) throw new VoiceServiceError('invalid-request');
  try { return Intl.getCanonicalLocales(text)[0]; } catch { throw new VoiceServiceError('invalid-request'); }
}
function transcript(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_VOICE_TEXT_BYTES || value.includes('\0')) throw new VoiceServiceError('protocol-error');
  return value;
}
function noCapabilities(reason: VoiceErrorCode): VoiceCapabilities {
  return { available: false, engine: 'unsupported', reason, locales: [], voices: [] };
}
function capabilitiesResult(value: unknown): VoiceCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VoiceServiceError('protocol-error');
  const data = value as Record<string, unknown>;
  if (typeof data.available !== 'boolean' || !['speech-analyzer', 'speech-recognizer', 'unsupported'].includes(String(data.engine))
    || !Array.isArray(data.locales) || data.locales.length > 512 || !Array.isArray(data.voices) || data.voices.length > 1024
    || (data.needsModelDownload !== undefined && typeof data.needsModelDownload !== 'boolean')) throw new VoiceServiceError('protocol-error');
  try {
    const locales = [...new Set(data.locales.map(item => locale(item, true)))];
    const voices = data.voices.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new VoiceServiceError('protocol-error');
      const voice = item as Record<string, unknown>;
      if (typeof voice.id !== 'string' || !VOICE_ID.test(voice.id) || typeof voice.name !== 'string' || !voice.name.trim()
        || voice.name.length > 160 || /[\u0000-\u001f\u007f]/.test(voice.name)) throw new VoiceServiceError('protocol-error');
      if (voice.quality !== undefined && !['default', 'enhanced', 'premium'].includes(String(voice.quality))) throw new VoiceServiceError('protocol-error');
      return { id: voice.id, name: voice.name, language: locale(voice.language, true),
        ...(voice.quality === undefined ? {} : { quality: voice.quality as VoiceQuality }) };
    });
    return { available: data.available, engine: data.engine as VoiceCapabilities['engine'], locales, voices,
      ...(data.reason === undefined || data.reason === '' ? {} : { reason: errorCode(data.reason, 'unsupported') }),
      ...(data.needsModelDownload === undefined ? {} : { needsModelDownload: data.needsModelDownload as boolean }) };
  } catch { throw new VoiceServiceError('protocol-error'); }
}

/** A lazy, single-job supervisor. The helper alone owns Apple's permissions and audio APIs. */
export function createVoiceService(host: VoiceHost): VoiceService {
  const platform = host.platform ?? process.platform;
  const spawnProcess: VoiceSpawn = host.spawn ?? ((file, args, options) => nodeSpawn(file, args, options));
  const commandTimeout = host.commandTimeoutMs ?? 10_000;
  const startupTimeout = host.startupTimeoutMs ?? 120_000;
  const modelDownloadTimeout = host.modelDownloadTimeoutMs ?? 10 * 60_000;
  const idleTimeout = host.idleTimeoutMs ?? 2_000;
  const shutdownTimeout = host.shutdownTimeoutMs ?? 500;
  let helper: Helper | undefined, active: Job | undefined, disposed = false;
  let lastStopped: { sessionId: string; text: string } | undefined;
  const capabilityRequests = new Map<string, Promise<VoiceCapabilities>>();
  const emit = (event: VoiceEvent) => { if (!disposed) { try { host.emit(event); } catch { /* A closing renderer must not keep the microphone alive. */ } } };

  function scheduleIdle(record = helper): void {
    if (!record || record.closing || record.closed) return;
    clearTimeout(record.idleTimer); record.idleTimer = undefined;
    if (record.pending.size || active) return;
    record.idleTimer = setTimeout(() => {
      if (!record.pending.size && !active) void retire(record, 'cancelled', false, true);
    }, idleTimeout);
  }
  function endJob(job: Job): void {
    clearTimeout(job.startupTimer); job.startupTimer = undefined;
    if (active === job) active = undefined;
    scheduleIdle(job.helper);
  }
  function failJob(job: Job, code: VoiceErrorCode): void {
    if (!job.failed && !job.cancelled && job.phase !== 'stopping') {
      job.failed = code;
      emit({ type: 'error', sessionId: job.sessionId, code });
    }
    endJob(job);
  }

  function retire(record: Helper, code: VoiceErrorCode, notify = true, graceful = false): Promise<void> {
    if (record.closed || record.closing) return record.exited;
    record.closing = true;
    clearTimeout(record.idleTimer);
    for (const pending of record.pending.values()) { clearTimeout(pending.timer); pending.reject(new VoiceServiceError(code)); }
    record.pending.clear();
    if (active?.helper === record) {
      if (notify) failJob(active, code); else endJob(active);
    }
    const signal = (kind: NodeJS.Signals) => { try { record.process.kill(kind); } catch { /* Spawn failures may never have a PID. */ } };
    const force = () => {
      if (record.closed) return;
      signal('SIGKILL');
      record.closeTimer = setTimeout(record.finish, shutdownTimeout);
    };
    if (graceful) {
      try { record.process.stdin.end(`${JSON.stringify({ id: randomUUID(), command: 'shutdown' })}\n`); } catch { /* Escalate below. */ }
      record.killTimer = setTimeout(() => { if (!record.closed) { signal('SIGTERM'); record.forceTimer = setTimeout(force, shutdownTimeout); } }, shutdownTimeout);
    } else { signal('SIGTERM'); record.forceTimer = setTimeout(force, shutdownTimeout); }
    return record.exited;
  }

  function handleMessage(record: Helper, value: unknown): void {
    if (record.closing || record.closed || helper !== record || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.event === true) {
      const job = active;
      if (!job || job.helper !== record || job.phase === 'stopping' || job.cancelled || message.sessionId !== job.sessionId
        || !EVENT_TYPES.has(message.type as VoiceEvent['type'])) return;
      const type = message.type as VoiceEvent['type'];
      const eventCode = typeof message.code === 'string' && ERROR_CODES.has(message.code as VoiceErrorCode) ? { code: message.code } : {};
      if (type === 'error') { failJob(job, errorCode(message.code, job.mode === 'listen' ? 'recognition-failed' : 'synthesis-failed')); return; }
      if ((job.mode === 'listen' && (type === 'speech-start' || type === 'speech-end'))
        || (job.mode === 'speak' && (type === 'listening' || type === 'partial' || type === 'final'))) return;
      clearTimeout(job.startupTimer); job.startupTimer = undefined;
      job.phase = 'active';
      if (type === 'partial' || type === 'final') {
        let text: string;
        try { text = transcript(message.text); } catch { void retire(record, 'protocol-error'); return; }
        job.lastText = text;
        emit({ sessionId: job.sessionId, type, text, ...eventCode });
      } else {
        if (type === 'speech-end') endJob(job);
        emit({ sessionId: job.sessionId, type, ...eventCode });
      }
      return;
    }
    if (typeof message.id !== 'string') return;
    const pending = record.pending.get(message.id);
    if (!pending) return;
    if (typeof message.ok !== 'boolean') { void retire(record, 'protocol-error'); return; }
    clearTimeout(pending.timer); record.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new VoiceServiceError(errorCode(message.code, 'protocol-error')));
    scheduleIdle(record);
  }

  async function ensureHelper(): Promise<Helper> {
    if (disposed) throw new VoiceServiceError('disposed');
    if (platform !== 'darwin') throw new VoiceServiceError('unsupported');
    while (helper?.closing) { await helper.exited; if (disposed) throw new VoiceServiceError('disposed'); }
    if (helper && !helper.closed) { clearTimeout(helper.idleTimer); helper.idleTimer = undefined; return helper; }
    if (!path.isAbsolute(host.helperPath) || host.helperPath.includes('\0') || host.helperPath.length > 4096) throw new VoiceServiceError('helper-unavailable');
    let child: ChildProcessWithoutNullStreams;
    try {
      // The helper needs local OS context, not inherited API credentials or arbitrary shell setup.
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['HOME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']) if (process.env[key] !== undefined) env[key] = process.env[key];
      child = spawnProcess(host.helperPath, [], { shell: false, windowsHide: true, stdio: 'pipe', env });
    } catch { throw new VoiceServiceError('helper-unavailable'); }
    let resolveExit!: () => void;
    const record: Helper = { process: child, closing: false, closed: false, buffer: '', decoder: new StringDecoder('utf8'), pending: new Map(), usedSessions: new Set(), exited: new Promise(resolve => { resolveExit = resolve; }), finish: () => {} };
    helper = record;
    record.finish = () => {
      if (record.closed) return;
      record.closed = true;
      clearTimeout(record.idleTimer); clearTimeout(record.killTimer); clearTimeout(record.forceTimer); clearTimeout(record.closeTimer);
      for (const pending of record.pending.values()) { clearTimeout(pending.timer); pending.reject(new VoiceServiceError('helper-exited')); }
      record.pending.clear(); record.usedSessions.clear(); record.buffer = '';
      if (active?.helper === record) failJob(active, 'helper-exited');
      if (helper === record) helper = undefined;
      child.stdout.removeAllListeners('data');
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      resolveExit();
    };
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (record.closing || record.closed) return;
      record.buffer += record.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      let newline: number;
      while ((newline = record.buffer.indexOf('\n')) !== -1) {
        const line = record.buffer.slice(0, newline); record.buffer = record.buffer.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > MAX_VOICE_LINE_BYTES) { void retire(record, 'protocol-error'); return; }
        if (!line.trim()) continue;
        try { handleMessage(record, JSON.parse(line)); } catch { void retire(record, 'protocol-error'); return; }
        if (record.closing || record.closed) return;
      }
      if (Buffer.byteLength(record.buffer, 'utf8') > MAX_VOICE_LINE_BYTES) void retire(record, 'protocol-error');
    });
    child.stderr.resume(); // Native diagnostics are deliberately discarded, never logged or sent to the renderer.
    child.on('error', () => { void retire(record, 'helper-unavailable'); });
    child.once('close', record.finish);
    child.stdin.on('error', () => { if (!record.closing && !record.closed) void retire(record, 'helper-exited'); });
    child.stdout.on('error', () => { if (!record.closing && !record.closed) void retire(record, 'helper-exited'); });
    child.stderr.on('error', () => {});
    return record;
  }

  function command(record: Helper, type: Command, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (disposed) return Promise.reject(new VoiceServiceError('disposed'));
    if (record.closing || record.closed) return Promise.reject(new VoiceServiceError('helper-exited'));
    if (record.pending.size >= 16) return Promise.reject(new VoiceServiceError('busy'));
    const id = randomUUID(), payload = `${JSON.stringify({ id, command: type, ...fields })}\n`;
    if (Buffer.byteLength(payload, 'utf8') > MAX_VOICE_COMMAND_BYTES) return Promise.reject(new VoiceServiceError('invalid-request'));
    clearTimeout(record.idleTimer); record.idleTimer = undefined;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void retire(record, 'timeout'); }, commandTimeout);
      record.pending.set(id, { resolve, reject, timer });
      try {
        record.process.stdin.write(payload, error => { if (error && !record.closing && !record.closed) void retire(record, 'helper-exited'); });
      } catch { void retire(record, 'helper-exited'); }
    });
  }

  function start(mode: Job['mode'], fields: VoiceListenOptions | VoiceSpeakOptions): Promise<void> {
    if (disposed) return Promise.reject(new VoiceServiceError('disposed'));
    if (platform !== 'darwin') return Promise.reject(new VoiceServiceError('unsupported'));
    if (active) return active.mode === mode && active.sessionId === fields.sessionId && active.phase !== 'stopping' ? active.startPromise : Promise.reject(new VoiceServiceError('busy'));
    let resolveReady!: Job['resolveReady'];
    const job: Job = { mode, sessionId: fields.sessionId, phase: 'starting', lastText: '', cancelled: false, startPromise: Promise.resolve(), ready: new Promise(resolve => { resolveReady = resolve; }), resolveReady: value => resolveReady(value) };
    active = job; lastStopped = undefined;
    job.startPromise = (async () => {
      try {
        const record = await ensureHelper();
        if (job.cancelled || disposed) { job.resolveReady(); throw new VoiceServiceError(disposed ? 'disposed' : 'cancelled'); }
        if (record.usedSessions.has(job.sessionId)) throw new VoiceServiceError('stale-session');
        // Reset the idle helper before session IDs can grow without bound.
        if (record.usedSessions.size >= 4096) throw new VoiceServiceError('busy');
        record.usedSessions.add(job.sessionId);
        job.helper = record; job.resolveReady(record);
        job.startupTimer = setTimeout(() => { if (active === job && job.phase === 'starting') void retire(record, 'timeout'); }, mode === 'listen' && (fields as VoiceListenOptions).allowModelDownload ? modelDownloadTimeout : startupTimeout);
        await command(record, mode, { ...fields });
        if (job.cancelled) throw new VoiceServiceError('cancelled');
        if (job.failed) throw new VoiceServiceError(job.failed);
      } catch (error) {
        job.resolveReady();
        const code = job.cancelled ? 'cancelled' : error instanceof VoiceServiceError ? error.code : 'helper-unavailable';
        if (job.phase !== 'stopping') failJob(job, code);
        throw new VoiceServiceError(code);
      }
    })();
    void job.startPromise.catch(() => {});
    return job.startPromise;
  }

  async function stop(job: Job): Promise<{ text: string }> {
    if (job.stopPromise) return job.stopPromise;
    job.cancelled = true; job.phase = 'stopping'; clearTimeout(job.startupTimer);
    job.stopPromise = (async () => {
      let record = job.helper;
      try {
        record ??= await job.ready;
        if (!record || record.closing || record.closed || disposed) return { text: job.lastText };
        const result = await command(record, job.mode === 'listen' ? 'stop-listening' : 'stop-speaking', { sessionId: job.sessionId });
        if (job.mode === 'speak') return { text: '' };
        try {
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new VoiceServiceError('protocol-error');
          const text = transcript((result as Record<string, unknown>).text) || job.lastText;
          lastStopped = { sessionId: job.sessionId, text };
          return { text };
        } catch { void retire(record, 'protocol-error'); throw new VoiceServiceError('protocol-error'); }
      } catch (error) {
        const code = error instanceof VoiceServiceError ? error.code : 'helper-exited';
        // A failed stop must not leave a native audio task alive after the UI has
        // released its session. Wait for bounded termination before allowing reuse.
        if (record) await retire(record, code, false);
        throw new VoiceServiceError(code);
      } finally { endJob(job); }
    })();
    return job.stopPromise;
  }

  return {
    capabilities(requestedLocale) {
      if (disposed) return Promise.resolve(noCapabilities('disposed'));
      if (platform !== 'darwin') return Promise.resolve(noCapabilities('unsupported'));
      let normalized: string | undefined;
      try { normalized = requestedLocale === undefined ? undefined : locale(requestedLocale); } catch { return Promise.resolve(noCapabilities('invalid-request')); }
      const key = normalized ?? '';
      const existing = capabilityRequests.get(key); if (existing) return existing;
      const query = (async () => {
        let record: Helper | undefined;
        try {
          record = await ensureHelper();
          const raw = await command(record, 'capabilities', normalized ? { locale: normalized } : {});
          try { return capabilitiesResult(raw); } catch { void retire(record, 'protocol-error'); throw new VoiceServiceError('protocol-error'); }
        } catch (error) { return noCapabilities(error instanceof VoiceServiceError ? error.code : 'helper-unavailable'); }
        finally { capabilityRequests.delete(key); scheduleIdle(record); }
      })();
      capabilityRequests.set(key, query);
      return query;
    },
    listen(options) {
      try {
        if (!options || typeof options !== 'object' || (options.allowModelDownload !== undefined && typeof options.allowModelDownload !== 'boolean')) throw new VoiceServiceError('invalid-request');
        return start('listen', { sessionId: sessionId(options.sessionId), locale: locale(options.locale), ...(options.allowModelDownload === undefined ? {} : { allowModelDownload: options.allowModelDownload }) });
      } catch { return Promise.reject(new VoiceServiceError('invalid-request')); }
    },
    stopListening(id) {
      try { sessionId(id); } catch { return Promise.reject(new VoiceServiceError('invalid-request')); }
      if (!active || active.mode !== 'listen' || active.sessionId !== id) return Promise.resolve({ text: lastStopped?.sessionId === id ? lastStopped.text : '' });
      return stop(active);
    },
    speak(options) {
      try {
        if (!options || typeof options !== 'object' || typeof options.text !== 'string' || !options.text.trim() || options.text.includes('\0')
          || Buffer.byteLength(options.text, 'utf8') > MAX_VOICE_TEXT_BYTES || (options.voiceId !== undefined && (typeof options.voiceId !== 'string' || !VOICE_ID.test(options.voiceId)))
          || (options.rate !== undefined && (typeof options.rate !== 'number' || !Number.isFinite(options.rate) || options.rate < 0.1 || options.rate > 1))) throw new VoiceServiceError('invalid-request');
        let segments: VoiceSpeakSegment[] | undefined;
        if (options.segments !== undefined) {
          if (!Array.isArray(options.segments) || !options.segments.length || options.segments.length > 256) throw new VoiceServiceError('invalid-request');
          let bytes = 0;
          segments = options.segments.map(segment => {
            if (!segment || typeof segment !== 'object' || Array.isArray(segment)
              || typeof segment.text !== 'string' || !segment.text.trim() || segment.text.includes('\0')
              || (segment.voiceId !== undefined && (typeof segment.voiceId !== 'string' || !VOICE_ID.test(segment.voiceId)))
              || (segment.pauseAfter !== undefined && (typeof segment.pauseAfter !== 'number' || !Number.isFinite(segment.pauseAfter) || segment.pauseAfter < 0 || segment.pauseAfter > 0.5))) throw new VoiceServiceError('invalid-request');
            bytes += Buffer.byteLength(segment.text, 'utf8');
            if (bytes > MAX_VOICE_TEXT_BYTES) throw new VoiceServiceError('invalid-request');
            return { text: segment.text, locale: locale(segment.locale),
              ...(segment.voiceId === undefined ? {} : { voiceId: segment.voiceId }),
              ...(segment.pauseAfter === undefined ? {} : { pauseAfter: segment.pauseAfter }) };
          });
          if (segments.map(segment => segment.text).join('') !== options.text) throw new VoiceServiceError('invalid-request');
        }
        return start('speak', { sessionId: sessionId(options.sessionId), text: options.text, locale: locale(options.locale),
          ...(options.voiceId === undefined ? {} : { voiceId: options.voiceId }), ...(options.rate === undefined ? {} : { rate: options.rate }),
          ...(segments === undefined ? {} : { segments }) });
      } catch { return Promise.reject(new VoiceServiceError('invalid-request')); }
    },
    async stopSpeaking() { if (active?.mode === 'speak') await stop(active); },
    async dispose() {
      disposed = true;
      if (active) { active.cancelled = true; active.resolveReady(); endJob(active); }
      lastStopped = undefined;
      if (helper) await retire(helper, 'disposed', false, true);
      capabilityRequests.clear();
    },
  };
}
