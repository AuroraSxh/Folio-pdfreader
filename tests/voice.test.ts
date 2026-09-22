import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { createVoiceService, MAX_VOICE_LINE_BYTES, MAX_VOICE_TEXT_BYTES, VoiceServiceError, type VoiceHost } from '../electron/voice';
import type { VoiceCapabilities, VoiceEvent } from '../shared/voice';

type Message = { id: string; command: string; sessionId?: string; locale?: string; text?: string; voiceId?: string; rate?: number; allowModelDownload?: boolean };
const CAPABILITIES: VoiceCapabilities = {
  available: true, engine: 'speech-analyzer', locales: ['zh-CN', 'en-US'],
  voices: [{ id: 'com.apple.voice.test.en-US', name: 'System test voice', language: 'en-US' }],
};

class FakeHelper extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly commands: Message[] = [];
  readonly signals: NodeJS.Signals[] = [];
  readonly pid = 12345;
  closed = false;
  ignoreShutdown = false;
  ignoreTerminate = false;
  text = '';
  handler?: (command: Message, helper: FakeHelper) => void;
  constructor(handler?: FakeHelper['handler']) {
    super(); this.handler = handler;
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      for (const line of String(chunk).trim().split('\n')) {
        const message = JSON.parse(line) as Message;
        this.commands.push(message);
        if (this.handler) this.handler(message, this); else this.defaultReply(message);
      }
      callback();
    } });
  }
  send(value: unknown) { if (!this.closed) this.stdout.write(`${JSON.stringify(value)}\n`); }
  ack(message: Message, result?: unknown) { this.send({ id: message.id, ok: true, ...(result === undefined ? {} : { result }) }); }
  event(event: VoiceEvent) { if (event.text !== undefined) this.text = event.text; this.send({ event: true, ...event }); }
  defaultReply(message: Message) {
    if (message.command === 'capabilities') this.ack(message, CAPABILITIES);
    if (message.command === 'listen') { this.ack(message); this.event({ sessionId: message.sessionId!, type: 'listening' }); }
    if (message.command === 'speak') { this.ack(message); this.event({ sessionId: message.sessionId!, type: 'speech-start' }); }
    if (message.command === 'stop-listening') { this.event({ sessionId: message.sessionId!, type: 'final', text: this.text }); this.ack(message, { text: this.text }); }
    if (message.command === 'stop-speaking') this.ack(message);
    if (message.command === 'shutdown' && !this.ignoreShutdown) { this.ack(message); queueMicrotask(() => this.close()); }
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal);
    if (signal !== 'SIGTERM' || !this.ignoreTerminate) queueMicrotask(() => this.close());
    return true;
  }
  close() { if (!this.closed) { this.closed = true; this.emit('close', 0, null); } }
}

function fixture(t: TestContext, options: Partial<VoiceHost> & { handler?: FakeHelper['handler']; onSpawn?: (helper: FakeHelper) => void } = {}) {
  const events: VoiceEvent[] = [], children: FakeHelper[] = [], invocations: { file: string; args: string[]; options: SpawnOptionsWithoutStdio }[] = [];
  const service = createVoiceService({
    helperPath: '/temporary-unit-test/Folio Speech.app/Contents/MacOS/Folio Speech', platform: 'darwin',
    commandTimeoutMs: 1000, startupTimeoutMs: 1000, idleTimeoutMs: 1000, shutdownTimeoutMs: 5,
    ...options,
    emit: event => { events.push(event); options.emit?.(event); },
    spawn: options.spawn ?? ((file, args, spawnOptions) => {
      invocations.push({ file, args, options: spawnOptions });
      const helper = new FakeHelper(options.handler); children.push(helper); options.onSpawn?.(helper);
      return helper as unknown as ChildProcessWithoutNullStreams;
    }),
  });
  t.after(() => service.dispose());
  return { service, events, children, invocations };
}
const code = (expected: string) => (error: unknown) => error instanceof VoiceServiceError && error.code === expected && error.message === `[${expected}]`;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('capabilities lazily spawn a no-shell helper, request no permissions, and shut it down when idle', async t => {
  const f = fixture(t, { idleTimeoutMs: 10 });
  assert.equal(f.children.length, 0);
  const first = f.service.capabilities('zh-CN'), duplicate = f.service.capabilities('zh-CN');
  assert.equal(first, duplicate);
  assert.deepEqual(await first, CAPABILITIES);
  assert.deepEqual(f.children[0].commands.map(item => item.command), ['capabilities']);
  assert.equal(f.invocations[0].options.shell, false);
  assert.deepEqual(f.invocations[0].args, []);
  assert.equal(f.invocations[0].options.stdio, 'pipe');
  assert.ok(Object.keys(f.invocations[0].options.env!).every(name => ['HOME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'].includes(name)));
  await delay(25);
  assert.equal(f.children[0].closed, true);
  assert.deepEqual(f.children[0].commands.map(item => item.command), ['capabilities', 'shutdown']);
  await f.service.capabilities('en-US');
  assert.equal(f.children.length, 2, 'A later action may lazily restart the helper');
});

