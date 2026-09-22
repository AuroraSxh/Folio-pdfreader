import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceConversation, spokenText, voiceErrorCode, type VoiceAPI } from '../src/hooks/voiceConversation';
import { readVoicePreferences } from '../src/hooks/useVoiceConversation';
import type { VoiceCapabilities, VoiceEvent, VoiceListenOptions, VoiceSpeakOptions } from '../shared/voice';

const defer = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function fixture() {
  let now = 0, timerId = 0, session = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const calls: string[] = [], listens: VoiceListenOptions[] = [], speaks: VoiceSpeakOptions[] = [];
  const transcripts = new Map<string, string>();
  const submissions: Array<ReturnType<typeof defer<void>> & { text: string; answer: (text: string) => void }> = [];
  let pending: typeof submissions[number] | undefined;
  let capabilities: VoiceCapabilities = { available: true, engine: 'speech-analyzer', locales: ['zh-CN', 'en-US'], voices: [] };
  let blocked: string | undefined;
  const api: VoiceAPI = {
    voiceCapabilities: async () => { calls.push('capabilities'); return capabilities; },
    voiceListen: async options => { listens.push(options); calls.push(`listen:${options.sessionId}`); },
    voiceStopListening: async id => { calls.push(`stop-listen:${id}`); return { text: transcripts.get(id) ?? '' }; },
    voiceSpeak: async options => { speaks.push(options); calls.push(`speak:${options.sessionId}`); },
    voiceStopSpeaking: async () => { calls.push('stop-speak'); },
  };
  const controller = createVoiceConversation({
    api, preferences: { locale: 'zh-CN', voiceId: '', rate: 0.5 },
    ready: () => blocked,
    id: () => `session-${++session}`,
    schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clear: id => { timers.delete(id as unknown as number); },
    submit: (text, _locale, answer) => {
      calls.push('submit'); const item = { ...defer<void>(), text, answer }; submissions.push(item); pending = item;
      return item.promise.finally(() => { if (pending === item) pending = undefined; });
    },
    cancelAI: async () => { if (pending) { calls.push('cancel-ai'); pending.reject(new Error('[cancelled]')); await pending.promise.catch(() => {}); } },
  });
  const emit = (type: VoiceEvent['type'], text?: string, id = listens.at(-1)!.sessionId, code?: string) => {
    if (type === 'partial' || type === 'final') transcripts.set(id, text ?? '');
    controller.handleEvent({ sessionId: id, type, text, code });
  };
  const tick = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await settle();
  };
  const begin = async () => { await controller.start(); emit('listening'); };
  return { controller, api, calls, listens, speaks, submissions, timers, emit, tick, begin,
    capabilities: (value: VoiceCapabilities) => { capabilities = value; }, blocked: (value?: string) => { blocked = value; } };
}

test('cumulative segments submit exactly once after silence, stop mic before AI, and wait for TTS + memory before listening again', async () => {
  const f = fixture(); await f.begin();
  f.emit('partial', '解释'); await f.tick(700);
  f.emit('final', '解释这个结果'); f.emit('final', '解释这个结果');
  await f.tick(1399); assert.equal(f.submissions.length, 0);
  await f.tick(1); assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].text, '解释这个结果');
  assert(f.calls.indexOf('stop-listen:session-1') < f.calls.indexOf('submit'));
  assert.equal(f.controller.getState().phase, 'thinking');
  f.emit('final', '迟到的识别不能再次提交', 'session-1');
  f.submissions[0].answer('**结论**是[有效](https://example.org)。');
  f.submissions[0].answer('重复的保存快照');
  await settle(); assert.equal(f.speaks.length, 1); assert.equal(f.speaks[0].text, '结论是有效。');
  f.emit('partial', '朗读回声', 'session-1'); assert.equal(f.controller.getState().transcript, '解释这个结果');
  f.emit('speech-end', undefined, f.speaks[0].sessionId); await settle();
  assert.equal(f.controller.getState().phase, 'finishing'); assert.equal(f.listens.length, 1);
  f.submissions[0].resolve(); await settle(); assert.equal(f.listens.length, 2);
  assert.equal(f.controller.getState().phase, 'starting');
  f.emit('listening'); assert.equal(f.controller.getState().phase, 'listening');
  assert.equal(f.controller.getState().transcript, '');
  await f.controller.end(); assert.equal(f.timers.size, 0);
});

