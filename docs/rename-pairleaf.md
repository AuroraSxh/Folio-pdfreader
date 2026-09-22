# Folio → Pairleaf

[中文说明](#中文说明) · [English guide](#english-guide)

## 中文说明

从 0.5.0 起，Mac 与 Windows 版都叫 **Pairleaf**。这是原 Folio 的后续版本，论文库、批注、笔记、聊天记录和设置继续使用原来的位置，无需重新导入。GitHub 仓库仍是 [AuroraSxh/Folio-pdfreader](https://github.com/AuroraSxh/Folio-pdfreader)。

### Mac 首次更名安装

1. 退出 Folio，再打开 Pairleaf 的 DMG。
2. 将 **Pairleaf.app** 拖入「应用程序」。它和 **Folio.app** 名字不同，Finder 不会自动替换旧应用。
3. 从「应用程序」打开 Pairleaf，检查原来的论文和设置。
4. 确认无误后，可移除旧的 **Folio.app**。只移除应用本身，不要删除论文库、设置目录或钥匙串条目，也不要让清理工具一并删除这些数据。

请勿同时运行新旧应用来编辑同一论文库。以后从 Pairleaf 更新到 Pairleaf，退出旧版后拖入并选择「替换」即可。

已用隔离测试文库验证 Folio 0.4.1 → Pairleaf 0.5.0：PDF、笔记、批注、设置和双栏页码／缩放均保持一致。测试没有读取真实用户文库或钥匙串。

### Windows 更新

退出 Folio 后运行 Pairleaf 安装程序，按向导更新。免安装版改用新的 Pairleaf EXE。原有数据继续放在当前用户目录；不要把改名理解为创建了另一份论文库，也不要同时运行新旧 EXE。确认新版能打开原论文后，可删除旧的免安装 EXE。

### 为什么还有 Folio 字样

这些名称有意保留，用来接续原数据和加密密钥：

| 位置 | 保留的名称 |
| --- | --- |
| 默认论文库 | 系统「文稿 / 文档」中的 `Folio Library` |
| Mac 设置与日志 | `~/Library/Application Support/Folio` |
| Windows 设置与日志 | `%APPDATA%\Folio` |
| Mac 钥匙串 | 可能仍显示 `Folio Safe Storage` |
| 应用内部身份 | `Folio`、`com.folio.paperreader` |

曾自行更改论文库位置的用户仍使用已保存的路径。现有 Folio ZIP 备份可以继续导入，备份不含 API Key。系统加密的 Key 不适合通过复制设置文件搬到另一台电脑；换电脑后请自行填写。

如果出现钥匙串授权弹窗，那是 macOS 请求访问原来的加密信息。密码只应在系统弹窗中输入，不要发送给他人；无需为了更名删除或重置钥匙串。

## English guide

Starting with 0.5.0, both Mac and Windows editions are named **Pairleaf**. This continues the same Folio app: papers, annotations, notes, chats, and settings keep their existing locations. No reimport is needed. The repository remains [AuroraSxh/Folio-pdfreader](https://github.com/AuroraSxh/Folio-pdfreader).

### First installation under the new name on Mac

1. Quit Folio and open the Pairleaf DMG.
2. Drag **Pairleaf.app** into Applications. Its different name means Finder will not automatically replace **Folio.app**.
3. Open Pairleaf from Applications and check your existing papers and settings.
4. Once confirmed, you can remove the old **Folio.app**. Remove only the app, keeping the library, settings, and Keychain items. Do not let an app-cleaning utility remove those data folders.

Avoid running both apps against the same library. Later Pairleaf-to-Pairleaf updates use the normal process: quit, drag into Applications, and replace.

An isolated Folio 0.4.1 → Pairleaf 0.5.0 upgrade check preserved PDF bytes, notes, annotations, settings, and both panes’ page/zoom. It did not access a real user library or Keychain.

### Updating Windows

Quit Folio, then run the Pairleaf installer and follow the wizard. For the portable edition, use the new Pairleaf EXE. Existing data stays in your user folders; the rename does not create another library. Avoid running both versions at once. After confirming your papers in the new portable app, you can delete the old portable EXE.

### Names intentionally retained

The default library remains **Folio Library** in Documents. Settings and logs stay in `~/Library/Application Support/Folio` on Mac or `%APPDATA%\Folio` on Windows. A custom library path is preserved. Internal identifiers `Folio` and `com.folio.paperreader`, the backup format, and Mac's **Folio Safe Storage** Keychain name are retained so existing data and encrypted credentials remain accessible.

Existing Folio ZIP backups still import and exclude API keys. Encrypted settings are not a way to transfer a key between computers; enter your own key on the new computer.

A Keychain prompt may still use the old name. Enter a password only in the macOS system dialog. Renaming the app does not require deleting or resetting the Keychain.
