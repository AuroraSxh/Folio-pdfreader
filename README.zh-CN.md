# Folio

[English](README.md) · [简体中文](README.zh-CN.md)

Folio 是一个学术 PDF 阅读器，支持 macOS 和 Windows。把一篇论文的正文、附图和补充材料放在同一个工作区，分栏对照阅读，也可以随时向内嵌的 AI 阅读伙伴提问。

**AI 功能需要自行提供 API Key，软件不内置密钥。离线阅读无需密钥。**

## 能做什么

- 同时打开正文和补充 PDF，支持左右或上下分栏，分别滚动、缩放。
- 选文复制、高亮、下划线、删除线和批注，支持撤销与 PDF 导出。
- 用 DeepSeek 等 AI 服务解释选文、讨论文章、整理阅读笔记。
- Mac 支持 Apple 语音识别与朗读，语音和文字共用聊天记录，无需额外语音 Key。
- 将笔记导出到 Obsidian 或 Markdown。论文、批注和笔记保存在本地。
- 支持中英文界面切换，可在应用内检查 GitHub 新版并下载安装包。

## 下载

[最新版本与更新说明](https://github.com/AuroraSxh/Folio-pdfreader/releases/latest)

| 平台 | 版本 | 下载 |
| --- | --- | --- |
| macOS 13+，Apple Silicon / Intel | 0.4.0 | [DMG 安装包](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.4.0/Folio-0.4.0-mac-universal.dmg) |
| Windows 10 / 11，x64 | 0.3.0 | [安装版](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.3.0/Folio-0.3.0-windows-x64-setup.exe) · [免安装版](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.3.0/Folio-0.3.0-windows-x64-portable.exe) |

Mac 打开 DMG 后，将 Folio 拖入「应用程序」；更新时退出旧版并选择替换即可。论文和笔记会保留。

目前未做 Apple Developer ID 签名及公证，Windows 包也未签名。Mac 已在 Apple Silicon 上测试，Intel Mac 未实机验证；Windows 已完成打包与静态检查，尚未实机测试。[Windows 使用说明](docs/windows.md)

## 更新记录

<!-- 每次发布同步更新两份 README，最新版本在前，保留已有记录。 -->

| 版本 | 主要变化 |
| --- | --- |
| [0.4.0](https://github.com/AuroraSxh/Folio-pdfreader/releases/tag/v0.4.0) | Mac 接入 Apple 语音识别和系统朗读；语音与文字共用聊天记录，收起 AI 面板后仍可使用语音控制条。 |
| [0.3.0](https://github.com/AuroraSxh/Folio-pdfreader/releases/tag/v0.3.0) | 界面、菜单和笔记导出支持中英文；增加 GitHub 新版检测和安装包下载校验。 |
| [0.2.2](https://github.com/AuroraSxh/Folio-pdfreader/releases/tag/v0.2.2) | 选文右键添加批注，已有批注可编辑、删除和撤销；首次发布到 GitHub。 |
| 0.2.1 | AI 悬浮框可自由拖动，并记住位置。 |
| 0.2.0 | 精简导航、AI 悬浮框、专注阅读、下划线、删除线及撤销/重做。 |
| 0.1.0 | 初版：论文工作区、PDF 分栏与独立缩放、AI 辅助阅读和 Obsidian 导出。 |

## 本地开发

使用 Node.js 24 和 npm。Mac 构建还需要带 macOS 26 SDK 的 Xcode Command Line Tools，用于编译原生语音组件。见 [Mac 语音说明](docs/apple-voice.md)。

```bash
npm ci
npm run dev
```

```bash
npm run build       # 生产构建
npm test            # 单元测试
npm run test:locale # 双语与更新界面检查
npm run test:voice  # 语音界面检查，模拟收音与 AI
npm run dist:dmg    # Mac 通用安装包，需在 Mac 上构建
npm run dist:win    # Windows x64 安装版与免安装版
```

基于 Electron、React、TypeScript 和 PDF.js。更多说明：[实现概览](docs/implementation.md) · [性能测试](scripts/PERFORMANCE.md)。

## 许可

保留所有权利，暂不授予开源许可。详见 [LICENSE](LICENSE)。第三方组件遵循各自许可证，见 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。