test('unsupported platforms never spawn and malformed input never reaches native commands', async t => {
  const unsupported = fixture(t, { platform: 'linux' });
  assert.deepEqual(await unsupported.service.capabilities(), { available: false, engine: 'unsupported', reason: 'unsupported', locales: [], voices: [] });
  await assert.rejects(unsupported.service.listen({ sessionId: 'one', locale: 'en-US' }), code('unsupported'));
  assert.equal(unsupported.children.length, 0);
  const f = fixture(t);
  for (const options of [
    { sessionId: '', locale: 'en-US' }, { sessionId: 'bad\ncommand', locale: 'en-US' },
    { sessionId: 'one', locale: '../../path' }, { sessionId: 'one', locale: 'en_US' },
    { sessionId: 'one', locale: 'en-US', allowModelDownload: 'yes' },
  ]) await assert.rejects(f.service.listen(options as Parameters<typeof f.service.listen>[0]), code('invalid-request'));
  for (const options of [
    { text: '' }, { text: '   ' }, { text: 'bad\0text' }, { text: 'a'.repeat(MAX_VOICE_TEXT_BYTES + 1) },
    { text: 'text', rate: NaN }, { text: 'text', rate: 0 }, { text: 'text', rate: 1.1 },
    { text: 'text', voiceId: 'third-party-cloud-voice' },
  ]) await assert.rejects(f.service.speak({ sessionId: 'one', locale: 'en-US', ...options }), code('invalid-request'));
  assert.equal((await f.service.capabilities('not a locale')).reason, 'invalid-request');
  assert.equal(f.children.length, 0);
});

test('listen acknowledgement is immediate, transcripts are cumulative, and microphone/speech are mutually exclusive', async t => {
  const f = fixture(t);
  await f.service.listen({ sessionId: 'mic-1', locale: 'zh-cn', allowModelDownload: true });
  assert.equal(f.children[0].commands[0].locale, 'zh-CN');
  assert.equal(f.children[0].commands[0].allowModelDownload, true);
  const duplicate = f.service.listen({ sessionId: 'mic-1', locale: 'zh-CN' }); await duplicate;
  assert.equal(f.children[0].commands.length, 1);
  await assert.rejects(f.service.listen({ sessionId: 'mic-2', locale: 'en-US' }), code('busy'));
  await assert.rejects(f.service.speak({ sessionId: 'speaker-1', locale: 'en-US', text: 'Read this.' }), code('busy'));
  f.children[0].event({ sessionId: 'mic-1', type: 'partial', text: '这篇' });
  f.children[0].event({ sessionId: 'mic-1', type: 'partial', text: '这篇论文讨论' });
  f.children[0].event({ sessionId: 'mic-1', type: 'final', text: '这篇论文讨论免疫。' });
  assert.deepEqual(f.events.map(event => event.type), ['listening', 'partial', 'partial', 'final']);
  assert.equal(f.events.at(-1)?.text, '这篇论文讨论免疫。');
  const before = f.children[0].commands.length;
  assert.deepEqual(await f.service.stopListening('other-session'), { text: '' });
  assert.equal(f.children[0].commands.length, before);
  assert.deepEqual(await f.service.stopListening('mic-1'), { text: '这篇论文讨论免疫。' });
  assert.deepEqual(await f.service.stopListening('mic-1'), { text: '这篇论文讨论免疫。' });
  assert.equal(f.events.filter(event => event.type === 'final').length, 1, 'The stop result does not re-emit a cancelled session event');
  await f.service.speak({ sessionId: 'speaker-1', locale: 'en-US', text: 'Read this.', rate: 0.5, voiceId: CAPABILITIES.voices[0].id });
  assert.equal(f.events.at(-1)?.type, 'speech-start');
  f.children[0].event({ sessionId: 'speaker-1', type: 'speech-end' });
  assert.equal(f.events.at(-1)?.type, 'speech-end');
  await f.service.listen({ sessionId: 'mic-2', locale: 'en-US' });
});

