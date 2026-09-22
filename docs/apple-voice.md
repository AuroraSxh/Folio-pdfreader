# Mac voice conversations / Mac 语音对话

Folio 0.4.0 adds voice conversations on Mac using Apple's speech recognition and installed system voices. Speech needs no separate API key. The AI provider still requires your own key and charges for text requests as usual. Windows speech support is not included in this version.

Mac 版使用 Apple 语音识别和系统朗读，无需额外语音 API Key。AI 回答仍使用你配置的服务和 Key，按文字请求计费。本版暂不包含 Windows 语音功能。

Open a paper and select **Voice** in the reading toolbar. Choose Chinese or English, then speak. After a pause, Folio sends the transcript to the current article conversation and reads the saved answer aloud. The microphone pauses during playback. You can interrupt playback to ask another question, pause the conversation, or end it. Closing the AI panel keeps the voice controls visible; switching papers, locking the screen, or closing Folio stops the session.

打开文章后，点击阅读工具栏的「语音」，选择中文或英文。说话停顿后，转写文字会发送到当前文章的对话，回答保存后由系统朗读。朗读期间暂停麦克风，可打断后继续提问，也可暂停或结束。收起 AI 面板后，语音控制条仍可使用；切换文章、锁屏或关闭 Folio 时停止语音。

User transcripts and AI answers share the existing chat history and article context. Raw microphone audio is processed in memory and is not saved by Folio. Apple recognition is configured for on-device processing; transcripts and paper context are sent to the AI provider you selected.

用户转写和 AI 回答共用现有聊天记录与文章上下文。Folio 不保存原始录音。Apple 识别使用本地处理；转写文字和论文上下文会按现有 AI 设置发送给所选服务。

## Availability / 兼容性

- macOS 26+: uses SpeechAnalyzer when the selected language and device are supported. Missing Apple language models require an explicit download action before listening starts.
- Older supported macOS releases: uses SFSpeechRecognizer only when on-device recognition is available. It never silently switches to server recognition. Reading and text chat remain available when speech is unsupported.
- Microphone permission is requested only when you start listening. Older recognition APIs may also require speech recognition permission. Permission denial stops the session with a visible explanation.
- 首次使用可能需要允许麦克风权限或下载 Apple 语言模型；只有点击启用后才会请求。不同设备、系统和语言的可用性由运行时检查。

## Development

`npm run build` and `npm run dev` build a universal Swift helper on macOS. Build inputs are cached; Windows builds skip the helper. The helper is packaged as `Resources/apple-speech/Folio Speech.app`, separate from the renderer and loaded only on demand. It receives bounded JSON messages over pipes; it does not expose a network service.

Apple references: [SpeechAnalyzer](https://developer.apple.com/videos/play/wwdc2025/277/), [on-device availability](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition), [speech synthesis](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/).

## Validation / 验证

Folio 0.4.0 passed the production build, 121 unit tests, and 32 packaged-app UI checks on an Apple Silicon Mac running macOS 26.2. Six voice UI checks simulate speech and AI responses; they cover hidden-panel conversations, interruptions, cleanup, model-download consent, and permission failures.

The packaged native helper also synthesized a fixed Chinese sentence to a temporary audio file and transcribed it with Apple's real on-device APIs. The result matched “这篇论文的主要结论是什么” after punctuation normalization. This test used neither the microphone nor the speakers. A real packaged-app IPC check confirmed that the helper starts only on demand and exits after becoming idle. Packaging checks verified microphone usage declarations, audio-input entitlements, and both arm64 and x86_64 binaries.

Real microphone capture, audible playback, and voice performance during a live AI conversation remain for manual testing. Intel Macs and older macOS versions have not been run-tested; English synthesis passed, but English recognition was not tested because its model was not installed. See [performance measurements](performance-v0.4.0.md).

0.4.0 已通过构建、121 项单元测试和 32 项打包版界面检查；中文原生朗读生成的临时音频也通过了真实 Apple 本地识别。测试没有开启麦克风或扬声器。麦克风实录、实际播放和连续语音的资源占用留待手动验证；不将模拟测试算作实录通过。