test('ACK does not imply permission granted; delayed ACK followed by end stops native session without starting AI', async () => {
  const f = fixture(), ack = defer<void>();
  f.api.voiceListen = options => { f.listens.push(options); return ack.promise; };
  const started = f.controller.start(); await settle();
  assert.equal(f.controller.getState().phase, 'starting'); assert.equal(f.timers.size, 0);
  const ended = f.controller.end(); assert.equal(f.controller.getState().active, false);
  f.emit('listening'); f.emit('final', 'should be discarded'); await f.tick(2000);
  assert.equal(f.submissions.length, 0);
  ack.resolve(); await Promise.all([started, ended]);
  assert(f.calls.includes('stop-listen:session-1')); assert.equal(f.controller.getState().phase, 'idle');
});

test('model download needs an explicit confirmation and can be cancelled while native start is pending', async () => {
  const f = fixture(); f.capabilities({ available: false, engine: 'speech-analyzer', reason: 'needs-model-download', needsModelDownload: true, locales: ['zh-CN'], voices: [] });
  await f.controller.start(); assert.equal(f.controller.getState().phase, 'download'); assert.equal(f.listens.length, 0);
  const ack = defer<void>(); f.api.voiceListen = options => { f.listens.push(options); return ack.promise; };
  const approved = f.controller.start(true); await settle();
  assert.equal(f.listens[0].allowModelDownload, true); assert.equal(f.controller.getState().phase, 'starting');
  const ended = f.controller.end(); ack.resolve(); await Promise.all([approved, ended]);
  f.emit('listening'); f.emit('partial', 'late result'); await f.tick(2000);
  assert.equal(f.controller.getState().active, false); assert.equal(f.submissions.length, 0); assert.equal(f.timers.size, 0);
});

test('end while capabilities are pending cannot resurrect microphone or a model confirmation', async () => {
  const f = fixture(), response = defer<VoiceCapabilities>(); f.api.voiceCapabilities = () => response.promise;
  const started = f.controller.start(); await settle(); await f.controller.end();
  response.resolve({ available: true, engine: 'speech-analyzer', voices: [], locales: ['zh-CN'] }); await started;
  assert.equal(f.listens.length, 0); assert.equal(f.controller.getState().active, false);
});

test('interrupt cancels only the owned AI turn and TTS, then rejects old callbacks in the new listen session', async () => {
  const f = fixture(); await f.begin(); f.emit('partial', 'first question'); await f.tick(1400);
  f.submissions[0].answer('first answer'); await settle(); const oldSpeech = f.speaks[0].sessionId;
  await f.controller.interrupt(); assert.equal(f.listens.length, 2);
  assert(f.calls.includes('cancel-ai')); assert(f.calls.includes('stop-speak'));
  assert(f.calls.indexOf('stop-speak') < f.calls.indexOf('listen:session-3'));
  f.emit('speech-end', undefined, oldSpeech); f.submissions[0].answer('late answer');
  f.emit('partial', 'stale question', 'session-1'); await f.tick(2000);
  assert.equal(f.listens.length, 2); assert.equal(f.speaks.length, 1); assert.equal(f.submissions.length, 1);
  assert.equal(f.controller.getState().transcript, ''); await f.controller.end();
});

