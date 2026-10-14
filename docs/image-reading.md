# PDF 读图 / Reading PDF images

## 中文说明

1. 在「设置 → AI」填写当前服务商的 API Key，选择支持视觉的模型并保存。「图片输入」默认自动识别能力；Kimi、GLM 可通过自定义服务商的官方地址预设配置。
2. 在 PDF 工具栏选择「框选图表问 AI」，拖出需要讨论的区域；也可点「发送当前页给 AI」。两者都会先加入阅读伙伴的草稿，尚未调用模型。
3. 预览或移除图片，填写问题后发送。点图片下方的来源可回到相应 PDF 页；已发送图片可在对话记录中预览。

Pairleaf 0.9.0 适配 DeepSeek、OpenAI/GPT、Anthropic/Claude、Kimi、GLM 五类接口，**并非每个型号都支持图片**。例如 DeepSeek 可用 `deepseek-flash`，Kimi 可用 `kimi-k3`；GLM 需选择 `glm-5v-turbo`、`glm-4.6v` 等视觉型号，普通文本型号不适用。请同时核对当前账号与接口的官方说明。

未知的兼容接口默认不发送图片。确认服务商和具体模型支持图片后，可在「图片输入」选择「兼容接口：我已确认支持图片」并保存；此设置不会让不支持视觉的模型获得读图能力。应用沿用当前模型、接口和 Key，不会暗中改用另一服务商。

图像仅来自你选择的页或框选区域，不会自动把整篇 PDF 转成图片上传。点击发送后，图片与问题一并交给当前 API 服务商并计入用量；相关追问可能重发近期已附图片，也会计费。每轮最多 4 张，单张 4 MiB、合计 8 MiB，最长边 2048 像素。

对话图片保存在本地并包含在论文库备份中。**含图备份需要 Pairleaf 0.9.0 或更新版本恢复**；0.9.0 仍可恢复旧版无图备份。备份不含 API Key。

## English guide

1. In **Settings → AI**, enter your provider's API key, select a vision-capable model and save. **Image input** detects support by default. Kimi and GLM official endpoints are available through the custom-provider presets.
2. Choose **Select a figure for AI** in the PDF toolbar and drag around the region, or choose **Send current page to AI**. Both add an image to the companion's draft without calling the model yet.
3. Preview or remove the image, add your question and send. Its source button returns to the PDF page; sent images remain available for preview in the conversation.

Pairleaf 0.9.0 adapts DeepSeek, OpenAI/GPT, Anthropic/Claude, Kimi and GLM interfaces, **not every model offered by these providers**. Examples include DeepSeek `deepseek-flash` and Kimi `kimi-k3`. GLM requires a vision model such as `glm-5v-turbo` or `glm-4.6v`, rather than a text-only model. Check your account's model access and the provider's current documentation.

Unknown compatible endpoints cannot receive images by default. After confirming that your endpoint and model support images, choose **Compatible endpoint: I have confirmed image support** under **Image input** and save. This does not add vision capabilities to a text-only model. Pairleaf keeps your selected model, endpoint and key; it does not silently switch providers.

Images come only from pages or regions you select; Pairleaf does not automatically render and upload the whole PDF as images. Sending a question sends its images to your selected API provider and incurs usage charges. Relevant follow-ups may resend recently attached images and incur further charges. Limits per turn: 4 images, 4 MiB each, 8 MiB total, with a maximum edge of 2048 pixels.

Conversation images are stored locally and included in library backups. **Image-bearing backups require Pairleaf 0.9.0 or later to restore**; 0.9.0 still restores older backups without images. API keys are excluded from backups.

## 官方文档 / Official documentation

| Provider | Image input documentation |
| --- | --- |
| DeepSeek | [Vision](https://api-docs.deepseek.com/guides/vision/) |
| OpenAI / GPT | [Images and vision](https://developers.openai.com/api/docs/guides/images-vision) |
| Anthropic / Claude | [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) |
| Kimi | [Kimi vision models](https://platform.kimi.ai/docs/guide/use-kimi-vision-model) |
| GLM | [GLM-5V-Turbo](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5v-turbo) |
