# Phuket Switch v1.0.0 · 2026-11-23

首个正式版，面向 Windows x64。Phuket Switch 将 [PhuketAI](https://ai.pukitcore.com) 的账号、供应商、客户端配置与本地代理整合到一个桌面工作台。

## 本版内容

- **六类客户端**：管理 Claude Code、Codex、Claude Desktop、Gemini CLI、Antigravity 和 Grok / 国产（GPT 原生）供应商；支持配置预览、切换和连通性诊断。
- **本地代理与模型路由**：支持按客户端接管、故障转移、按模型路由、Anthropic Messages 与 OpenAI Responses 的 JSON / SSE 转换，以及 Gemini 原生转发。支持标准、Fast、UltraFast 预设与 Codex 模型目录同步。
- **PhuketAI 工作台**：支持账号登录、双重认证、分组和密钥管理、余额与用量、充值订单和兑换、渠道监控及模型测速。
- **自定义模型子代理**：内置 Astra MCP 服务 **v1.4.0**；支持四种模型协议、只读与编辑模式、并行任务和会话恢复。九种 Harness 可按需部署。支持模型主动分块压缩、保留最近交互及自动全量压缩。
- **扩展与恢复**：管理 MCP 服务、系统提示词和本地 Skills；为 Codex / Claude 配置生图提示词。可预览脱敏差异、恢复配置备份，并从 CC-Switch 只读导入供应商。
- **桌面与升级**：支持托盘操作与浅色 / 深色主题。从本版开始，安装版可通过 GitHub Releases 检查、下载并在退出时安装更新，也可确认后立即重启安装。便携版提示新版下载地址，不覆盖运行中的程序。启动检查可关闭。
- **已有配置**：保留 Windows 应用标识；首次打开时自动迁移官方旧端点，保留路径、自定义供应商及其他偏好设置。

## 下载

在本页 Assets 中选择 **`Phuket.Switch.Setup.1.0.0.exe`**（安装版，推荐）或 **`Phuket.Switch.1.0.0.exe`**（便携版）。`latest.yml` 与 `.blockmap` 供更新器使用，无需手动打开。两个版本均未进行 Windows 代码签名，请只从[官方发布页](https://github.com/qazplm1208-tech/phuket-switch/releases)下载。使用子代理需另备 Python 3.10 或更高版本。
