import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, ChevronDown, Download, Mic, MicOff, Pause, RefreshCw, SlidersHorizontal, Volume2, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { PLATFORM } from '../platform';
import type { VoiceController, VoicePhase, VoiceState } from '../hooks/voiceConversation';
import type { InstalledVoice, VoiceQuality } from '../../shared/voice';
import VoiceGuide from './VoiceGuide';
import './voice-controls.css';

const ERRORS: Record<string, [string, string]> = {
  'no-speech': ['一分钟内没有识别到语音，麦克风已自动暂停。', 'No speech was recognized for one minute. The microphone has paused.'],
  'microphone-denied': ['麦克风权限未开启。请在系统设置 → 隐私与安全性 → 麦克风中允许 Pairleaf，然后重试。', 'Microphone access is off. Allow Pairleaf in System Settings → Privacy & Security → Microphone, then retry.'],
  'speech-permission-denied': ['语音识别权限未开启。请在系统设置 → 隐私与安全性 → 语音识别中允许 Pairleaf，然后重试。', 'Speech recognition access is off. Allow Pairleaf in System Settings → Privacy & Security → Speech Recognition, then retry.'],
  'unsupported': ['这台 Mac 的系统暂不支持语音对话，仍可使用文字对话。', 'Voice conversation is not supported on this Mac. You can still chat by typing.'],
  'on-device-unavailable': ['这台 Mac 暂不支持此语言的本机语音识别，请尝试其他语言或继续文字对话。', 'On-device recognition is unavailable for this language on this Mac. Try another language or continue by typing.'],
  'recognizer-unavailable': ['Apple 语音识别当前不可用，请稍后手动重试。', 'Apple speech recognition is currently unavailable. Please retry later.'],
  'unsupported-locale': ['此系统暂不支持所选语言的语音识别。请暂停后切换语言。', 'Speech recognition is unavailable for this language. Pause and choose another language.'],
  'needs-model-download': ['需要先下载此语言的 Apple 语音模型。', 'Download the Apple speech model for this language first.'],
  'model-download-failed': ['语音模型下载未完成。请检查网络，然后手动重试。', 'The speech model download did not finish. Check your connection and retry.'],
  'audio-unavailable': ['无法使用音频设备。请检查麦克风连接和系统输入设备，然后重试。', 'The audio device is unavailable. Check your microphone and system input device, then retry.'],
  'voice-unavailable': ['所选音色不可用，请刷新音色列表或改用自动选择。', 'This voice is unavailable. Refresh the voice list or choose automatic selection.'],
  'synthesis-failed': ['朗读未能完成。回答已保留在对话中，可重试语音或继续文字阅读。', 'Read-aloud could not finish. The answer remains in your chat; retry voice or continue reading.'],
  'recognition-failed': ['语音识别中断。请检查麦克风并手动重试。', 'Speech recognition stopped. Check your microphone and retry.'],
  'helper-unavailable': ['此安装中的 Apple 语音组件不可用，请重新安装支持语音的 Pairleaf 版本。', 'The Apple speech component is unavailable in this installation. Reinstall a voice-enabled Pairleaf build.'],
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
const WINDOWS_ERRORS: Record<string, [string, string]> = {
  'microphone-denied': ['麦克风访问未开启。Windows 11：设置 → 隐私和安全性 → 麦克风，允许麦克风访问及桌面应用访问；Windows 10 位于「隐私」。', 'Microphone access is off. In Windows 11, open Settings → Privacy & security → Microphone and allow microphone and desktop app access. On Windows 10, use Privacy.'],
  'speech-permission-denied': ['本机语音权限不可用。请检查 Windows 麦克风与桌面应用权限，然后重试。', 'Local speech access is unavailable. Check Windows microphone and desktop app permissions, then retry.'],
  'unsupported': ['此设备暂不支持实验性 Windows 语音对话，仍可使用文字对话。', 'Experimental Windows voice conversation is unavailable on this device. You can still chat by typing.'],
  'on-device-unavailable': ['此语言的本地识别不可用。可换一种语言或继续文字输入，不会自动改用云端识别。', 'Local recognition is unavailable for this language. Choose another language or type instead; recognition never falls back to the cloud.'],
  'recognizer-unavailable': ['未找到此语言可用的本地识别引擎。仍可试听音色或文字提问；安装语言组件不保证能够启用识别。', 'No usable local recognition engine was found for this language. You can still preview voices or type questions; installing language components does not guarantee recognition support.'],
  'needs-model-download': ['请在 Windows 语言设置中检查语音组件，再刷新或重新打开语音选项。', 'Check speech components in Windows language settings, then refresh or reopen voice options.'],
  'helper-unavailable': ['此安装中的 Windows 语音组件不可用，请重新安装支持语音的 Pairleaf 版本。', 'The Windows speech component is unavailable in this installation. Reinstall a voice-enabled Pairleaf build.'],
  'helper-exited': ['Windows 语音组件已退出。请手动重试。', 'The Windows speech component stopped. Please retry.'],
};
const PHASES: Record<VoicePhase, [string, string]> = {
  idle: ['语音对话', 'Voice conversation'], checking: ['正在准备语音…', 'Preparing voice…'],
  download: ['需要语音模型', 'Speech model needed'], starting: ['正在开启麦克风…', 'Starting microphone…'],
  listening: ['正在聆听', 'Listening'], thinking: ['正在思考', 'Thinking'], speaking: ['正在朗读', 'Speaking'],
  previewing: ['正在试听音色', 'Previewing voices'],
  finishing: ['正在保存阅读记忆…', 'Finishing reading memory…'], paused: ['语音已暂停', 'Voice paused'], error: ['语音已停止', 'Voice stopped'],
};
const QUALITY_LABELS: Record<VoiceQuality, [string, string]> = { default: ['普通', 'Standard'], enhanced: ['增强', 'Enhanced'], premium: ['高级', 'Premium'] };
const QUALITY_RANK: Record<VoiceQuality, number> = { default: 0, enhanced: 1, premium: 2 };
function languageVoices(voices: InstalledVoice[], language: string) {
  return voices.filter(voice => voice.language.toLowerCase().startsWith(language))
    .sort((a, b) => QUALITY_RANK[b.quality ?? 'default'] - QUALITY_RANK[a.quality ?? 'default'] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export default function VoiceControls({ host, state, controller, onSettings }: {
  host?: HTMLElement | null; state: VoiceState; controller: VoiceController; onSettings: () => void;
}) {
  const { t } = useI18n();
  const windows = PLATFORM === 'win32';
  const [expanded, setExpanded] = useState(true);
  useEffect(() => { if (state.active) setExpanded(true); }, [state.active]);
  if (!state.active || !host) return null;
  const configurable = ['paused', 'error', 'download'].includes(state.phase);
  const hearing = ['checking', 'starting', 'listening'].includes(state.phase);
  const answering = ['thinking', 'speaking', 'finishing'].includes(state.phase);
  const error = state.error && (windows && WINDOWS_ERRORS[state.error] || ERRORS[state.error]) || (state.error ? ERRORS['recognition-failed'] : undefined);
  const allVoices = state.capabilities?.voices ?? [];
  const readingVoices = allVoices.filter(voice => /^(zh|en)(-|$)/i.test(voice.language));
  const standardVoicesOnly = readingVoices.length > 0 && readingVoices.every(voice => (voice.quality ?? 'default') === 'default');
  const previewing = state.phase === 'previewing';
  const startListening = (allowModelDownload = false) => { setExpanded(false); void controller.start(allowModelDownload); };
  const voicePicker = (language: 'zh' | 'en', label: [string, string], field: 'chineseVoiceId' | 'englishVoiceId') => {
    const voices = languageVoices(allVoices, language), selected = state.preferences[field];
    return <label><span>{t(...label)}</span><select aria-label={t(...label)} disabled={!configurable} value={selected} onChange={event => controller.setPreferences({ ...state.preferences, [field]: event.target.value })}>
      <option value="">{windows ? t('自动选择本机可用音色', 'Automatic local voice') : t('自动选择最佳可用音色', 'Best available voice')}</option>
      {selected && !voices.some(voice => voice.id === selected) && <option value={selected}>{t('已保存的音色（暂不可用）', 'Saved voice (unavailable)')}</option>}
      {voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name} · {windows ? '' : `${t(...QUALITY_LABELS[voice.quality ?? 'default'])} · `}{voice.language}</option>)}
    </select></label>;
  };
  return createPortal(<section className="fl-voice-controls" aria-label={t('语音对话控制', 'Voice conversation controls')} data-phase={state.phase}>
    <header className="fl-voice-heading"><span className="fl-voice-symbol">{state.phase === 'speaking' || previewing ? <Volume2 size={19} /> : state.phase === 'listening' ? <Mic size={19} /> : <AudioLines size={19} />}</span><div><strong role="status">{t(...PHASES[state.phase])}</strong><small>{state.phase === 'listening' ? t('停顿约 1.4 秒后自动发送', 'A short pause sends your question') : previewing ? t('只播放示例 · 麦克风关闭', 'Sample only · Microphone off') : state.phase === 'speaking' ? t('麦克风已暂停，避免回声', 'Microphone paused to prevent echo') : windows ? t('Windows 本地语音 · 实验性', 'Windows local speech · Experimental') : t('Apple 语音 · 当前论文对话', 'Apple speech · This paper’s chat')}</small></div><button className="fl-voice-icon" aria-label={t('语音选项', 'Voice options')} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><SlidersHorizontal size={16} /></button><button className="fl-voice-icon" aria-label={t('结束语音对话', 'End voice conversation')} title={t('停止麦克风、朗读和本轮语音回答', 'Stop microphone, read-aloud, and this voice response')} onClick={() => void controller.end()}><X size={17} /></button></header>
    {windows && <p className="fl-voice-platform-note">{t('实验性功能，取决于本机语音引擎。识别在本地进行，不会自动转云服务。', 'Experimental; availability depends on the local speech engine. Recognition stays on-device with no automatic cloud fallback.')}</p>}
    {windows && state.capabilities && !state.capabilities.available && !state.error && <p className="fl-voice-error" role="status">{t('此语言的本地识别当前不可用。可试听已列出的音色，或继续文字对话。', 'Local recognition is currently unavailable for this language. You can preview the listed voices or continue by typing.')}</p>}
    {state.transcript && <p className="fl-voice-transcript" aria-label={t('语音转写', 'Voice transcript')}>{state.transcript}</p>}
    {error && state.phase !== 'download' && <p className="fl-voice-error" role="alert">{t(...error)}{state.error === 'missing-key' && <button onClick={onSettings}>{t('打开 AI 设置', 'Open AI settings')}</button>}</p>}
    {state.phase === 'download' && <div className="fl-voice-download">{windows ? <p>{t(...WINDOWS_ERRORS['needs-model-download'])}</p> : <><p>{t('此语言需要下载 Apple 语音模型。只有点击下面的按钮才开始下载；下载完成后会开启麦克风。', 'This language needs an Apple speech model. Download begins only when you click below; the microphone starts after it is ready.')}</p><button className="fl-voice-primary" onClick={() => startListening(true)}><Download size={14} />{t('下载模型并开始', 'Download model and start')}</button></>}</div>}
    {expanded && <div className="fl-voice-options">
      <p>{t('语音默认关闭，点击「开始聆听」后才使用麦克风。', 'Voice is off by default. The microphone starts only when you select Start listening.')}</p>
      <label><span>{t('识别语言', 'Recognition language')}</span><select aria-label={t('识别语言', 'Recognition language')} disabled={!configurable} value={state.preferences.locale} onChange={event => controller.setPreferences({ ...state.preferences, locale: event.target.value as 'zh-CN' | 'en-US' })}><option value="zh-CN">中文（普通话）</option><option value="en-US">English</option></select></label>
      <p>{t('用于识别你的提问，也决定 AI 回答的语言。', 'Used for your spoken questions and the language of AI replies.')}</p>
      <label><span>{t('朗读模式', 'Reading mode')}</span><select aria-label={t('朗读模式', 'Reading mode')} disabled={!configurable} value={state.preferences.readingMode} onChange={event => controller.setPreferences({ ...state.preferences, readingMode: event.target.value as 'auto' | 'zh-CN' | 'en-US' })}><option value="auto">{t('自动中英文混读', 'Automatic Chinese / English')}</option><option value="zh-CN">{t('始终使用中文音色', 'Always use Chinese voice')}</option><option value="en-US">{t('始终使用英文音色', 'Always use English voice')}</option></select></label>
      {voicePicker('zh', ['中文音色', 'Chinese voice'], 'chineseVoiceId')}
      {voicePicker('en', ['英文音色', 'English voice'], 'englishVoiceId')}
      <label><span>{t('朗读速度', 'Reading speed')}</span><select aria-label={t('朗读速度', 'Reading speed')} disabled={!configurable} value={state.preferences.rate} onChange={event => controller.setPreferences({ ...state.preferences, rate: Number(event.target.value) })}>{[[0.35, t('较慢', 'Slower')], [0.45, t('舒缓', 'Relaxed')], [0.5, t('标准', 'Normal')], [0.55, t('较快', 'Faster')], [0.65, t('快速', 'Fast')]].map(([rate, label]) => <option key={rate} value={rate}>{label}</option>)}</select></label>
      <p>{t('英文单词和短语连续朗读，常见实验符号按读法处理；完整引用保留在聊天中。', 'English words and phrases are read continuously, with spoken forms for common scientific notation. Full citations stay in the chat.')}</p>
      <div className="fl-voice-preview-actions"><button className="fl-voice-secondary" aria-label={t('试听音色', 'Preview voices')} disabled={!configurable} onClick={() => void controller.preview()}><Volume2 size={14} />{t('试听音色', 'Preview voices')}</button><button className="fl-voice-refresh" aria-label={t('刷新音色', 'Refresh voices')} disabled={!configurable} onClick={() => void controller.refreshVoices()}><RefreshCw size={13} />{t('刷新音色', 'Refresh voices')}</button></div>
      <p>{t('按可用音色试听示例，无需 API Key，也不会开启麦克风或写入对话。', 'Preview a sample using available voices. No API key, microphone, or chat entry is needed.')}</p>
      {!windows && standardVoicesOnly && <p className="fl-voice-quality-note">{t('当前可用的中英文音色均为普通音质。可在系统设置下载增强／高级音色，再刷新。', 'The available Chinese and English voices are all Standard quality. Download Enhanced / Premium voices in System Settings, then refresh.')}</p>}
      <VoiceGuide/>
      {!configurable && !previewing && <p>{t('先暂停语音，即可调整语言、音色与速度。', 'Pause voice to adjust language, voice, and speed.')}</p>}
    </div>}
    {state.phase !== 'download' && <footer className="fl-voice-actions">{previewing ? <button className="fl-voice-primary" aria-label={t('停止试听', 'Stop preview')} onClick={() => void controller.stopPreview()}><Pause size={14} />{t('停止试听', 'Stop preview')}</button> : hearing ? <button className="fl-voice-primary" onClick={() => void controller.pause()}><Pause size={14} />{t('暂停聆听', 'Pause listening')}</button> : answering ? <><button className="fl-voice-primary" onClick={() => { setExpanded(false); void controller.interrupt(); }}><Mic size={14} />{t('打断并讲话', 'Interrupt and speak')}</button><button className="fl-voice-secondary" aria-label={t('暂停语音', 'Pause voice')} onClick={() => void controller.pause()}><Pause size={14} /></button></> : <button className="fl-voice-primary" onClick={() => startListening()}><Mic size={14} />{state.phase === 'error' ? t('重试语音', 'Retry voice') : state.transcript ? t('继续聆听', 'Resume listening') : t('开始聆听', 'Start listening')}</button>}<button className="fl-voice-end" onClick={() => void controller.end()}><MicOff size={13} />{t('结束', 'End')}</button>{!expanded && <button className="fl-voice-locale" onClick={() => setExpanded(true)}>{state.preferences.locale === 'zh-CN' ? '中文' : 'EN'}<ChevronDown size={11} /></button>}</footer>}
  </section>, host);
}
