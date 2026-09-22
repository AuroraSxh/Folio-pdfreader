import { useI18n } from '../i18n';
import { PLATFORM } from '../platform';
import './voice-guide.css';

/** Available offline; reading this guide never starts the speech service. */
export default function VoiceGuide() {
  const { t } = useI18n();
  return <details className="fl-voice-guide">
    <summary>{t('语音使用教程', 'Voice tutorial')}</summary>
    <div>
      <h4>{t('开始与结束', 'Start and stop')}</h4>
      <p>{t('语音默认关闭，启动 Pairleaf 或重新打开文章不会自动开启。点击「语音」只打开选项；点击「开始聆听」才使用麦克风。', 'Voice is off by default and stays off when Pairleaf starts or a paper is reopened. Voice opens the options; only Start listening activates the microphone.')}</p>
      <p>{t('先填写自己的 AI API Key。说话停顿后自动发送，转写和回答保存在当前聊天。朗读时暂停收音；可打断、暂停或结束。收起 AI 面板不会结束已经开启的语音对话。', 'Add your own AI API key first. A pause sends your question; transcripts and answers stay in this chat. The microphone pauses during playback. You can interrupt, pause, or end the session. Hiding the AI panel does not end an active voice conversation.')}</p>
      <p>{t('遇到误录内容，可在提问或回答下点击「删除」，确认后移除本轮问答及关联的自动记忆。删除时会结束正在进行的语音；旧版记忆如有残留，可在「记忆」中单独删除。', 'For unwanted transcripts, select Delete below the question or answer and confirm to remove that exchange and its linked automatic memories. Deleting ends active voice. Any older memory without a source link can be removed in Memory.')}</p>
      {PLATFORM === 'win32' ? <>
        <h4>{t('Windows 本地语音（实验性）', 'Windows local speech (experimental)')}</h4>
        <p>{t('语音识别取决于本机已安装的语音引擎。部分新版 Windows 缺少可用的本地听写引擎；安装语言组件也不保证可用。识别不可用时可继续文字提问，如有可用音色仍可试听。Pairleaf 不会自动改用云端识别。', 'Recognition depends on the speech engine installed on this PC. Some newer Windows versions lack a usable local dictation engine, and adding language components does not guarantee support. If recognition is unavailable, type your questions; available voices can still be previewed. Pairleaf never falls back to cloud recognition.')}</p>
        <ol>
          <li>{t('Windows 11：设置 → 时间和语言 → 语言和区域，进入所需语言的「语言选项」，检查系统提供的语音组件。Windows 10 位于「时间和语言 → 语言」。', 'On Windows 11, open Settings → Time & language → Language & region, then Language options for your language and check the available speech components. On Windows 10, use Time & language → Language.')}</li>
          <li>{t('Windows 11：设置 → 隐私和安全性 → 麦克风，允许麦克风及桌面应用访问。Windows 10 位于「隐私 → 麦克风」。', 'On Windows 11, open Settings → Privacy & security → Microphone and allow microphone and desktop app access. On Windows 10, use Privacy → Microphone.')}</li>
          <li>{t('回到 Pairleaf 点击「刷新音色」，从实际返回的列表分别选择中文和英文音色，再点「试听音色」。试听无需 API Key，不开启麦克风。', 'Return to Pairleaf and select Refresh voices. Choose Chinese and English voices from the available list, then Preview voices. No API key or microphone is needed for previews.')}</li>
        </ol>
        <p>{t('系统中的语音组件、识别引擎和「讲述人」音色不完全相同。讲述人的自然语音不保证出现在 Pairleaf 中；请以应用列出的音色为准。', 'Windows speech components, recognition engines, and Narrator voices are separate. Narrator natural voices may not be available to Pairleaf; use the voices actually listed by the app.')}</p>
        <p>{t('更改系统声音不会覆盖 Pairleaf 已保存的选择。选择具体音色可固定使用；系统组件变更后，刷新或关闭并重新打开语音选项。', 'Changing system voices does not replace saved Pairleaf choices. Select a specific voice to keep using it. After changing system components, refresh or close and reopen voice options.')}</p>
      </> : <>
      <h4>{t('Mac：下载音色与更改系统默认声音', 'On Mac: download voices and change the system default')}</h4>
      <ol>
        <li>{t('打开 macOS「系统设置 → 辅助功能 → 阅读与朗读」（较旧系统称「朗读内容」）。', 'Open macOS System Settings → Accessibility → Read & Speak (Spoken Content on older systems).')}</li>
        <li>{t('点击「系统声音」旁的 ⓘ，选择中文／普通话或英语，点进音色名称，试听并下载喜欢的增强／高级版本。不是每个音色都有高级版。', 'Click ⓘ beside System voice, choose Mandarin Chinese or English, then open a voice to preview and download an Enhanced or Premium version, when available.')}</li>
        <li>{t('下载完成后返回，点「完成」。在「系统语音语言」选择所需语言，再从「系统声音」下拉菜单选中音色，设为系统默认声音。', 'After the download completes, go back and click Done. Choose the desired System speech language, then select the voice in the System voice menu to set the system default.')}</li>
      </ol>
      <h4>{t('在 Pairleaf 选择声音', 'Choose voices in Pairleaf')}</h4>
      <ol>
        <li>{t('暂停语音，在「语音选项」点击「刷新音色」，分别选择中文和英文音色。例如月／黎潋（高音质）与 Ava（高音质），以本机可用列表为准。', 'Pause voice, open Voice options, and select Refresh voices. Choose Chinese and English voices separately, for example Yue / Lilian (Premium) and Ava (Premium), if available on your Mac.')}</li>
        <li>{t('先用「标准」速度，点击「试听音色」。试听无需 API Key，不收音，也不写入聊天。', 'Start at Normal speed and select Preview voices. Previewing needs no API key, microphone, or chat entry.')}</li>
      </ol>
      <p>{t('更改系统默认声音不会覆盖 Pairleaf 已保存的选择。「自动选择最佳可用音色」优先匹配语言和音质，同级优先 Apple 接口返回的默认音色，不等同于始终跟随系统设置。要固定使用某个声音，请在 Pairleaf 中直接选中。', 'Changing the system default does not replace saved Pairleaf choices. Best available voice prioritizes locale and quality, then the default returned by Apple for ties; it does not always follow System Settings. Select a specific voice in Pairleaf to keep using it.')}</p>
      <p>{t('新下载的声音可能稍后才出现在列表中；等下载完成，再刷新或关闭并重新打开语音选项。朗读音色与语音识别模型是两种下载：后者只在开始聆听时按提示处理。', 'New voices may take a moment to appear. Wait for the download to finish, then refresh or close and reopen voice options. Reading voices and recognition models are separate downloads; recognition setup is prompted when you start listening.')}</p>
      </>}
    </div>
  </details>;
}