test('cancelling before launch and after acknowledgement filters old sessions and prevents ID reuse', async t => {
  const f = fixture(t);
  const opening = f.service.listen({ sessionId: 'not-started', locale: 'en-US' });
  const stopped = f.service.stopListening('not-started');
  await assert.rejects(opening, code('cancelled'));
  assert.deepEqual(await stopped, { text: '' });
  assert.equal(f.children[0].commands.some(item => item.command === 'listen'), false);
  await f.service.listen({ sessionId: 'old', locale: 'en-US' });
  f.children[0].event({ sessionId: 'old', type: 'partial', text: 'Retained final text.' });
  const stopping = f.service.stopListening('old');
  f.children[0].event({ sessionId: 'old', type: 'partial', text: 'This late text must be ignored.' });
  await stopping;
  const eventCount = f.events.length;
  f.children[0].event({ sessionId: 'old', type: 'error', code: 'recognition-failed' });
  await assert.rejects(f.service.listen({ sessionId: 'old', locale: 'en-US' }), code('stale-session'));
  // Stale-ID rejection is a new rejected request; the native late event itself is never forwarded.
  assert.equal(f.events.slice(eventCount).some(event => event.code === 'recognition-failed'), false);
  await f.service.listen({ sessionId: 'new', locale: 'en-US' });
  const before = f.events.length;
  f.children[0].event({ sessionId: 'old', type: 'partial', text: 'Previous session.' });
  f.children[0].event({ sessionId: 'old', type: 'final', text: 'Previous final.' });
  assert.equal(f.events.length, before);
  f.children[0].event({ sessionId: 'new', type: 'partial', text: 'Current session.' });
  assert.equal(f.events.at(-1)?.text, 'Current session.');
});

test('a stop command may interrupt a pending start ACK and cannot affect a later session', async t => {
  let start: Message | undefined;
  const f = fixture(t, { handler(message, child) {
    if (message.command === 'listen') { start = message; return; }
    if (message.command === 'stop-listening') { child.ack(message, { text: 'Flushed result.' }); child.ack(start!); return; }
    child.defaultReply(message);
  } });
  const pending = f.service.listen({ sessionId: 'mic-1', locale: 'en-US' });
  await tick();
  const stopping = f.service.stopListening('mic-1');
  await assert.rejects(pending, code('cancelled'));
  assert.deepEqual(await stopping, { text: 'Flushed result.' });
  assert.equal(f.children[0].commands.filter(item => item.command === 'stop-listening').length, 1);
  assert.equal(f.events.length, 0);
});

test('unknown/out-of-mode events are discarded and UTF-8 JSONL fragments preserve Chinese text', async t => {
  const f = fixture(t); await f.service.listen({ sessionId: 'mic', locale: 'zh-CN' });
  const child = f.children[0], count = f.events.length;
  child.send({ event: true, sessionId: 'mic', type: 'unrecognized-type', text: 'ignored' });
  child.event({ sessionId: 'mic', type: 'speech-start' });
  child.event({ sessionId: 'someone-else', type: 'final', text: 'ignored' });
  child.send({ id: 'unknown-ack', ok: true, result: { private: 'ignored' } });
  assert.equal(f.events.length, count);
  const bytes = Buffer.from(`${JSON.stringify({ event: true, sessionId: 'mic', type: 'partial', text: '你好，论文。' })}\n`);
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  assert.equal(f.events.at(-1)?.text, '你好，论文。');
});

