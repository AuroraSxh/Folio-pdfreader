import type { VoiceCapabilities, VoiceEvent, VoiceListenOptions, VoiceSpeakOptions } from '../../shared/voice';

export type VoicePhase = 'idle' | 'checking' | 'download' | 'starting' | 'listening' | 'thinking' | 'speaking' | 'finishing' | 'paused' | 'error';
export interface VoicePreferences { locale: 'zh-CN' | 'en-US'; voiceId: string; rate: number }
export interface VoiceState {
  active: boolean; phase: VoicePhase; transcript: string; error?: string;
  preferences: VoicePreferences; capabilities?: VoiceCapabilities;
}
export interface VoiceAPI {
  voiceCapabilities(locale?: string): Promise<VoiceCapabilities>;
  voiceListen(options: VoiceListenOptions): Promise<void>;
  voiceStopListening(sessionId: string): Promise<{ text: string }>;
  voiceSpeak(options: VoiceSpeakOptions): Promise<void>;
  voiceStopSpeaking(): Promise<void>;
}
interface Options {
  api: VoiceAPI;
  preferences: VoicePreferences;
  /** Check synchronously before microphone activation and before an AI request. */
  ready(): string | undefined;
  /** Uses the normal chat pipeline; resolves only after its generation task ends. */
  submit(text: string, locale: VoicePreferences['locale'], answer: (text: string) => void): Promise<void>;
  /** Must only cancel this component's current voice request. */
  cancelAI(): Promise<void>;
  id?: () => string;
  schedule?: (fn: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clear?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function voiceErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.match(/\[([a-z][a-z-]+)\]/)?.[1] ?? 'recognition-failed';
}

/** Markdown stays intact in history. Only speech omits formatting and link URLs. */
export function spokenText(markdown: string): string {
  return markdown.replace(/```[^\n]*\n[\s\S]*?```/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/[*_`~]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Event-driven turn taking. There is no idle polling, audio capture, or timer
 * until an explicit start. Epochs reject every late native/AI continuation. */
export function createVoiceConversation(options: Options) {
  const { api } = options;
  const schedule = options.schedule ?? setTimeout;
  const clear = options.clear ?? clearTimeout;
  const id = options.id ?? (() => crypto.randomUUID());
  let state: VoiceState = { active: false, phase: 'idle', transcript: '', preferences: options.preferences };
  const listeners = new Set<(state: VoiceState) => void>();
  let epoch = 0;
  let listenId: string | null = null;
  let speechId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeStarting: Promise<void> | null = null;
  let stopping: Promise<void> = Promise.resolve();
  let answered = false, speechDone = false, generationDone = false;

  const publish = (patch: Partial<VoiceState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(state); };
  const clearSilence = () => { if (timer !== null) clear(timer); timer = null; };
  const clearIdle = () => { if (idleTimer !== null) clear(idleTimer); idleTimer = null; };
  const valid = (token: number) => epoch === token && state.active;

  function halt(phase: VoicePhase, active: boolean, error?: string) {
    ++epoch;
    clearSilence(); clearIdle();
    const listening = listenId, speaking = speechId, starting = nativeStarting;
    listenId = null; speechId = null; nativeStarting = null;
    publish({ active, phase, error });
    // Native synthesis stop is global, so no new session may start before this
    // queue drains. Await ACK first so cancelling an in-flight start cannot leak.
    stopping = stopping.catch(() => {}).then(async () => {
      await starting?.catch(() => {});
      await Promise.allSettled([
        ...(listening ? [api.voiceStopListening(listening)] : []),
        ...(speaking ? [api.voiceStopSpeaking()] : []),
        options.cancelAI(),
      ]);
    });
    return stopping;
  }
  function fail(token: number, error: string) {
    if (!valid(token)) return;
    void halt(error === 'needs-model-download' ? 'download' : 'error', true, error);
  }

  async function listen(token: number, allowModelDownload = false) {
    if (!valid(token)) return;
    const blocked = options.ready();
    if (blocked) { fail(token, blocked); return; }
    answered = false; speechDone = false; generationDone = false;
    const sessionId = id(); listenId = sessionId;
    publish({ phase: 'starting', transcript: '', error: undefined });
    try {
      const starting = api.voiceListen({ sessionId, locale: state.preferences.locale, ...(allowModelDownload ? { allowModelDownload: true } : {}) });
      nativeStarting = starting;
      await starting;
      if (nativeStarting === starting) nativeStarting = null;
      // ACK only means the command was accepted. Permission prompts and model
      // download may still be pending; only the native event means it is live.
    } catch (error) { fail(token, voiceErrorCode(error)); }
  }

  function next(token: number) {
    if (!valid(token)) return;
    if (speechDone && generationDone) void listen(token);
    else if (speechDone) publish({ phase: 'finishing' });
  }

  async function speak(token: number, text: string) {
    if (!valid(token) || answered) return;
    answered = true;
    const speech = spokenText(text);
    if (!speech) { speechDone = true; next(token); return; }
    const sessionId = id(); speechId = sessionId;
    publish({ phase: 'speaking' });
    try {
      const { locale, voiceId, rate } = state.preferences;
      const starting = api.voiceSpeak({ sessionId, text: speech, locale, ...(voiceId ? { voiceId } : {}), rate });
      nativeStarting = starting;
      await starting;
      if (nativeStarting === starting) nativeStarting = null;
    } catch (error) { fail(token, voiceErrorCode(error)); }
  }

  async function finishTurn(token = epoch, sessionId = listenId) {
    if (!valid(token) || !sessionId || listenId !== sessionId || !['starting', 'listening'].includes(state.phase)) return;
    clearSilence(); clearIdle();
    publish({ phase: 'thinking' });
    try {
      await nativeStarting;
      if (!valid(token)) return;
      const final = await api.voiceStopListening(sessionId);
      if (!valid(token) || listenId !== sessionId) return;
      listenId = null;
      const text = (final.text || state.transcript).trim();
      if (!text) { await listen(token); return; }
      publish({ transcript: text });
      const blocked = options.ready();
      if (blocked) { fail(token, blocked); return; }
      await options.submit(text, state.preferences.locale, answer => { void speak(token, answer); });
      if (!valid(token)) return;
      generationDone = true;
      // A completed empty/failed answer is never spoken or retried in a loop.
      if (!answered) { fail(token, 'empty-answer'); return; }
      next(token);
    } catch (error) { fail(token, voiceErrorCode(error)); }
  }

  async function start(allowModelDownload = false) {
    const pending = halt('checking', true);
    const token = epoch;
    await pending;
    if (!valid(token)) return;
    const blocked = options.ready();
    if (blocked) { fail(token, blocked); return; }
    try {
      const capabilities = await api.voiceCapabilities(state.preferences.locale);
      if (!valid(token)) return;
      publish({ capabilities });
      if (capabilities.needsModelDownload && !allowModelDownload) { publish({ phase: 'download', error: undefined }); return; }
      if (!capabilities.available && !(capabilities.needsModelDownload && allowModelDownload)) { fail(token, capabilities.reason || 'unsupported'); return; }
      await listen(token, allowModelDownload);
    } catch (error) { fail(token, voiceErrorCode(error)); }
  }

  function handleEvent(event: VoiceEvent) {
    if (!state.active) return;
    if (event.sessionId === listenId) {
      if (event.type === 'error') { fail(epoch, event.code || 'recognition-failed'); return; }
      if (event.type === 'listening' && state.phase === 'starting') {
        publish({ phase: 'listening' });
        const token = epoch;
        idleTimer = schedule(() => { idleTimer = null; if (valid(token) && state.phase === 'listening' && !state.transcript.trim()) void halt('paused', true, 'no-speech'); }, 60_000);
      }
      if ((event.type === 'partial' || event.type === 'final') && ['starting', 'listening'].includes(state.phase)) {
        const text = event.text ?? '';
        if (text === state.transcript) return;
        publish({ transcript: text }); clearSilence();
        if (text.trim()) clearIdle();
        if (text.trim()) { const token = epoch, sessionId = listenId; timer = schedule(() => { timer = null; void finishTurn(token, sessionId); }, 1400); }
      }
    } else if (event.sessionId === speechId) {
      if (event.type === 'error') { fail(epoch, event.code || 'synthesis-failed'); return; }
      if (event.type === 'speech-end') {
        if (event.code) { fail(epoch, event.code); return; }
        speechId = null; speechDone = true; next(epoch);
      }
    }
  }

  return {
    getState: () => state,
    subscribe(callback: (value: VoiceState) => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    handleEvent, start, finishTurn,
    pause: () => halt('paused', true),
    end: () => halt('idle', false),
    async interrupt() { const pending = halt('paused', true); const token = epoch; await pending; if (valid(token)) await start(); },
    setPreferences(preferences: VoicePreferences) {
      if (state.active && !['paused', 'error', 'download'].includes(state.phase)) return;
      publish({ preferences, capabilities: state.preferences.locale === preferences.locale ? state.capabilities : undefined });
    },
  };
}
export type VoiceController = ReturnType<typeof createVoiceConversation>;
