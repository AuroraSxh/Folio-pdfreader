import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, ChevronDown, Download, Mic, MicOff, Pause, SlidersHorizontal, Volume2, X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { VoiceController, VoicePhase, VoiceState } from '../hooks/voiceConversation';
import './voice-controls.css';

const ERRORS: Record<string, [string, string]> = {
  'no-speech': ['一分钟内没有识别到语音，麦克风已自动暂停。', 'No speech was recognized for one minute. The microphone has paused.'],
  'microphone-denied': ['麦克风权限未开启。请在系统设置 → 隐私与安全性 → 麦克风中允许 Folio，然后重试。', 'Microphone access is off. Allow Folio in System Settings → Privacy & Security → Microphone, then retry.'],
  'speech-permission-denied': ['语音识别权限未开启。请在系统设置 → 隐私与安全性 → 语音识别中允许 Folio，然后重试。', 'Speech recognition access is off. Allow Folio in System Settings → Privacy & Security → Speech Recognition, then retry.'],
  'unsupported': ['这台 Mac 的系统暂不支持语音对话，仍可使用文字对话。', 'Voice conversation is not supported on this Mac. You can still chat by typing.'],
  'on-device-unavailable': ['这台 Mac 暂不支持此语言的本机语音识别，请尝试其他语言或继续文字对话。', 'On-device recognition is unavailable for this language on this Mac. Try another language or continue by typing.'],
  'recognizer-unavailable': ['Apple 语音识别当前不可用，请稍后手动重试。', 'Apple speech recognition is currently unavailable. Please retry later.'],
  'unsupported-locale': ['此系统暂不支持所选语言的语音识别。请暂停后切换语言。', 'Speech recognition is unavailable for this language. Pause and choose another language.'],
  'needs-model-download': ['需要先下载此语言的 Apple 语音模型。', 'Download the Apple speech model for this language first.'],
  'model-download-failed': ['语音模型下载未完成。请检查网络，然后手动重试。', 'The speech model download did not finish. Check your connection and retry.'],
  'audio-unavailable': ['无法使用音频设备。请检查麦克风连接和系统输入设备，然后重试。', 'The audio device is unavailable. Check your microphone and system input device, then retry.'],
  'voice-unavailable': ['所选音色不可用，请改用系统默认音色。', 'This voice is unavailable. Choose the system default voice.'],
  'synthesis-failed': ['朗读未能完成。回答已保留在对话中，可重试语音或继续文字阅读。', 'Read-aloud could not finish. The answer remains in your chat; retry voice or continue reading.'],
  'recognition-failed': ['语音识别中断。请检查麦克风并手动重试。', 'Speech recognition stopped. Check your microphone and retry.'],
  'helper-unavailable': ['此安装中的 Apple 语音组件不可用，请重新安装支持语音的 Folio 版本。', 'The Apple speech component is unavailable in this installation. Reinstall a voice-enabled Folio build.'],
  'helper-exited': ['Apple 语音组件已退出。请手动重试。', 'The Apple speech component stopped. Please retry.'],
  'timeout': ['语音服务响应超时。请检查系统权限并重试。', 'The speech service timed out. Check system permissions and retry.'],
  'busy': ['当前对话仍在生成回答，请等待完成或先停止生成。', 'A response is still being generated. Wait for it to finish or stop generation first.'],
  'missing-key': ['请先在 AI 设置中填写 API Key，再开始语音对话。', 'Add your API key in AI settings before starting voice conversation.'],
  'no-document': ['请先导入可阅读的 PDF。', 'Import a readable PDF first.'],
  'chat-failed': ['AI 请求失败。打开阅读伙伴查看错误，检查 API 设置后再试。转写文字会保留在此处。', 'The AI request failed. Open the reading companion for details and check API settings. Your transcript remains here.'],
  'empty-answer': ['本轮没有可朗读的回答。请打开阅读伙伴查看详情，或继续下一轮。', 'There is no answer to read aloud. Open the reading companion for details, or start another turn.'],
  'cancelled': ['本轮已停止，可以继续下一轮。', 'This turn was stopped. You can start another turn.'],
  'stale-session': ['本轮语音已失效，请重新开始。', 'This voice session has ended. Please start again.'],
  'invalid-request': ['语音参数无效，请恢复默认音色或重新开启语音。', 'The speech options are invalid. Choose the default voice or restart voice conversation.'],
  'protocol-error': ['语音组件通信失败，请重新开启语音。', 'The speech component could not communicate. Restart voice conversation.'],
  'disposed': ['语音服务已关闭，请重新开启语音。', 'The speech service has stopped. Restart voice conversation.'],
};
const PHASES: Record<VoicePhase, [string, string]> = {
  idle: ['语音对话', 'Voice conversation'], checking: ['正在准备语音…', 'Preparing voice…'],
  download: ['需要语音模型', 'Speech model needed'], starting: ['正在开启麦克风…', 'Starting microphone…'],
  listening: ['正在聆听', 'Listening'], thinking: ['正在思考', 'Thinking'], speaking: ['正在朗读', 'Speaking'],
  finishing: ['正在保存阅读记忆…', 'Finishing reading memory…'], paused: ['语音已暂停', 'Voice paused'], error: ['语音已停止', 'Voice stopped'],
};

