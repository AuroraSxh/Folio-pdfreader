import { useI18n } from '../i18n';
import './voice-guide.css';

/** Available offline; reading this guide never starts the speech service. */
export default function VoiceGuide() {
  const { t } = useI18n();
  return <details className="fl-voice-guide">
    <summary>{t('语音使用教程', 'Voice tutorial')}</summary>
    <div>
      <h4>{t('开始与结束', 'Start and stop')}</h4>
      <p>{t('语音默认关闭，启动 Folio 或重新打开文章不会自动开启。点击「语音」只打开选项；点击「开始聆听」才使用麦克风。', 'Voice is off by default and stays off when Folio starts or a paper is reopened. Voice opens the options; only Start listening activates the microphone.')}</p>
      <p>{t('先填写自己的 AI API Key。说话停顿后自动发送，转写和回答保存在当前聊天。朗读时暂停收音；可打断、暂停或结束。收起 AI 面板不会结束已经开启的语音对话。', 'Add your own AI API key first. A pause sends your question; transcripts and answers stay in this chat. The microphone pauses during playback. You can interrupt, pause, or end the session. Hiding the AI panel does not end an active voice conversation.')}</p>
      <h4>{t('下载音色与更改系统默认声音', 'Download voices and change the system default')}</h4>
      <ol>
        <li>{t('打开 macOS「系统设置 → 辅助功能 → 阅读与朗读」（较旧系统称「朗读内容」）。', 'Open macOS System Settings → Accessibility → Read & Speak (Spoken Content on older systems).')}</li>
        <li>{t('点击「系统声音」旁的 ⓘ，选择中文／普通话或英语，点进音色名称，试听并下载喜欢的增强／高级版本。不是每个音色都有高级版。', 'Click ⓘ beside System voice, choose Mandarin Chinese or English, then open a voice to preview and download an Enhanced or Premium version, when available.')}</li>
        <li>{t('下载完成后返回，点「完成」。在「系统语音语言」选择所需语言，再从「系统声音」下拉菜单选中音色，设为系统默认声音。', 'After the download completes, go back and click Done. Choose the desired System speech language, then select the voice in the System voice menu to set the system default.')}</li>
      </ol>
      <h4>{t('在 Folio 选择声音', 'Choose voices in Folio')}</h4>
      <ol>
        <li>{t('暂停语音，在「语音选项」点击「刷新音色」，分别选择中文和英文音色。例如月／黎潋（高音质）与 Ava（高音质），以本机可用列表为准。', 'Pause voice, open Voice options, and select Refresh voices. Choose Chinese and English voices separately, for example Yue / Lilian (Premium) and Ava (Premium), if available on your Mac.')}</li>
        <li>{t('先用「标准」速度，点击「试听音色」。试听无需 API Key，不收音，也不写入聊天。', 'Start at Normal speed and select Preview voices. Previewing needs no API key, microphone, or chat entry.')}</li>
      </ol>
      <p>{t('更改系统默认声音不会覆盖 Folio 已保存的选择。「自动选择最佳可用音色」优先匹配语言和音质，同级优先 Apple 接口返回的默认音色，不等同于始终跟随系统设置。要固定使用某个声音，请在 Folio 中直接选中。', 'Changing the system default does not replace saved Folio choices. Best available voice prioritizes locale and quality, then the default returned by Apple for ties; it does not always follow System Settings. Select a specific voice in Folio to keep using it.')}</p>
      <p>{t('新下载的声音可能稍后才出现在列表中；等下载完成，再刷新或关闭并重新打开语音选项。朗读音色与语音识别模型是两种下载：后者只在开始聆听时按提示处理。', 'New voices may take a moment to appear. Wait for the download to finish, then refresh or close and reopen voice options. Reading voices and recognition models are separate downloads; recognition setup is prompted when you start listening.')}</p>
    </div>
  </details>;
}
