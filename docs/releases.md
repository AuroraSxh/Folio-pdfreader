# 发布到 GitHub 和 Gitee

两个正式仓库固定为：

- [GitHub](https://github.com/AuroraSxh/Folio-pdfreader)
- [Gitee](https://gitee.com/aurorasxh/pair-leaf)

使用 Node.js 24。先完成测试、Mac/Windows 打包、密钥检查，并将源码提交。两个仓库必须有指向同一提交的版本标签；工具不会创建标签、强制推送或删除历史版本。

```sh
git tag -a v0.8.0 -m 'Pairleaf v0.8.0'
git push origin main refs/tags/v0.8.0
git push gitee main refs/tags/v0.8.0
git rev-parse HEAD
```

其中 `origin` 和 `gitee` 应分别指向上述仓库。先用 `git remote -v` 核对。如果 Gitee 远端尚未配置：

```sh
git remote add gitee https://gitee.com/aurorasxh/pair-leaf.git
```

将下面文件放在 `release/v0.8.0/`，替换为本次实际版本：

```text
Pairleaf-0.8.0-mac-universal.dmg
Pairleaf-0.8.0-windows-x64-setup.exe
Pairleaf-0.8.0-windows-x64-portable.exe
Pairleaf-0.8.0-mac-license-notices.zip
Pairleaf-0.8.0-windows-license-notices.zip
INSTALL-MAC.txt
INSTALL-WINDOWS.txt
RELEASE.md
```

`RELEASE.md` 是两个平台共用的中英文更新说明。工具会计算全部 SHA-256，并生成旧版 Folio 所需的三个兼容文件名和 `SHA256SUMS.txt`。已有同名文件、校验表或远端附件与本次内容不一致时直接停止，不覆盖。

## 先预览，再执行

默认是 dry-run：仅读取本地文件和计算校验值，不联网、不读取凭据、不写文件。把 `<完整提交 SHA>` 替换为上面输出的 40 位 SHA。

```sh
node scripts/publish-release.mjs --version 0.8.0 --commit <完整提交 SHA>
```

确认文件、版本和提交后：

1. 使用已有的 `gh auth login` 登录 GitHub。
2. 在本机环境变量或 CI 密钥中配置 `GITEE_TOKEN`，权限应允许访问目标仓库并管理发行版。不要放进源码、安装包、命令参数或聊天消息。
3. 执行同一条命令，加上 `--execute`：

```sh
node scripts/publish-release.mjs --version 0.8.0 --commit <完整提交 SHA> --execute
```

执行时先核对本地提交、该提交中 `package.json` 的版本、两端标签、凭据、已有附件及可取得的 Gitee 历史附件占用。源码版本必须与发布标签一致。然后创建 GitHub draft 和 **Gitee 公开预发行版**，上传并校验全部内容，最后发布为稳定版。Gitee 没有与 GitHub 相同的私有草稿功能，因此上传期间预发行版可能已经可见，自动更新器会忽略它。

只有两个平台都验证并发布成功，命令才输出 `success: true`。任何一步失败均以非零状态退出，显示各平台状态。跨平台发布不能保证原子完成；如果最后一步只有一端完成，可以原样重试，工具会验证并复用已经上传的内容，不重复覆盖。

## Gitee 的大文件与容量

Gitee 普通仓库单附件上限 100 MB、附件合计 1 GB，仓库普通附件也占用总额；推荐仓库及 GVP 配额不同。[官方 Release 说明](https://help.gitee.com/repository/release/create)、[容量配额](https://help.gitee.com/account/usage-quota)

工具默认把 Gitee 上的大安装包分成 **48 MiB** 文件。GitHub 保留完整安装包及 Folio 兼容别名；Gitee 只保留 Pairleaf 安装包分片和必要的小附件，不重复上传 Folio 别名。支持 Gitee 的新版客户端按发行说明中的校验清单下载、合并，并检查每片和完整安装包的 SHA-256；分片不是可直接双击的安装包。两边使用同一批原始安装包字节、标签、提交和发行说明。

以 v0.6.0 的三个安装包为例，一版 Gitee 附件约 **466 MB**；保留多版会接近普通仓库的总配额。工具检查能取得的历史 Release 附件大小，并报告未知大小；仓库普通附件可能仍占用额外空间，服务器也可能因配额拒绝上传。此时命令失败，不自动删除旧版本，也不会静默变成只发布 GitHub。

只有确认账号配额允许时，才可调整 `--gitee-asset-limit` 和 `--gitee-total-limit`；这些参数不会改变 Gitee 的实际限制。`--gitee-part-size 0` 关闭分片，但完整安装包仍必须符合声明的单文件配额。默认配置适用于普通仓库的大安装包发布。

## English

Run `publish-release.mjs` with Node.js 24 after building, testing, scanning for secrets, committing the source, and pushing the same version tag to **both** official repositories. The default run is local and read-only. Add `--execute` to publish, using the existing GitHub CLI login and a `GITEE_TOKEN` environment secret.

Both hosts receive the same version, commit, release notes and integrity manifest. GitHub receives complete installers plus legacy Folio aliases. Gitee receives 48 MiB parts for large Pairleaf installers; the updater reassembles and verifies them. Gitee staging releases are public prereleases. The command reports success only after both hosts are verified and stable. Retry interrupted runs unchanged; conflicting content is never overwritten, and old releases are never deleted.

Gitee’s standard 100 MB per-file and 1 GB total attachment quotas still apply. Historical release sizes are checked where available; ordinary repository attachments can consume additional space. Exceeding capacity is an error, not permission to delete release history.