test('pause discards an unfinished half-sentence without losing the visible draft; resume uses a new session', async () => {
  const f = fixture(); await f.begin(); f.emit('partial', 'incomplete'); await f.tick(500);
  await f.controller.pause(); await f.tick(2000);
  assert.equal(f.controller.getState().phase, 'paused'); assert.equal(f.controller.getState().active, true);
  assert.equal(f.controller.getState().transcript, 'incomplete'); assert.equal(f.submissions.length, 0);
  await f.controller.start(); assert.equal(f.listens.length, 2); assert.equal(f.timers.size, 0); await f.controller.end();
});

test('permission errors stop once and never auto retry; empty recognition never submits', async () => {
  const f = fixture(); await f.begin(); f.emit('partial', '   '); await f.tick(2000);
  assert.equal(f.submissions.length, 0);
  f.emit('error', undefined, undefined, 'microphone-denied'); await settle();
  assert.equal(f.controller.getState().phase, 'error'); assert.equal(f.controller.getState().error, 'microphone-denied');
  await f.tick(120000); assert.equal(f.listens.length, 1); assert.equal(f.timers.size, 0); await f.controller.end();
});

test('a minute without speech pauses the microphone and leaves no recurring timer', async () => {
  const f = fixture(); await f.begin(); await f.tick(59999); assert.equal(f.controller.getState().phase, 'listening');
  await f.tick(1); assert.equal(f.controller.getState().phase, 'paused'); assert.equal(f.controller.getState().error, 'no-speech');
  assert(f.calls.includes('stop-listen:session-1')); assert.equal(f.timers.size, 0); assert.equal(f.submissions.length, 0); await f.controller.end();
});

test('OS cancellation of read-aloud does not automatically reopen the microphone', async () => {
  const f = fixture(); await f.begin(); f.emit('partial', 'question'); await f.tick(1400);
  f.submissions[0].answer('answer'); f.submissions[0].resolve(); await settle();
  f.emit('speech-end', undefined, f.speaks[0].sessionId, 'cancelled'); await settle();
  assert.equal(f.controller.getState().phase, 'error'); assert.equal(f.controller.getState().error, 'cancelled');
  await f.tick(2000); assert.equal(f.listens.length, 1); assert.equal(f.timers.size, 0); await f.controller.end();
});

test('missing key/busy blocks capture, and AI failure stops instead of repeatedly sending', async () => {
  const f = fixture(); f.blocked('missing-key'); await f.controller.start();
  assert.equal(f.controller.getState().error, 'missing-key'); assert.equal(f.listens.length, 0);
  f.blocked('busy'); await f.controller.start(); assert.equal(f.controller.getState().error, 'busy'); assert.equal(f.listens.length, 0);
  f.blocked(); await f.begin(); f.emit('partial', 'hello'); await f.tick(1400);
  f.submissions[0].reject(new Error('[chat-failed]')); await settle(); assert.equal(f.controller.getState().error, 'chat-failed');
  await f.tick(100000); assert.equal(f.listens.length, 1); assert.equal(f.submissions.length, 1); await f.controller.end();
});

test('preference restoration validates language, id and rate; IPC code parsing never exposes native error text', () => {
  assert.deepEqual(readVoicePreferences('en-US', '{broken'), { locale: 'en-US', voiceId: '', rate: 0.5 });
  assert.deepEqual(readVoicePreferences('zh-CN', '{"locale":"en-US","voiceId":"voice-1","rate":100}'), { locale: 'en-US', voiceId: 'voice-1', rate: 0.65 });
  assert.deepEqual(readVoicePreferences('zh-CN', '{"locale":"xx","voiceId":20,"rate":"fast"}'), { locale: 'zh-CN', voiceId: '', rate: 0.5 });
  assert.equal(voiceErrorCode(new Error("Error invoking remote method: Error: [microphone-denied]")), 'microphone-denied');
  assert.equal(voiceErrorCode(new Error('sensitive native content')), 'recognition-failed');
  assert.equal(spokenText('# Result\n\n**Good** [evidence](https://example.org)\n```py\nsecret()\n```'), 'Result\n\nGood evidence');
});
