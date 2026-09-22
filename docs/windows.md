# Pairleaf Windows 版

提供 Windows x64 安装版和免安装版，与 Mac 版使用相同的本地论文工作区、PDF 阅读、分栏、AI 和 Obsidian 功能代码。运行平台目标是 Windows 10 / 11 x64；Electron 的平台支持见[官方说明](https://github.com/electron/electron#platform-support)。本轮没有生成原生 Windows ARM64 构建。

0.5.0 从 Folio 更名为 Pairleaf，沿用原有论文库和设置；加入实验性的 Windows 系统语音，取决于本机是否具备兼容引擎。见[更名说明](rename-pairleaf.md)和 [Windows 语音教程](windows-voice.md)。0.4.1 加入的单轮问答删除功能继续保留，个人笔记不受影响。

## 安装与使用

- [v0.5.0 安装版](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.5.0/Pairleaf-0.5.0-windows-x64-setup.exe)：安装向导，可选择安装位置，创建桌面与开始菜单入口。
- [v0.5.0 免安装版](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.5.0/Pairleaf-0.5.0-windows-x64-portable.exe)：程序临时解包运行；论文与设置仍保存在当前 Windows 用户的数据目录，不会自动随 EXE 搬走。
- 构建未使用 Windows 代码签名证书，因此安装时可能显示未知发布者。这与 Mac 的本机 ad-hoc 签名是两种不同的签名机制。

0.5.0 下载链接将在发布后可用。更新前先退出 Folio 或 Pairleaf；不要同时运行新旧应用编辑同一论文库。

点击「导入论文」选择一个或多个 PDF。导入整个论文文件夹用「文件 → 导入文章文件夹…」，或直接拖入文件夹。安装版会注册 PDF「打开方式」，支持从资源管理器发送 PDF 给已经运行的 Pairleaf；不会要求用户将 Pairleaf 设为系统默认阅读器。

Windows 使用原生标题栏和最小化、最大化、关闭按钮。应用内快捷键显示为 Ctrl；`Ctrl+F` 搜索当前阅读区，`Ctrl+O` 导入，`Ctrl+J` 切换助手。PDF 栏中的 `− / 比例 / ＋` 可以分别缩放；`Ctrl+滚轮` 只缩放所在阅读区。触控板捏合依赖驱动向 Chromium 提供标准缩放手势，普通双指滑动仍然滚动。

## 数据与密钥

默认论文库位于系统「文档」文件夹的 `Folio Library`。设置在 `%APPDATA%\Folio\settings.json`，启动日志在 `%APPDATA%\Folio\logs\main.log`。这些旧名称有意保留，更新时不用搬动数据；自行修改过的库路径继续使用。文件夹已重定向到 OneDrive 时，以系统返回的真实文档路径为准。

API Key 通过 Electron safeStorage 调用 Windows DPAPI 加密；请在 Windows 设置里重新输入自己的 Key。Mac 与 Windows 的系统加密不能通过复制 settings.json 互相解密。完整 ZIP 论文库备份可用于跨平台转移论文、笔记和对话，备份不含 API Key；Obsidian 仓库路径也需在新电脑重新选择。卸载保留用户论文和设置。

## 构建与验证

需要 Node.js 24、npm 与 .NET 10 SDK。SDK 用于构建 Windows 语音组件及运行协议测试；发布包只包含目标为 .NET Framework 4.8 的组件，不内置 SDK。用户电脑需要 .NET Framework 4.8 或兼容的 4.8.1 运行时。Mac 交叉构建还需要带 macOS 26 SDK 的 Xcode Command Line Tools；详细依赖见[语音组件说明](../native/windows-speech/README.md)。

```bash
npm ci
npm run dist:win
npm run test:win-package
npm run test:windows-speech
```

打包检查验证应用 EXE 的 x64 PE32+ 结构、产品/版本/图标资源、ASAR 内容、离线 PDF Worker 与字体资源、Windows 语音组件、安装版和免安装版文件，并在本地输出 `test-results/windows-package-report.json` 与安装包 SHA-256。生成的包与报告不包含在源码仓库中；预编译包见 [GitHub Releases](https://github.com/AuroraSxh/Folio-pdfreader/releases/latest)。

**0.5.0 验证结果尚待发布前填写，目前没有 Windows 实机或虚拟机运行环境。** Mac 上的交叉构建、静态检查、原生协议测试和模拟 Windows 平台的界面测试，都不能算作真实 Windows 运行验证。安装/卸载、启动、文件关联、DPAPI、打印、触控板、高 DPI，以及真实收音、朗读和设备释放仍需 Windows 环境验证。Mac 性能数字也不代表 Windows 的 CPU/GPU 占用，旧版测试数量不代表 0.5.0 通过。

在 Windows 开发环境中，可以对解包后的真实应用运行完整端到端检查（PowerShell）：

```powershell
$env:FOLIO_EXECUTABLE = "$PWD\release\v0.5.0\win-unpacked\Pairleaf.exe"
$env:FOLIO_E2E_OUTPUT = "test-results/windows-runtime"
npm run test:e2e
Remove-Item Env:FOLIO_EXECUTABLE, Env:FOLIO_E2E_OUTPUT
```

测试使用隔离的临时文章库和本地模拟 API，不调用付费 AI 服务。安装向导与系统「打开方式」仍需另外进行原生桌面检查。

系统语音的实机检查另见[原生组件说明](../native/windows-speech/README.md#real-windows-smoke-test)。普通能力检查不收音；只有显式指定实录或播放参数才会使用音频设备。

## 应用内更新

在「设置 → 应用更新」检查 GitHub 新版，也可开启启动时检查。下载完成并通过 SHA-256 校验后，安装版可启动更新安装程序；便携版会显示已下载文件，请先退出旧版，再运行新文件。更新检查不使用 AI API Key。
