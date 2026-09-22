import { useEffect, useRef, useState } from 'react';
import { createVoiceConversation, type VoicePreferences } from './voiceConversation';

const PREFERENCES_KEY = 'folio.voice-preferences.v1';
export function readVoicePreferences(locale: string, raw?: string | null): VoicePreferences {
  const fallback: VoicePreferences = { locale: locale === 'en-US' ? 'en-US' : 'zh-CN', voiceId: '', rate: 0.5 };
  try {
    const saved = JSON.parse(raw ?? 'null') as Partial<VoicePreferences> | null;
    if (!saved || typeof saved !== 'object') return fallback;
    return {
      locale: saved.locale === 'en-US' || saved.locale === 'zh-CN' ? saved.locale : fallback.locale,
      voiceId: typeof saved.voiceId === 'string' && saved.voiceId.length <= 300 ? saved.voiceId : '',
      rate: typeof saved.rate === 'number' && Number.isFinite(saved.rate)
        ? [0.35, 0.45, 0.5, 0.55, 0.65].reduce((closest, candidate) => Math.abs(candidate - saved.rate!) < Math.abs(closest - saved.rate!) ? candidate : closest, 0.5)
        : 0.5,
    };
  } catch { return fallback; }
}
interface Options {
  locale: string;
  enabled: boolean;
  toggleRequest?: { nonce: number };
  onActiveChange?: (active: boolean) => void;
  ready: () => string | undefined;
  submit: (text: string, locale: VoicePreferences['locale'], answer: (text: string) => void) => Promise<void>;
  cancelAI: () => Promise<void>;
}

export function useVoiceConversation(options: Options) {
  const latest = useRef(options); latest.current = options;
  const [controller] = useState(() => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(PREFERENCES_KEY); } catch { /* Preferences are optional. */ }
    return createVoiceConversation({
      api: {
        voiceCapabilities: locale => window.folio.voiceCapabilities(locale),
        voiceListen: value => window.folio.voiceListen(value),
        voiceStopListening: id => window.folio.voiceStopListening(id),
        voiceSpeak: value => window.folio.voiceSpeak(value),
        voiceStopSpeaking: () => window.folio.voiceStopSpeaking(),
      },
      preferences: readVoicePreferences(options.locale, raw),
      ready: () => latest.current.ready(),
      submit: (text, locale, answer) => latest.current.submit(text, locale, answer),
      cancelAI: () => latest.current.cancelAI(),
    });
  });
  const [state, setState] = useState(controller.getState);
  const consumedToggle = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!options.enabled) return;
    let active = controller.getState().active;
    let saved = JSON.stringify(controller.getState().preferences);
    setState(controller.getState());
    const unsubscribe = controller.subscribe(next => {
      setState(next);
      if (active !== next.active) { active = next.active; latest.current.onActiveChange?.(active); }
      const value = JSON.stringify(next.preferences);
      if (value !== saved) { saved = value; try { localStorage.setItem(PREFERENCES_KEY, value); } catch { /* Still usable for this session. */ } }
    });
    const stopVoice = window.folio.onVoice(controller.handleEvent);
    const stopCommand = window.folio.onCommand(command => { if (command === 'stop-voice') void controller.end(); });
    const flush = (event: Event) => { (event as CustomEvent<Promise<void>[]>).detail.push(controller.end()); };
    window.addEventListener('folio:flush-notes', flush);
    return () => {
      unsubscribe(); stopVoice(); stopCommand(); window.removeEventListener('folio:flush-notes', flush);
      void controller.end(); latest.current.onActiveChange?.(false);
    };
  }, [controller, options.enabled]);
  useEffect(() => {
    if (!options.enabled || !options.toggleRequest || consumedToggle.current === options.toggleRequest.nonce) return;
    consumedToggle.current = options.toggleRequest.nonce;
    if (controller.getState().active) void controller.end(); else void controller.start();
  }, [controller, options.enabled, options.toggleRequest?.nonce]);
  return { state, controller };
}
