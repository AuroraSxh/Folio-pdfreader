# Windows 语音教程 / Windows voice guide

[中文教程](#中文教程) · [English guide](#english-guide)

适用于 Pairleaf 0.5.0 的 Windows x64 版。**此功能为实验性，尚未经过 Windows 实机验证。** Mac 用户请看 [Apple 语音教程](apple-voice.md)。

For Pairleaf 0.5.0 on Windows x64. **Experimental; not yet tested on a real Windows device.** Mac users should use the [Apple voice guide](apple-voice.md#english-guide).

## 中文教程

### 开始之前

Pairleaf 使用 .NET Framework 4.8 的 System.Speech / SAPI，在本机识别与朗读，不需要额外语音 Key，也不会把录音转发到云端。AI 回答仍需要你自己的 API Key；识别后的文字和论文上下文会按 AI 设置发送给所选服务。

语音需要本机提供兼容的识别引擎和音色。**并非所有 Windows 10 / 11，尤其是部分新版 Windows 11，都有可用的 SAPI 自由听写引擎。** 安装语言包不能保证解决。Windows「讲述人」能用的自然音色，也不一定能提供给 Pairleaf。以应用检测结果和音色列表为准。

安装版需要 .NET Framework 4.8 或兼容的 4.8.1 运行时，较新的 Windows 通常已包含；普通用户不需要安装开发用的 .NET 10 SDK。[Microsoft 运行时说明](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server)

### 使用步骤

1. 打开文章，点击工具栏的「语音」。**默认关闭，点击此按钮只打开选项，不收音；重启也不恢复语音。**
2. 选择识别语言，并分别选择中文、英文音色和语速。识别语言也决定 AI 回答的语言；一次识别会话使用一种语言，不保证自动识别中英混合提问。
3. 点击「试听音色」。试听不需要 AI Key、不使用麦克风、不写聊天记录，结束后保持暂停。即使识别引擎不可用，只要有可用音色仍可试听。自动模式下，若本机只有中文或英文音色，就使用对应的单语示例；固定语言模式使用对应示例，不会修改已保存的音色偏好。
4. 本地识别可用、AI Key 已设置后，点击「开始聆听」。说完稍作停顿即可发送问题。回答朗读时麦克风暂停；可打断继续讲话，也可暂停或结束。

收起 AI 面板后仍可对话，转写和回答保存在相同的聊天记录中。切换论文、锁屏或退出会结束语音，音色偏好单独保存。误录内容可在提问或回答下删除整轮问答，同时清除关联的自动记忆和摘要；个人笔记保留。

### 系统设置

- **麦克风权限：** Windows 11 在「设置 → 隐私和安全性 → 麦克风」中检查麦克风访问权限，以及允许桌面应用访问；Windows 10 的入口在「设置 → 隐私 → 麦克风」。[Microsoft 说明](https://support.microsoft.com/en-us/windows/privacy/turn-on-app-permissions-for-your-microphone-in-windows)
- **语言和语音组件：** Windows 11 在「设置 → 时间和语言 → 语言和区域」打开对应语言的选项，查看可下载的语音组件；Windows 10 在「时间和语言 → 语言 → 选项」。不同语言提供的组件不同，下载后仍需由 Pairleaf 重新检测。[Microsoft 说明](https://support.microsoft.com/en-us/windows/hardware/input-devices/manage-the-language-and-keyboard-input-layout-settings-in-windows)

等下载完成后，暂停并点击「刷新音色」，或关闭再打开语音选项。中文和英文可以分别选择；普通音色不等同于 Mac 的增强或高级音色。Pairleaf 只列出当前可用的 SAPI 音色，不保证包含所有系统声音。

### 不可用时

若提示本地识别不可用，可继续文字输入，或仅试听已安装音色；Pairleaf 不会自动切换到云端识别。如果提示麦克风访问失败，检查系统权限、输入设备和其他应用是否占用麦克风。缺少音色时，先查看系统语言选项，安装后再刷新。

当前没有 Windows 实机测试结果，安装、真实收音、朗读、停止后释放设备，以及 CPU/GPU 占用都仍需 Windows 环境验证。模拟平台界面测试或 Mac 上的交叉编译不能代替这些检查。

## English guide

### Before starting

Pairleaf uses .NET Framework 4.8 System.Speech / SAPI for local recognition and reading. It needs no extra speech key and does not upload recordings. AI replies still require your own provider key; recognized text and paper context are sent according to your AI settings.

**A compatible local dictation engine is not available on every Windows 10/11 installation, particularly some newer Windows 11 systems.** Installing language components does not guarantee one. Narrator's natural voices are not necessarily exposed to Pairleaf. Use the app's capability result and actual voice list.

The installed app uses .NET Framework 4.8 or compatible 4.8.1, included with recent Windows releases. Users do not need the development-only .NET 10 SDK. [Microsoft runtime information](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server)

### Start a conversation

1. Open a paper and select **Voice**. **Voice is off by default; opening options does not use the microphone, and restarting never resumes a session.**
2. Select the recognition language, Chinese and English voices, and speed. Recognition language also controls AI reply language. Each recognition session uses one language; automatic bilingual recognition is not promised.
3. Select **Preview voices**. Preview needs no AI key, microphone, or chat entry, and finishes paused. Installed voices can be previewed even when recognition is unavailable. In automatic mode, Chinese-only or English-only systems use a matching sample; fixed-language modes use the corresponding sample. Saved voice preferences remain unchanged.
4. With a working local recognizer and your AI key configured, select **Start listening**. Pause briefly to send a question. The microphone pauses during spoken replies; interrupt to speak again, pause, or end.

Hiding the AI panel keeps the session available. Reopening it shows the same transcript and answer. Switching papers, locking the screen, or quitting ends the session; voice preferences are saved separately. Delete below a question or answer removes the exchange and linked automatic memories and summaries; personal notes are kept.

### Windows settings

- **Microphone:** on Windows 11, check **Settings → Privacy & security → Microphone**, including access for desktop apps. On Windows 10, use **Settings → Privacy → Microphone**. [Microsoft instructions](https://support.microsoft.com/en-us/windows/privacy/turn-on-app-permissions-for-your-microphone-in-windows)
- **Language components:** on Windows 11, open a language's options under **Settings → Time & language → Language & region**. On Windows 10, use **Time & language → Language → Options**. Available speech downloads vary by language. Pairleaf must still check whether a compatible engine is present. [Microsoft instructions](https://support.microsoft.com/en-us/windows/hardware/input-devices/manage-the-language-and-keyboard-input-layout-settings-in-windows)

Wait for downloads to finish, then pause and select **Refresh voices**, or close and reopen voice options. Choose Chinese and English voices independently. The list contains available SAPI voices; it does not promise every system or Narrator voice, nor Apple's Enhanced/Premium voice categories.

### When speech is unavailable

Continue with text input if local recognition is unavailable. Voice previews may still work. Pairleaf never falls back to cloud recognition. For microphone errors, check permissions, the selected input device, and whether another app is using it. For missing voices, check language options and refresh after installation.

No real Windows device testing has been completed. Installation, microphone capture, playback, device release after stopping, and CPU/GPU usage still need Windows testing. A simulated-platform UI check or cross-build on a Mac does not validate these behaviors.

## Development

The native helper targets .NET Framework 4.8; the .NET 10 SDK is used for development and protocol tests, not bundled in the app. See the [helper README](../native/windows-speech/README.md) for build and explicit device-test commands.

Pairleaf 0.5.0 passed 168 JavaScript/TypeScript unit tests, 15 C# protocol tests with simulated audio, 6 simulated Windows renderer checks, and 7 static package checks. These do not run the native Windows speech engine or validate microphone capture or playback.

0.5.0 已通过 168 项 JavaScript/TypeScript 单元测试、15 项模拟音频的 C# 协议测试、6 项模拟 Windows 渲染界面检查及 7 项安装包静态检查。这些结果不代表运行过真实 Windows 语音引擎，也不代表麦克风或扬声器验证通过。