test('native errors expose only approved codes, not stdout/stderr diagnostics or spoken text', async t => {
  const f = fixture(t, { handler(message, child) {
    if (message.command === 'listen') { child.send({ id: message.id, ok: false, code: 'microphone-denied', error: 'Sensitive diagnostic and transcript.' }); return; }
    child.defaultReply(message);
  } });
  await assert.rejects(f.service.listen({ sessionId: 'mic', locale: 'en-US' }), code('microphone-denied'));
  f.children[0].stderr.write('Another sensitive native diagnostic.');
  assert.deepEqual(f.events, [{ sessionId: 'mic', type: 'error', code: 'microphone-denied' }]);
  const unknown = fixture(t);
  await unknown.service.listen({ sessionId: 'mic', locale: 'en-US' });
  unknown.children[0].send({ event: true, sessionId: 'mic', type: 'error', code: 'sensitive diagnostic masquerading as a code', error: 'private', text: 'private transcript' });
  assert.deepEqual(unknown.events.at(-1), { sessionId: 'mic', type: 'error', code: 'recognition-failed' });
});

test('malformed JSON, oversized lines, malformed ACKs and invalid capabilities terminate the helper', async t => {
  for (const kind of ['json', 'line', 'ack', 'capabilities'] as const) {
    const f = fixture(t, { handler(message, child) {
      if (message.command === 'shutdown') { child.defaultReply(message); return; }
      if (kind === 'json') child.stdout.write('not JSON, may contain private text\n');
      if (kind === 'line') child.stdout.write('x'.repeat(MAX_VOICE_LINE_BYTES + 1));
      if (kind === 'ack') child.send({ id: message.id, ok: 'yes' });
      if (kind === 'capabilities') child.ack(message, { ...CAPABILITIES, locales: ['not a locale'] });
    } });
    assert.equal((await f.service.capabilities()).reason, 'protocol-error');
    await tick();
    assert.equal(f.children[0].closed, true);
    assert.ok(f.children[0].signals.includes('SIGTERM'));
  }
});

test('pending command and startup timeouts reject requests, close audio processes, and clear the session', async t => {
  const command = fixture(t, { commandTimeoutMs: 10, handler(message, child) { if (message.command === 'shutdown') child.defaultReply(message); } });
  assert.equal((await command.service.capabilities()).reason, 'timeout');
  await tick(); assert.equal(command.children[0].closed, true);
  const startup = fixture(t, { startupTimeoutMs: 10, handler(message, child) {
    if (message.command === 'listen') child.ack(message); else child.defaultReply(message);
  } });
  await startup.service.listen({ sessionId: 'mic', locale: 'en-US' });
  await delay(20);
  assert.equal(startup.children[0].closed, true);
  assert.deepEqual(startup.events, [{ sessionId: 'mic', type: 'error', code: 'timeout' }]);
  assert.deepEqual(await startup.service.stopListening('mic'), { text: '' });
});

test('unexpected helper exits reject all pending requests and allow a clean lazy restart', async t => {
  const f = fixture(t, { handler(message, child) { if (message.command === 'shutdown') child.defaultReply(message); } });
  const first = f.service.capabilities('zh-CN'), second = f.service.capabilities('en-US');
  await tick();
  assert.equal(f.children.length, 1); assert.equal(f.children[0].commands.length, 2);
  f.children[0].close();
  assert.equal((await first).reason, 'helper-exited'); assert.equal((await second).reason, 'helper-exited');
  const next = f.service.capabilities(); await tick();
  assert.equal(f.children.length, 2);
  f.children[1].ack(f.children[1].commands[0], CAPABILITIES);
  assert.deepEqual(await next, CAPABILITIES);
});

test('stop-speaking suppresses late speech-end events and keeps subsequent microphone events separate', async t => {
  const f = fixture(t); await f.service.speak({ sessionId: 'speaker', locale: 'en-US', text: 'Answer to read.' });
  const stops = [f.service.stopSpeaking(), f.service.stopSpeaking()]; await Promise.all(stops);
  assert.equal(f.children[0].commands.filter(item => item.command === 'stop-speaking').length, 1);
  assert.equal(f.children[0].commands.find(item => item.command === 'stop-speaking')?.sessionId, 'speaker');
  const count = f.events.length;
  f.children[0].event({ sessionId: 'speaker', type: 'speech-end' });
  assert.equal(f.events.length, count);
  await f.service.listen({ sessionId: 'mic', locale: 'en-US' });
  await f.service.stopSpeaking();
  assert.equal(f.children[0].commands.filter(item => item.command === 'stop-speaking').length, 1);
});

