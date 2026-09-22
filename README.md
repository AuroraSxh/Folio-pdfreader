# Folio

面向 macOS 和 Windows 的本地学术 PDF 阅读器。一篇文章一个工作区，将正文、附图和补充 PDF 放在一起，双栏对照阅读，集中保存批注、AI 对话与笔记。**内嵌 AI 需要自行配置 API Key，离线阅读无需密钥。**

A local-first academic PDF reader for macOS and Windows. Keep each paper, figure PDF, and supplement in one workspace, read them side by side, and organize annotations, AI conversations, and Obsidian notes. **Bring your own API key for AI assistance; offline PDF reading needs no key.**

[下载最新版本 / Latest release](https://github.com/AuroraSxh/Folio-pdfreader/releases/latest) · [v0.2.2 下载与版本说明](https://github.com/AuroraSxh/Folio-pdfreader/releases/tag/v0.2.2)

## 开始使用

| 平台 | v0.2.2 下载 |
| --- | --- |
| macOS 13+，Apple Silicon / Intel | [通用 DMG](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.2.2/Folio-0.2.2-mac-universal.dmg) |
| Windows 10 / 11，x64 | [安装版](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.2.2/Folio-0.2.2-windows-x64-setup.exe) · [免安装版](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.2.2/Folio-0.2.2-windows-x64-portable.exe) |

Mac：打开 DMG，将 Folio 拖到「应用程序」。当前使用 ad-hoc 签名，未做 Apple Developer ID 签名及公证；首次打开可能需按「系统设置 → 隐私与安全性」中的提示允许打开。

Windows：下载安装版或免安装版。**目前完成了交叉构建与静态包检查，尚未完成 Windows 实机运行验证。** 详见 [Windows 使用与验证说明](docs/windows.md)。

1. 点击「导入论文」，选择正文 PDF；可以同时选择多个 PDF。导入整个文章文件夹可用「文件 → 导入文章文件夹…」。也支持拖放、Finder / 文件资源管理器的「打开方式」。
2. 在文章工作区点击「添加补充材料」。所有导入文件都会复制到文章文件夹，原始下载文件不受影响。
3. 在上方「阅读布局」或 PDF 右键菜单中选择单栏、纵向分割（左右）或横向分割（上下）。两个区域可以显示不同 PDF，也可同时显示同一个 PDF 的不同位置；独立翻页、缩放，拖动分隔线调整比例。每栏都有「− / 比例 / ＋」，触控板双指捏合只缩放手势所在区域，普通双指滑动仍然滚动。
4. 打开「设置与连接 → AI 阅读助手」，输入自己的 API Key 并保存。默认为 DeepSeek Flash；支持 Pro、思考开关和 Low / High / Max 深度。
5. 在右侧「笔记」写笔记，或生成结构化总结。选择 Obsidian 仓库后可以导出，也可单独导出 Markdown。

有文字层的 PDF 可以直接选中文字，用 ⌘C / Ctrl+C、选文工具栏或右键菜单复制。**两个阅读区共用一条批注工具栏**，默认常驻在整个阅读区域底部，操作作用于当前点击的阅读区。荧光笔和颜色共用，可以先选颜色、开启荧光笔，再拖选文字自动高亮。工具栏上的「切换位置」按钮可直接在底部悬浮与顶部固定之间切换，并记住选择；「设置与连接 → 阅读偏好」中也可选择仅选中文字时显示。复制、批注及选文提问需要先有文字选区。

阅读时左侧默认显示 48 px 精简导航，点击文件夹或「展开文章导航」展开正文与补充材料列表。AI 默认关闭，点击「阅读伙伴」或按 ⌘J / Ctrl+J 可打开磨砂玻璃浮层，PDF 不会因此缩小。点击助手标题栏的固定按钮可固定到右侧，拖动左边缘调整宽度；窗口太窄时会暂时改为浮出显示。悬浮时可拖动标题栏自由移动，位置会限制在阅读区域内。标题栏聚焦后也可用方向键微调、Home 复位。打开状态、悬浮位置、固定方式、宽度和导航偏好会在本机记住。

「专注阅读」或 ⌘⇧F / Ctrl+Shift+F 临时收起导航与助手，再次点击恢复原布局。隐藏助手会保留当前对话、草稿及流式回复。

支持荧光高亮、下划线、删除线：可以在共用工具栏预选后拖选文字，也可以先选文字，再从工具栏或右键菜单直接标记。选中文字后右键「添加批注」即可填写评论，取消不会新增标记。在已有标记文字或旁边的批注小圆点上右键，可编辑或删除批注；批注侧栏也有「删除批注」按钮。删除会一并移除该条标记和评论，支持撤销恢复。批注侧栏可修改类型、颜色和评论；导出的 PDF 保留真实的三种批注类型。

⌘Z / Ctrl+Z 撤销最近一次批注或目录编辑，⌘⇧Z / Ctrl+Shift+Z 重做（Windows 也支持 Ctrl+Y）。Mac 同时支持 Ctrl+Z。两份 PDF 按工作区中的操作顺序撤销，输入框内仍撤销文字输入。历史只在本次应用会话保留，每篇文章最多 50 步，并受总内存上限约束；重启后保留已保存的编辑结果，不保留撤销栈。文章移除、附件移除或永久删除不使用此撤销栈，文章恢复仍通过「已移除文章」。

没有论文时，「体验示例工作区」会生成真正的正文与补充 PDF，可验证阅读操作。示例明确标注为演示文档，数据不代表真实研究。

## 功能

| 模块 | 已实现 |
| --- | --- |
| 文献库 | 标题/作者/标签搜索、排序、收藏、网格/列表、最近阅读、元信息编辑、已移除文章与恢复 |
| 文章工作区 | 多 PDF、本地文件夹、附件重命名/正文切换、左右/上下分割、独立阅读位置与缩放 |
| PDF 阅读 | 可选择/复制文字、右键分栏、内部链接、全文搜索、缩略图、页面跳转、适宽/适页/自定缩放、旋转 |
| 阅读模式 | 连续垂直、连续水平、多行排列、单页翻阅、双页与独立封面排列 |
| 目录 | 读取原始层级，新增、重命名、修改页码、排序、缩进/提升、删除；导出为真实 PDF 书签 |
| 批注 | 可常驻的悬浮/固定工具栏、高亮/下划线/删除线、撤销重做、多页选区、批注内容与颜色、删除、跳转定位；随 PDF 副本导出 |
| AI | 流式问答/总结、停止/重试、选文解释、文档范围、多会话、页码引用跳转、自动索引隐藏附件 |
| 记忆 | finding / interpretation / question / user-note / cross-ref；中文去重、周期索引、跨论文标签召回、逐条删除 |
| 笔记 | Markdown 自动保存/预览、AI 回复转笔记、原生关闭前保存握手 |
| Obsidian | 按 article_id 幂等导出，包含摘要、对话、记忆、个人笔记、批注与 PDF 链接；保留 firstRead、额外属性和托管区外手写内容 |
| 数据 | 完整 ZIP 备份/合并恢复、兼容旧版文章 JSON 备份迁移、API Key 加密保存 |

打印按钮会打开包含当前目录与批注的原生 PDF 预览，使用该窗口的打印按钮选择打印机与页码。

## DeepSeek 与其他服务商

已按 2026-09-21 核对的 [DeepSeek Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)与[思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/)实现：

- 默认地址 `https://api.deepseek.com`，请求 `POST /chat/completions`。
- 当前模型标识 `deepseek-flash`、`deepseek-v4-pro`。
- `thinking.type` 为 `enabled` / `disabled`；开启时发送 `reasoning_effort`，可选 `low` / `high` / `max`。
- 流式显示最终答案；不存储或回传 `reasoning_content`。
- API Key 在应用设置中手动输入，通过 Electron safeStorage 加密，使用 macOS 钥匙串或 Windows DPAPI。界面只收到「已配置」状态；备份不包含密钥。
- 同时支持 OpenAI、Anthropic 和自定义 OpenAI 兼容地址/模型。本地服务允许 HTTP，其余使用 HTTPS。

Mac 保存或读取 API Key 时，系统可能询问是否允许使用「Folio Safe Storage」。该钥匙串项目保存 Folio 的加密密钥；加密后的 API Key 才写入本地设置。请只在 macOS 系统弹窗输入登录钥匙串密码，无需向开发者提供密码。当前版本采用 ad-hoc 签名，更新构建后可能再次询问；拒绝访问会使相应的密钥保存或解密失败。参见 [Electron safeStorage 说明](https://www.electronjs.org/docs/latest/api/safe-storage)。

AI 通过远程 API 运行，不在电脑上加载大模型。只有发起请求，或主动启用自动摘要/自动记忆后，才会产生相关调用；自动记忆会增加提取与索引请求。AI 上下文包含所选 PDF 提取文字、当前文章笔记/记忆及匹配的跨文章关联；达到字符预算时会明确提示截断。

## 本地数据与备份

默认文章库：`~/Documents/Folio Library/`。每篇文章对应一个 UUID 文件夹，内含 `workspace.json`、PDF 和 `.text/` 文本索引。

Mac 设置：`~/Library/Application Support/Folio/settings.json`；Windows 设置：`%APPDATA%\Folio\settings.json`。启动诊断均在设置目录下的 `logs/main.log`。Windows 文章库使用系统「文档」文件夹中的 `Folio Library`，包括系统已重定向到 OneDrive 的情形。

移除单个 PDF 会将副本移到当前文章文件夹的 `.removed/` 中。移除整篇文章会保存到文献库 `.trash/`，通过侧栏「已移除文章」查看、搜索和恢复；**默认没有自动清理期限，会一直保留，只有再次确认「彻底删除」才永久删除该工作区。** 恢复保留 PDF、批注、阅读位置、笔记与对话。以前版本已放入系统废纸篓/回收站的文章仍需从系统中找回，不会自动出现在应用的已移除列表。

完整 ZIP 备份同时包含正常文章、已移除文章及保留的附件。恢复采用合并方式，已有 ID 不覆盖，并保留文章原先的正常/已移除状态。旧插件备份只包含文章/笔记/对话，需要重新添加对应 PDF；旧全局记忆会单独保留并标明来源未归属。

## 键盘操作

下表为 Mac 快捷键；Windows 将 ⌘ 换成 Ctrl，⇧ 表示 Shift，应用内会显示对应平台的按键。

| 快捷键 | 操作 |
| --- | --- |
| ⌘ O | 导入新论文 |
| ⌘ ⇧ O | 添加补充 PDF |
| ⌘ F | 在当前阅读区搜索 |
| ⌘ L | 返回文献库 |
| ⌘ J | 显示/隐藏助手 |
| ⌘ ⇧ F | 进入/退出专注阅读 |
| ⌘ Z / ⌘ ⇧ Z | 撤销/重做批注与目录编辑；输入框内撤销/重做文字 |
| ⌘ \ | 切换分割阅读 |
| ⌘ , | 设置 |
| ⌘ ⇧ E | 导出 Markdown |

## 开发与验证

开发环境使用 Node.js 24 和 npm；技术栈为 Electron、React、TypeScript、PDF.js、pdf-lib。

```bash
npm ci
npm run dev
```

`npm run dev` 启动本地 Vite 与 Electron。生产构建打包了 PDF 阅读资源，无需联网即可阅读。

构建及测试：

```bash
npm run build
npm test
npm run test:e2e
npm run test:reading
```

打包（产物位于 `release/v0.2.2/`）：

```bash
npm run dist:dmg
npm run dist:win
npm run test:win-package
```

macOS 通用 DMG 需在 Mac 上构建。`test:e2e` 使用隔离的临时文献库和本地 SSE 模拟服务；`test:reading` 验证真实鼠标与键盘阅读操作。两者都不会调用收费 API，但会启动应用并操作测试窗口，运行时请保持桌面空闲。可设置 `FOLIO_USER_DATA` 为手动测试指定独立数据目录。

对打包后的 Mac 应用运行阅读回归：

```bash
FOLIO_EXECUTABLE="$PWD/release/v0.2.2/mac-universal/Folio.app/Contents/MacOS/Folio" \
FOLIO_E2E_OUTPUT=test-results/release-final npm run test:reading
```

v0.2.2 的 Mac 通用包已在 Apple Silicon 上通过 20 项阅读回归；Intel Mac 未单独运行验证，Windows 仅完成静态包检查。真实 AI 服务的账户权限、配额及网络仍需用自己的密钥验证，本地模拟 API 测试不代表真实 DeepSeek 调用成功。

测试报告、临时 PDF 和截图会在本地 `test-results/` 生成，不随源码仓库发布。性能数据见 [v0.2.1 浮层拖动报告](docs/performance-v0.2.1.md)、[v0.2.0 阅读布局报告](docs/performance-v0.2.0.md) 和[早期渲染优化报告](docs/performance.md)；这些历史测量不是 v0.2.2 的性能复测。测量条件与运行入口见 [性能测试说明](scripts/PERFORMANCE.md)。CPU 使用单个逻辑核为 100% 的口径；整机 GPU 数据不能归因于 Folio。

## 边界

这一版覆盖学术阅读与工作区功能，尚不包含 Acrobat Pro 的 PDF 原文排版修改、OCR、数字签名或表单创建。扫描 PDF 可阅读，但没有文字层时不能做全文搜索或直接作为 AI 全文上下文；图表分析基于正文和图注，不把文字提取说成看到了图像。加密 PDF 支持输入密码阅读，修改后的加密 PDF 暂不支持导出。

## 技术与界面参考

UI 在实际浏览 21st.dev 后参考了 [File Card Collections](https://21st.dev/@urmauur/components/file-card-collections)、[Empty / No Results](https://21st.dev/@cnippet-dev/components/cnippet-empty/no-results)、[Prompt Suggestion](https://21st.dev/@ibelick/components/prompt-suggestion) 的布局与交互，自行实现暖白、绿色和浅紫配色，不依赖远程组件服务。

分割阅读参考 [Zotero 的横向/纵向分割](https://www.zotero.org/support/6.0_changelog)。PDF 阅读基于 [Mozilla PDF.js](https://mozilla.github.io/pdf.js/)，桌面进程使用 [Electron 上下文隔离与 IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)。

## 许可 / License

源码公开供查看，项目保留所有权利，未授予开源许可。具体条款见 [LICENSE](LICENSE)；第三方依赖遵循各自的许可证，见 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。

更新依赖后，在已执行 `npm ci` 的环境运行 `node scripts/third-party-notices.mjs`，同步第三方许可文本后再分发构建。

The source is public for inspection; no open-source license is granted. All rights reserved. See [LICENSE](LICENSE). Third-party dependencies remain subject to their respective licenses.
