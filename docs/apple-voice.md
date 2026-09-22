# Mac 语音教程 / Mac voice guide

[中文教程](#中文教程) · [English guide](#english-guide)

适用于 Folio 0.4.1。Mac 版使用 Apple 语音识别和系统朗读，无需额外语音 API Key；AI 对话仍需要你自己的 Key。本版不包含 Windows 语音功能。

For Folio 0.4.1 on Mac. Apple recognition and system voices need no extra speech API key; AI conversations still require your own provider key. Windows voice support is not included.

## 中文教程

### 开始语音对话

**语音默认关闭，重启 Folio 不会恢复聆听或朗读。** 已选音色和语速会保存，但不会因此自动开启语音。

1. 打开一篇论文，点击工具栏的「语音」。这一步只打开选项，麦克风仍关闭。
2. 选择「识别语言」，再分别选择「中文音色」「英文音色」和朗读速度。识别语言也决定 AI 回答的语言，朗读音色可单独设置。
3. 点击「试听音色」比较同一段中英混合示例。试听不需要 API Key、不调用 AI、不收音，也不写入聊天记录；播完后保持暂停。
4. 准备提问时，点击「开始聆听」。首次使用按系统提示允许麦克风访问；若缺少识别模型，需明确点击「下载模型并开始」。AI Key 在现有 AI 设置中填写。
5. 说完稍作停顿，问题会发送到当前论文对话。朗读回答时麦克风暂停；点击「打断并讲话」可继续提问，「暂停」或「结束」可停止。

收起 AI 面板后仍能语音对话，再打开时可看到相同的转写和回答。切换论文、锁屏或退出 Folio 会停止语音；再次使用需要手动开启。

### 下载更好的声音，并更改 Mac 默认声音

以下是 macOS 26 的操作路径：

1. 打开 **系统设置 → 辅助功能 → 阅读与朗读**。
2. 点击「系统声音」旁的 **ⓘ**，找到需要的语言和音色，可先试听，再下载增强或高级版本。
3. 等待下载完成，返回并点击「完成」。若要改 Mac 默认朗读音色，在「系统声音」下拉菜单中选中刚下载的声音；必要时先切换「系统语音语言」。

下载声音和设为系统默认是两个步骤。[Apple 官方说明](https://support.apple.com/zh-cn/guide/mac-help/mchlp2290/mac)

### 在 Folio 中使用下载的音色

回到 Folio 的语音选项，点击「刷新音色」。在「中文音色」和「英文音色」中分别选带「高级」或「增强」标记的声音，再点击「试听音色」。如果列表没有更新，等下载完全结束后再次刷新，或结束并重新打开语音选项。

开发用 Mac 已在 Folio 中识别到高级音色 **月（Yue）、黎潋（Lilian）、莉莉和 Ava**。你的系统版本、语言和已安装声音可能不同，以 Folio 列表实际显示为准；系统里能下载的声音不一定都能供 Folio 使用。

**更改 Mac 默认声音不会覆盖 Folio 已保存的音色选择。** 想一直使用某个声音，请在 Folio 的中英文下拉菜单里直接选它。「自动选择最佳可用音色」优先考虑对应语言的音质，同质量时优先系统选择，因此并非严格跟随系统默认。

### 混读、术语与引用

「自动中英文混读」会用英文音色连续读英文单词和短语。常见实验符号有专门读法，例如 `CD4+ T cells` 和 `fl/fl`；句末文件引用会跳过，明确提及的来源页码简化为「正文第7页」等。聊天中的原文、术语和可点击引用不变。

两种声音仍可能有音色差异，可以分别试听、调整语速，也可选择固定使用中文或英文音色。高级音质是系统提供的分类，不保证每个人都觉得更自然。

Folio 不保存原始录音。Apple 识别使用本地处理；问题转写和论文上下文仍会按你的 AI 设置发送给所选服务，AI 按文字请求计费。

## English guide

### Start a conversation

**Voice is off by default. Restarting Folio never resumes listening or playback.** Your voice and speed preferences are saved separately.

1. Open a paper and select **Voice** in the toolbar. This opens the options; the microphone stays off.
2. Choose the recognition language, then your Chinese and English voices and reading speed. Recognition language also determines the language of AI replies; reading voices are independent.
3. Select **Preview voices** to hear a fixed mixed-language sample. It needs no API key, AI request, microphone, or chat entry. Playback finishes in the paused state.
4. Select **Start listening** when ready. Allow microphone access if prompted. If a recognition model is missing, use **Download model and start** explicitly. Add your provider key in the existing AI settings for conversation.
5. Pause briefly after speaking to send your question to the paper's conversation. The microphone pauses while the answer is read aloud. Use **Interrupt and speak**, pause, or end as needed.

Voice remains available with the AI panel hidden; reopening it shows the same transcript and answer. Switching papers, locking the screen, or quitting Folio stops the session. Start it manually next time.

### Download voices and change the Mac system default

On macOS 26:

1. Open **System Settings → Accessibility → Read & Speak**.
2. Select **ⓘ** beside **System voice**. Find a language and voice, preview it, and download an Enhanced or Premium version if available.
3. Let the download finish, return, and choose **Done**. To make it the Mac default, select it in the **System voice** menu; change **System speech language** first if needed.

Installing a voice and choosing the system default are separate steps. [Apple's instructions](https://support.apple.com/guide/mac-help/mchlp2290/26/mac/26)

### Select the voices in Folio

Return to Folio's options and select **Refresh voices**. Choose voices marked **Premium** or **Enhanced** independently under **Chinese voice** and **English voice**, then preview them. If a new voice is missing, wait for its download to finish and refresh again, or close and reopen the voice options.

On the development Mac, Folio detected **月 (Yue), 黎潋 (Lilian), 莉莉, and Ava** as Premium voices. Availability depends on your Mac, languages, and installed voices. Use the list Folio actually exposes; not every downloadable system voice is available to the app.

**Changing the Mac default does not replace a voice already selected in Folio.** Select a specific voice in each Folio menu to keep using it. **Best available voice** prefers quality for the matching language, with the system choice breaking ties. It does not strictly follow the system default.

### Mixed languages, terminology, and references

Automatic mode reads English words and phrases with the English voice. Common scientific notation, including `CD4+ T cells` and `fl/fl`, has spoken forms. Bracketed file citations are silent; explicit page references become shorter locations such as “main text page 7”. The saved answer and clickable citations remain intact.

The two voices can still sound different. Preview each, adjust speed, or select a fixed reading language. Premium is a system quality category, not a guarantee of a more natural sound for every listener.

Folio does not save raw microphone audio. Recognition runs on-device; transcripts and paper context still go to your selected AI provider, with normal text-request charges.

## Availability / 兼容性

- macOS 26+: uses SpeechAnalyzer when the selected language and device are supported. Missing Apple language models require an explicit download action before listening starts.
- Older supported macOS releases: uses SFSpeechRecognizer only when on-device recognition is available. It never silently switches to server recognition. Reading and text chat remain available when speech is unsupported.
- Microphone permission is requested only when you start listening. Older recognition APIs may also require speech recognition permission. Permission denial stops the session with a visible explanation.
- 首次使用可能需要允许麦克风权限或下载 Apple 语言模型；只有点击启用后才会请求。不同设备、系统和语言的可用性由运行时检查。

## Development

`npm run build` and `npm run dev` build a universal Swift helper on macOS. Build inputs are cached; Windows builds skip the helper. The helper is packaged as `Resources/apple-speech/Folio Speech.app`, separate from the renderer and loaded only on demand. It receives bounded JSON messages over pipes; it does not expose a network service.

Apple references: [SpeechAnalyzer](https://developer.apple.com/videos/play/wwdc2025/277/), [on-device availability](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition), [speech synthesis](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/).

## 0.4.1 release checks / 正式包验证

The final Mac universal package passed the production build, 149 unit tests, and 38 packaged-app UI checks (12 voice, 20 reading, 6 language/update). Voice checks cover startup, reopening a paper, retaining voice preferences without resuming audio, and both tutorial languages. Real Apple file synthesis also passed for nine mixed-language segments using installed Premium Lili and Ava voices. Automated checks use no microphone, speaker playback, or live AI requests; they do not measure subjective naturalness. Intel Mac and older macOS have not been run-tested.

最终 Mac 通用包通过构建、149 项单元测试与 38 项界面检查（语音 12、阅读 20、双语及更新 6），覆盖默认关闭、重开文章不恢复会话、保留音色及双语教程。真实 Apple 文件合成用已安装的高级莉莉和 Ava 完成 9 段混合文本。自动检查不使用麦克风、扬声器或真实 AI，不代表听感评估；Intel Mac 与旧版 macOS 尚未实机测试。

## Previous checks / 历史验证

These are earlier development results, not a validation count for the final 0.4.1 release. An earlier 0.4.1 preview passed the production build, 148 unit tests, and nine packaged-app voice UI checks. Real Apple file synthesis produced audio for nine Chinese/English segments, including CD4+ and fl/fl, without using speakers or the microphone. Real IPC checks covered quality metadata, lazy helper startup, and idle exit. Before additional voice downloads, this Mac exposed 180 Standard voices; Enhanced/Premium ordering was then tested with fixtures. Later enumeration detected the downloaded Premium voices listed in the guide above. Enumeration and automated synthesis do not establish subjective naturalness. See the separate [final 0.4.1 performance measurements](performance-v0.4.1.md).

以下数字来自较早的开发测试，不代表 0.4.1 正式发布包的最终测试数量。较早的 0.4.1 预览版通过构建、148 项单元测试和 9 项打包版语音界面检查；真实 Apple 文件合成完成包含 CD4+、fl/fl 的 9 段文本，IPC 检查覆盖音色信息及组件按需启动、空闲退出。这些检查没有开启麦克风、扬声器或调用真实 AI。当时尚未下载额外音色，180 个声音均为普通音质；随后已在实机枚举到上文列出的高级音色。枚举与文件合成不等同于实际听感验证。

Folio 0.4.0 passed the production build, 121 unit tests, and 32 packaged-app UI checks on an Apple Silicon Mac running macOS 26.2. Six voice UI checks simulate speech and AI responses; they cover hidden-panel conversations, interruptions, cleanup, model-download consent, and permission failures.

The packaged native helper also synthesized a fixed Chinese sentence to a temporary audio file and transcribed it with Apple's real on-device APIs. The result matched “这篇论文的主要结论是什么” after punctuation normalization. This test used neither the microphone nor the speakers. A real packaged-app IPC check confirmed that the helper starts only on demand and exits after becoming idle. Packaging checks verified microphone usage declarations, audio-input entitlements, and both arm64 and x86_64 binaries.

Real microphone capture, audible playback, and voice performance during a live AI conversation remain for manual testing. Intel Macs and older macOS versions have not been run-tested; English synthesis passed, but English recognition was not tested because its model was not installed. See [performance measurements](performance-v0.4.0.md).

0.4.0 已通过构建、121 项单元测试和 32 项打包版界面检查；中文原生朗读生成的临时音频也通过了真实 Apple 本地识别。测试没有开启麦克风或扬声器。麦克风实录、实际播放和连续语音的资源占用留待手动验证；不将模拟测试算作实录通过。

## 0.4.1 reading improvements / 朗读改进

Chinese and English voices are saved independently of recognition language. Automatic selection prefers the highest installed quality for the matching locale, uses the system choice to break quality ties, and avoids novelty voices when a normal voice is available. Voice lists show Standard, Enhanced, or Premium quality. Download additional voices through macOS Accessibility → Read & Speak, then use Refresh voices. Folio does not download voices automatically.

中文、英文音色独立保存，识别语言与朗读设置分开。自动选择优先使用匹配语言中已安装的高质量音色，同质量优先系统默认。音色列表标注普通、增强、高级；只有普通声音时会提示到系统设置下载更多音色。试听无需 AI Key，不写入聊天记录，结束后停在暂停状态。

In automatic mode, English words and consecutive phrases inside Chinese use the English voice as complete pronunciation units. The entire answer is one playback session, with no added delay at language boundaries and no microphone restart between segments. Fixed Chinese or English voice modes remain available. Different system voices can still have different timbres; a zero extra delay does not guarantee inaudible transitions.

自动混读会将中文中的英文词语或连续短语交给英文音色完整朗读，不把每个字母拆成单独的播放段。全篇回答共用一次播放会话，语言交接不增加额外停顿，段落之间不会重新开启麦克风。也可固定使用中文或英文音色。不同音色仍可能有音质差异，无法保证切换完全无感。

Reading aliases cover common marker families (CD4+, CD8−, CD11b+, CD45RA+, CD44hi, CD62Llo, PD-L1, CTLA-4), floxed/slash genotypes, selected cytokine and Greek-letter notation, and common sequencing/PCR assay names. For example, CD4+ becomes “CD 4 positive”, fl/fl becomes “flox flox”, and IL-17A becomes “interleukin 17 A”. These are reading conventions, not a universal pronunciation dictionary. Unknown gene names remain unchanged; +/- is never interpreted as knockout or wild type. See [JAX genotype conventions](https://www.jax.org/news-and-insights/jax-blog/2011/may/designating-genotypes-what-does-plus-really-mean20150422t150455) and [HGNC symbol guidelines](https://www.genenames.org/about/guidelines/).

常见实验术语增加朗读别名：CD4+ 读作 CD 4 positive，fl/fl 读作 flox flox，并覆盖 CD 标记、部分免疫检查点、细胞因子、希腊字母和实验缩写。保留亚型、阳性/阴性及基因型区别；不会把未知基因符号随意展开，也不会把 +/− 自动解释为敲除。这些是常见读法规则，不是覆盖所有领域的发音词典。

Bracketed paper citations are silent during speech. Explicit inline PDF/page references use short locations such as “main text page 7” or “supplement page 2”, based on the current workspace. Unknown filenames use “document”. Filenames, URL strings, and DOI identifiers are not spelled aloud. Citation cleanup and reading aliases affect only speech: the saved answer and clickable references remain intact.

句末方括号引用不朗读；正文内明确提到的 PDF 页码，按工作区来源简化成“正文第7页”或“补充材料第2页”，未知来源称为“文献”。不逐字母读文件编号、网址和 DOI。所有清理及读法替换只作用于朗读副本，聊天中的原文和可点击引用完整保留。