test('failed native stop terminates the audio helper before releasing the cancelled session', async t => {
  for (const mode of ['listen', 'speak'] as const) {
    const f = fixture(t, { handler(message, child) {
      if (message.command === 'stop-listening' || message.command === 'stop-speaking') {
        child.send({ id: message.id, ok: false, code: 'stale-session', error: 'Native private diagnostic.' }); return;
      }
      child.defaultReply(message);
    } });
    if (mode === 'listen') await f.service.listen({ sessionId: 'first', locale: 'en-US' });
    else await f.service.speak({ sessionId: 'first', locale: 'en-US', text: 'Read this.' });
    const count = f.events.length;
    await assert.rejects(mode === 'listen' ? f.service.stopListening('first') : f.service.stopSpeaking(), code('stale-session'));
    assert.equal(f.children[0].closed, true, 'Stop rejects only after the native audio process has exited');
    assert.ok(f.children[0].signals.includes('SIGTERM'));
    assert.equal(f.events.length, count, 'Cancelled tasks do not emit late errors or transcripts');
    await f.service.listen({ sessionId: 'next', locale: 'en-US' });
    assert.equal(f.children.length, 2, 'Next session starts a clean helper');
  }
});

test('disposal is idempotent, interrupts pending work, and escalates unresponsive helpers without polling', async t => {
  const f = fixture(t, { handler() {}, onSpawn(child) { child.ignoreTerminate = true; } });
  const pending = f.service.capabilities(); await tick();
  await Promise.all([f.service.dispose(), f.service.dispose()]);
  assert.equal((await pending).reason, 'disposed');
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.children[0].closed, true);
  assert.equal((await f.service.capabilities()).reason, 'disposed');
  await assert.rejects(f.service.listen({ sessionId: 'mic', locale: 'en-US' }), code('disposed'));
  const count = f.events.length; f.children[0].send({ event: true, sessionId: 'mic', type: 'partial', text: 'old' });
  assert.equal(f.events.length, count);
});

test('capability normalization accepts native underscores and reports consent-required model installation without starting it', async t => {
  const f = fixture(t, { handler(message, child) {
    if (message.command === 'capabilities') child.ack(message, { available: false, engine: 'speech-analyzer', reason: 'needs-model-download', locales: ['zh_CN', 'en_US'], needsModelDownload: true, voices: [{ ...CAPABILITIES.voices[0], language: 'en_US' }] });
    else child.defaultReply(message);
  } });
  const capabilities = await f.service.capabilities('zh-CN');
  assert.equal(capabilities.needsModelDownload, true);
  assert.deepEqual(capabilities.locales, ['zh-CN', 'en-US']);
  assert.equal(capabilities.voices[0].language, 'en-US');
  assert.deepEqual(f.children[0].commands.map(message => message.command), ['capabilities']);
  await f.service.listen({ sessionId: 'mic', locale: 'zh-CN' });
  assert.equal(Object.hasOwn(f.children[0].commands[1], 'allowModelDownload'), false, 'No implicit consent to model download');
});

test('spawn errors and invalid helper paths degrade capabilities without leaking OS errors', async t => {
  const badPath = fixture(t, { helperPath: 'relative-helper' });
  assert.equal((await badPath.service.capabilities()).reason, 'helper-unavailable');
  assert.equal(badPath.children.length, 0);
  const throwing = fixture(t, { spawn() { throw new Error('private absolute path and native diagnostic'); } });
  assert.deepEqual(await throwing.service.capabilities(), { available: false, engine: 'unsupported', reason: 'helper-unavailable', locales: [], voices: [] });
  await assert.rejects(throwing.service.speak({ sessionId: 'speaker', locale: 'en-US', text: 'Read this.' }), code('helper-unavailable'));
});

