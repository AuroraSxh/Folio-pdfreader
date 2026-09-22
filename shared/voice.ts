export type VoiceErrorCode =
  | 'invalid-request' | 'busy' | 'unsupported' | 'unsupported-locale'
  | 'on-device-unavailable' | 'recognizer-unavailable'
  | 'needs-model-download' | 'model-download-failed' | 'microphone-denied'
  | 'speech-permission-denied' | 'audio-unavailable' | 'recognition-failed'
  | 'voice-unavailable' | 'synthesis-failed' | 'stale-session' | 'cancelled'
  | 'finalization-timeout' | 'helper-unavailable' | 'helper-exited' | 'timeout' | 'protocol-error' | 'disposed';

export interface VoiceCapabilities {
  available: boolean;
  engine: 'speech-analyzer' | 'speech-recognizer' | 'unsupported';
  /** Stable code; never includes native diagnostics or recognized text. */
  reason?: string;
  locales: string[];
  voices: { id: string; name: string; language: string }[];
  needsModelDownload?: boolean;
}

export interface VoiceListenOptions {
  sessionId: string;
  locale: string;
  allowModelDownload?: boolean;
}

export interface VoiceSpeakOptions {
  sessionId: string;
  text: string;
  locale: string;
  voiceId?: string;
  /** Native AVSpeechUtterance rate, from 0.1 to 1. Omit for the system default. */
  rate?: number;
}

export interface VoiceEvent {
  sessionId: string;
  type: 'partial' | 'final' | 'listening' | 'speech-start' | 'speech-end' | 'error';
  /** Partial and final recognition results contain the cumulative transcript. */
  text?: string;
  code?: string;
}

export interface VoiceService {
  capabilities(locale?: string): Promise<VoiceCapabilities>;
  /** Resolves on command acknowledgement, not when recognition finishes. */
  listen(options: VoiceListenOptions): Promise<void>;
  stopListening(sessionId: string): Promise<{ text: string }>;
  /** Resolves on command acknowledgement. Completion is a speech-end event. */
  speak(options: VoiceSpeakOptions): Promise<void>;
  stopSpeaking(): Promise<void>;
  dispose(): Promise<void>;
}
