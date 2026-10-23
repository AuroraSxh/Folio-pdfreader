# Qoder 本机代理 / Local Qoder bridge

## 中文

Pairleaf 可以连接你已配置的 Qoder 本机代理，使用其模型阅读论文、解释截图和联网查询。请求仍会发往 Qoder 上游，使用你的账号与额度；不是离线模型。

1. 保持本机代理运行，在 **设置 → AI 阅读助手 → Qoder** 中填写地址，默认 `http://127.0.0.1:8788/v1`。
2. 选择型号，填入代理为这个型号分配的专用 Key，点击「设为默认」后保存。每个型号的 Key 分别加密保存在本机，切回已保存的型号可以复用；切换到新型号时需要它自己的 Key。更换代理地址后需要重新配置密钥。
3. 回到阅读伙伴提问。图片可从输入框的「截图」或 PDF 工具栏加入；查网页时开启「联网」。搜索和回答由当前选择的模型完成，来源可在引用中展开。

思考选项随型号变化，默认使用最高可用档；没有公开思考控制的型号沿用 Qoder 默认行为。MiniMax 当前只接收文字，图片入口不会让它获得视觉能力。Auto 表示明确交给 Qoder 选择模型。

Key 是本机代理的访问密钥，不是 Qoder 官网发放的通用 API Key，也不会包含在 Pairleaf 安装包或备份里。代理连接失败时先检查服务是否运行；若 Qoder 登录过期，需要在 Qoder 中重新登录。

## English

Pairleaf connects to an already configured local Qoder bridge for paper questions, image reading and web search. Requests still use Qoder's upstream service and your account quota; these are not offline models.

1. Keep the bridge running. Open **Settings → AI → Qoder** and enter its address, normally `http://127.0.0.1:8788/v1`.
2. Choose a model, enter the dedicated key issued for it by your bridge, click **Set as default**, and save. Keys are encrypted locally and kept separately for each model. Switching back reuses that model's saved key; a new model needs its own key. Changing the bridge origin requires new credentials.
3. Ask a question in the reading companion. Use **Capture image** below the input or the PDF toolbar to attach an image. Enable **Web** to search with the selected model and expand citations to see the sources.

Thinking controls follow each model's supported levels, with the highest available level selected by default. Models without exposed controls use Qoder's defaults. MiniMax currently accepts text only. Auto explicitly lets Qoder choose the model.

The key authenticates to your local bridge; it is not a general API key issued by Qoder's website. Pairleaf packages and backups exclude keys. If connection fails, check that the bridge is running. Expired Qoder login credentials need a fresh sign-in in Qoder.

## 模型目录 / Model catalog

本机代理目录核对日期 / Local bridge catalog checked: 2026-10-23.

| Model | Proxy model ID | Thinking levels |
| --- | --- | --- |
| DeepSeek V4 Pro | `dmodel` | high / max; off |
| DeepSeek Flash | `dfmodel` | low / high / max; off |
| GLM 5.3 | `gmodel` | low / high / max |
| GLM 5.3 Flash | `gfmodel` | high / max |
| GLM 5.2 | `gm51model` | high / max; off |
| Kimi K3 | `kmodel_latest` | low / high / max |
| Kimi K2.8 Preview | `kmodel` | low / high / max |
| MiniMax M2.7 | `mmodel` | Qoder default |
| Qwen 3.8 Max | `qmodel_38max` | low / medium / xhigh; off |
| Qwen 3.8 Flash | `qfmodel` | low / medium / xhigh; off |
| Qwen 3.7 Max | `qmodel_latest` | on / off |
| Qwen 3.7 Plus | `qmodel` | on / off |
| Qwen 3.7 Flash | `q37fmodel` | Qoder default |
| Auto | `auto` | Qoder default |