test('legacy capability empty reasons are omitted and native cancellation codes survive event validation', async t => {
  const f = fixture(t, { handler(message, child) {
    if (message.command === 'capabilities') child.ack(message, { ...CAPABILITIES, engine: 'speech-recognizer', reason: '' });
    else child.defaultReply(message);
  } });
  assert.equal((await f.service.capabilities()).reason, undefined);
  await f.service.speak({ sessionId: 'speaker', locale: 'en-US', text: 'Read this.' });
  f.children[0].event({ sessionId: 'speaker', type: 'speech-end', code: 'cancelled' });
  assert.deepEqual(f.events.at(-1), { sessionId: 'speaker', type: 'speech-end', code: 'cancelled' });
});

test('voice quality metadata survives capability normalization; unrecognized grades are rejected', async t => {
  const f = fixture(t, { handler: (message, helper) => {
    if (message.command === 'capabilities') helper.ack(message, { ...CAPABILITIES, voices: [
      { id: 'com.apple.voice.zh', name: 'Chinese', language: 'zh_CN', quality: 'premium' },
      { id: 'com.apple.voice.en', name: 'English', language: 'en_US', quality: 'enhanced' },
    ] }); else helper.defaultReply(message);
  } });
  const result = await f.service.capabilities('zh-CN');
  assert.deepEqual(result.voices.map(v => [v.language, v.quality]), [['zh-CN', 'premium'], ['en-US', 'enhanced']]);
  f.children[0].handler = (message, helper) => message.command === 'capabilities'
    ? helper.ack(message, { ...CAPABILITIES, voices: [{ ...CAPABILITIES.voices[0], quality: 'unexpected' }] }) : helper.defaultReply(message);
  assert.equal((await f.service.capabilities('zh-CN')).reason, 'protocol-error');
});

test('mixed-language playback remains one job, blocks capture until final completion, and forwards bounded pauses and voices', async t => {
  const f = fixture(t);
  const segments = [
    { text: '中文包含 T cells。', locale: 'zh-cn', voiceId: 'com.apple.voice.zh', pauseAfter: 0 },
    { text: 'An English sentence.', locale: 'en-us', voiceId: 'com.apple.voice.en', pauseAfter: 0.12 },
  ];
  await f.service.speak({ sessionId: 'mixed', text: segments.map(s => s.text).join(''), locale: 'zh-CN', rate: 0.45, segments });
  const command = f.children[0].commands[0] as unknown as { segments: typeof segments };
  assert.deepEqual(command.segments.map(s => s.locale), ['zh-CN', 'en-US']);
  assert.equal(command.segments[1].pauseAfter, 0.12);
  await assert.rejects(f.service.listen({ sessionId: 'mic', locale: 'zh-CN' }), code('busy'));
  f.children[0].event({ sessionId: 'mixed', type: 'speech-end' });
  await f.service.listen({ sessionId: 'mic', locale: 'zh-CN' });
  assert.equal(f.events.filter(e => e.type === 'speech-end').length, 1);
});

test('malformed speech plans never spawn the helper, and large valid plans remain within the command budget', async t => {
  const f = fixture(t), valid = { text: 'a', locale: 'en-US' };
  const plans: unknown[] = [[], null, {}, [null], Array(257).fill(valid), [{ ...valid, text: '' }],
    [{ ...valid, text: 'a\0' }], [{ ...valid, locale: '../bad' }], [{ ...valid, voiceId: 'external' }],
    [{ ...valid, pauseAfter: -1 }], [{ ...valid, pauseAfter: NaN }], [{ ...valid, pauseAfter: 0.51 }],
    [{ ...valid, text: 'different' }], [{ ...valid, text: 'a'.repeat(MAX_VOICE_TEXT_BYTES + 1) }]];
  for (const segments of plans) await assert.rejects(f.service.speak({ sessionId: 'invalid', text: 'a', locale: 'en-US', segments } as Parameters<typeof f.service.speak>[0]), code('invalid-request'));
  assert.equal(f.children.length, 0);
  const text = 'a'.repeat(MAX_VOICE_TEXT_BYTES);
  await f.service.speak({ sessionId: 'large', text, locale: 'en-US', segments: [{ text, locale: 'en-US' }] });
  assert.equal(f.children[0].commands.filter(c => c.command === 'speak').length, 1);
});