export default function VoiceControls({ host, state, controller, onSettings }: {
  host?: HTMLElement | null; state: VoiceState; controller: VoiceController; onSettings: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!state.active || !host) return null;
  const configurable = ['paused', 'error', 'download'].includes(state.phase);
  const hearing = ['checking', 'starting', 'listening'].includes(state.phase);
  const answering = ['thinking', 'speaking', 'finishing'].includes(state.phase);
  const error = state.error && ERRORS[state.error] || (state.error ? ERRORS['recognition-failed'] : undefined);
  const voices = state.capabilities?.voices.filter(voice => voice.language.toLowerCase().startsWith(state.preferences.locale.split('-')[0])) ?? [];
  return createPortal(<section className="fl-voice-controls" aria-label={t('语音对话控制', 'Voice conversation controls')} data-phase={state.phase}>
    <header className="fl-voice-heading"><span className="fl-voice-symbol">{state.phase === 'speaking' ? <Volume2 size={19} /> : state.phase === 'listening' ? <Mic size={19} /> : <AudioLines size={19} />}</span><div><strong role="status">{t(...PHASES[state.phase])}</strong><small>{state.phase === 'listening' ? t('停顿约 1.4 秒后自动发送', 'A short pause sends your question') : state.phase === 'speaking' ? t('麦克风已暂停，避免回声', 'Microphone paused to prevent echo') : t('Apple 语音 · 当前论文对话', 'Apple speech · This paper’s chat')}</small></div><button className="fl-voice-icon" aria-label={t('语音选项', 'Voice options')} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><SlidersHorizontal size={16} /></button><button className="fl-voice-icon" aria-label={t('结束语音对话', 'End voice conversation')} title={t('停止麦克风、朗读和本轮语音回答', 'Stop microphone, read-aloud, and this voice response')} onClick={() => void controller.end()}><X size={17} /></button></header>
    {state.transcript && <p className="fl-voice-transcript" aria-label={t('语音转写', 'Voice transcript')}>{state.transcript}</p>}
    {error && state.phase !== 'download' && <p className="fl-voice-error" role="alert">{t(...error)}{state.error === 'missing-key' && <button onClick={onSettings}>{t('打开 AI 设置', 'Open AI settings')}</button>}</p>}
    {state.phase === 'download' && <div className="fl-voice-download"><p>{t('此语言需要下载 Apple 语音模型。只有点击下面的按钮才开始下载；下载完成后会开启麦克风。', 'This language needs an Apple speech model. Download begins only when you click below; the microphone starts after it is ready.')}</p><button className="fl-voice-primary" onClick={() => void controller.start(true)}><Download size={14} />{t('下载模型并开始', 'Download model and start')}</button></div>}
    {expanded && <div className="fl-voice-options"><label><span>{t('对话语言', 'Conversation language')}</span><select aria-label={t('语音语言', 'Voice language')} disabled={!configurable} value={state.preferences.locale} onChange={event => controller.setPreferences({ ...state.preferences, locale: event.target.value as 'zh-CN' | 'en-US', voiceId: '' })}><option value="zh-CN">中文（普通话）</option><option value="en-US">English</option></select></label><label><span>{t('朗读音色', 'Reading voice')}</span><select aria-label={t('朗读音色', 'Reading voice')} disabled={!configurable} value={state.preferences.voiceId} onChange={event => controller.setPreferences({ ...state.preferences, voiceId: event.target.value })}><option value="">{t('系统默认', 'System default')}</option>{state.preferences.voiceId && !voices.some(voice => voice.id === state.preferences.voiceId) && <option value={state.preferences.voiceId}>{t('已保存的音色', 'Saved voice')}</option>}{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label><label><span>{t('朗读速度', 'Reading speed')}</span><select aria-label={t('朗读速度', 'Reading speed')} disabled={!configurable} value={state.preferences.rate} onChange={event => controller.setPreferences({ ...state.preferences, rate: Number(event.target.value) })}>{[[0.35, t('较慢', 'Slower')], [0.45, t('舒缓', 'Relaxed')], [0.5, t('标准', 'Normal')], [0.55, t('较快', 'Faster')], [0.65, t('快速', 'Fast')]].map(([rate, label]) => <option key={rate} value={rate}>{label}</option>)}</select></label><p>{configurable ? t('偏好仅保存在本机。语音问题与回答会保留在当前对话中。', 'Preferences stay on this device. Voice questions and answers stay in the current chat.') : t('先暂停语音，即可调整语言、音色与速度。', 'Pause voice to adjust language, voice, and speed.')}</p></div>}
    {state.phase !== 'download' && <footer className="fl-voice-actions">{hearing ? <button className="fl-voice-primary" onClick={() => void controller.pause()}><Pause size={14} />{t('暂停聆听', 'Pause listening')}</button> : answering ? <><button className="fl-voice-primary" onClick={() => void controller.interrupt()}><Mic size={14} />{t('打断并讲话', 'Interrupt and speak')}</button><button className="fl-voice-secondary" aria-label={t('暂停语音', 'Pause voice')} onClick={() => void controller.pause()}><Pause size={14} /></button></> : <button className="fl-voice-primary" onClick={() => void controller.start()}><Mic size={14} />{state.phase === 'error' ? t('重试语音', 'Retry voice') : t('继续聆听', 'Resume listening')}</button>}<button className="fl-voice-end" onClick={() => void controller.end()}><MicOff size={13} />{t('结束', 'End')}</button>{!expanded && <button className="fl-voice-locale" onClick={() => setExpanded(true)}>{state.preferences.locale === 'zh-CN' ? '中文' : 'EN'}<ChevronDown size={11} /></button>}</footer>}
  </section>, host);
}