test('Windows system speech uses the same lazy, cancellable protocol without inheriting credentials', async t => {
  const voiceId = 'windows.sapi.' + 'a'.repeat(64);
  const capabilities: VoiceCapabilities = { available: true, engine: 'windows-speech', locales: ['zh-CN', 'en-US'], voices: [{ id: voiceId, name: 'Installed Windows voice', language: 'en-US', quality: 'default' }], needsModelDownload: false };
  const values = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Test', FOLIO_TEST_API_SECRET: 'never-inherit-this-test-value' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const key of Object.keys(values)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const f = fixture(t, { platform: 'win32', helperPath: '/test/windows-speech/PairleafSpeech.exe', handler: (command, helper) => {
    if (command.command === 'capabilities') helper.ack(command, capabilities); else helper.defaultReply(command);
  } });
  assert.equal(f.children.length, 0);
  assert.deepEqual(await f.service.capabilities('en-US'), capabilities);
  assert.deepEqual(f.children[0].commands.map(command => command.command), ['capabilities']);
  assert.equal(f.invocations[0].options.windowsHide, true);
  assert.equal(f.invocations[0].options.shell, false);
  assert.equal(f.invocations[0].options.env!.SystemRoot, values.SystemRoot);
  assert.equal(f.invocations[0].options.env!.USERPROFILE, values.USERPROFILE);
  assert.equal(f.invocations[0].options.env!.FOLIO_TEST_API_SECRET, undefined);
  await f.service.listen({ sessionId: 'windows-listen', locale: 'en-US' });
  f.children[0].event({ sessionId: 'windows-listen', type: 'partial', text: 'Explain this figure' });
  assert.deepEqual(await f.service.stopListening('windows-listen'), { text: 'Explain this figure' });
  const eventCount = f.events.length;
  f.children[0].event({ sessionId: 'windows-listen', type: 'final', text: 'Late recording must be ignored' });
  assert.equal(f.events.length, eventCount);
  await f.service.speak({ sessionId: 'windows-speak', locale: 'en-US', text: 'CD 4 positive', voiceId, rate: 0.5, segments: [{ text: 'CD 4 positive', locale: 'en-US', voiceId, pauseAfter: 0.1 }] });
  assert.equal(f.children[0].commands.at(-1)?.voiceId, voiceId);
  await f.service.stopSpeaking();
  await f.service.dispose();
  assert.equal(f.children[0].closed, true);
});

test('Windows can expose installed TTS voices when local dictation is absent and rejects malformed voice IDs', async t => {
  const voiceId = 'windows.sapi.' + 'b'.repeat(64);
  const capabilities: VoiceCapabilities = { available: false, engine: 'windows-speech', reason: 'recognizer-unavailable', locales: [], voices: [{ id: voiceId, name: 'Windows TTS', language: 'en-US' }], needsModelDownload: false };
  const f = fixture(t, { platform: 'win32', handler: (command, helper) => {
    if (command.command === 'capabilities') helper.ack(command, capabilities); else helper.defaultReply(command);
  } });
  assert.deepEqual(await f.service.capabilities('zh-CN'), capabilities);
  const count = f.children[0].commands.length;
  await assert.rejects(f.service.speak({ sessionId: 'invalid-voice', locale: 'en-US', text: 'sample', voiceId: 'windows.sapi.../../executable' }), code('invalid-request'));
  assert.equal(f.children[0].commands.length, count);
  await f.service.speak({ sessionId: 'tts-only', locale: 'en-US', text: 'sample', voiceId });
  assert.equal(f.events.at(-1)?.type, 'speech-start');
});

test('successful empty Windows stop result does not restore a rejected hypothesis from before stopping', async t => {
  const f = fixture(t, { platform: 'win32', handler: (command, helper) => {
    if (command.command === 'stop-listening') {
      helper.event({ sessionId: command.sessionId!, type: 'partial', text: '' });
      helper.ack(command, { text: '' });
    } else helper.defaultReply(command);
  } });
  await f.service.listen({ sessionId: 'rejected', locale: 'en-US' });
  f.children[0].event({ sessionId: 'rejected', type: 'partial', text: 'rejected background noise' });
  assert.deepEqual(await f.service.stopListening('rejected'), { text: '' });
  assert.deepEqual(await f.service.stopListening('rejected'), { text: '' });
  assert.equal(f.events.at(-1)?.text, 'rejected background noise', 'the old stop-phase event stays filtered; the ACK supplies the authoritative final result');
});
